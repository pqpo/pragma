import { createSqliteExecutionStore as createTestExecutionStore } from "../../src/index.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getExecutionLiveBus } from "@pragma/core";
import { ExecutionEventSchema, ExecutionRecordSchema } from "@pragma/shared";
import { expect, it, vi } from "vitest";

import { observeMissionQueuedTurn } from "../../src/missions/mission-queued-turn-observer.ts";

function fixture() {
  const store = createTestExecutionStore({
    pragmaHome: join(tmpdir(), `queued-observer-${crypto.randomUUID()}`),
  });
  const bus = getExecutionLiveBus(store);
  const state = ExecutionRecordSchema.parse({
    schemaVersion: "pragma.execution/v12",
    executionId: "execution",
    version: 0,
    kind: "flow",
    definition: { id: "flow", kind: "flow" },
    rootInvocationId: "execution",
    status: "queued",
    input: null,
    lastAppliedSequence: 0,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
  });
  const close = vi.fn(async () => undefined);
  const execution = {
    subscribeEvents: vi.fn(async () => {
      const subscription = bus.subscribeEvents("execution");
      return {
        ...subscription,
        close: async () => {
          await close();
          await subscription.close();
        },
      };
    }),
    getState: vi.fn(async () => state),
  };
  const publishEvent = (type: string): void =>
    bus.publishEvent(
      "execution",
      ExecutionEventSchema.parse({
        schemaVersion: "pragma.execution-event/v5",
        eventId: type,
        cursor: { executionId: "execution", sequence: 0 },
        executionId: "execution",
        invocationId: "execution",
        type,
        data: {},
        occurredAt: state.createdAt,
      }),
    );
  return {
    execution,
    state,
    close,
    start: () => publishEvent("execution.started"),
    publishEvent,
    bus,
  };
}

it("receives a queued start that races with the initial state read", async () => {
  const f = fixture();
  f.execution.getState.mockImplementationOnce(async () => {
    f.start();
    return f.state;
  });
  const started = vi.fn(async () => undefined);
  await observeMissionQueuedTurn(f.execution, started);
  expect(started).toHaveBeenCalledOnce();
  expect(f.close).toHaveBeenCalledOnce();
});

it("closes the replaced Session subscription and lets its replacement receive the start", async () => {
  const f = fixture();
  const controller = new AbortController();
  const previousStarted = vi.fn(async () => undefined);
  const previous = observeMissionQueuedTurn(f.execution, previousStarted, controller.signal);
  await vi.waitFor(() => expect(f.execution.getState).toHaveBeenCalledOnce());
  controller.abort();
  await previous;
  const replacement = {
    ...f.execution,
    subscribeEvents: async () => f.bus.subscribeEvents("execution"),
  };
  const nextStarted = vi.fn(async () => undefined);
  const next = observeMissionQueuedTurn(replacement, nextStarted);
  await vi.waitFor(() => expect(f.execution.getState).toHaveBeenCalledTimes(2));
  f.start();
  await next;
  expect(previousStarted).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalled();
  expect(nextStarted).toHaveBeenCalledOnce();
});

it("does not attach a cancelled queued turn", async () => {
  const f = fixture();
  f.state.status = "cancelled";
  f.bus.complete("execution");
  const started = vi.fn(async () => undefined);
  await observeMissionQueuedTurn(f.execution, started);
  expect(started).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalled();
});

it.each(["cancelled", "interrupted", "failed", "succeeded"])(
  "closes an already subscribed queued observer on execution.%s without completing the live bus",
  async (status) => {
    const f = fixture();
    const started = vi.fn(async () => undefined);
    const observing = observeMissionQueuedTurn(f.execution, started);
    await vi.waitFor(() => expect(f.execution.getState).toHaveBeenCalledOnce());
    f.publishEvent(`execution.${status}`);
    await observing;
    expect(started).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
    // A later start cannot reactivate the observer after its terminal event.
    f.start();
    expect(started).not.toHaveBeenCalled();
  },
);
