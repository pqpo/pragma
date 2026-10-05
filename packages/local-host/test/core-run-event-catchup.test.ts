import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getExecutionLiveBus, StoredExecutionView } from "@pragma/core";
import { ExecutionRecordSchema, InvocationSchema } from "@pragma/shared";
import { expect, it, vi } from "vitest";
import { createSqliteExecutionStore } from "../src/execution/sqlite-execution-store.ts";
import { createLocalHostRunHandleState } from "../src/core-run.ts";
import type { LocalHostRunEvent } from "../src/index.ts";

it.each([false, true])(
  "preserves live output during paged Human catch-up without replaying answered requests (pending=%s)",
  async (hasPending) => {
    const home = await mkdtemp(join(tmpdir(), "pragma-run-catchup-"));
    const store = createSqliteExecutionStore({ pragmaHome: home });
    try {
      const fixture = JSON.parse(
        await readFile(new URL("./fixtures/execution-file-v12.json", import.meta.url), "utf8"),
      ) as { execution: unknown; invocations: unknown[] };
      const record = ExecutionRecordSchema.parse(fixture.execution);
      record.executionId = randomUUID();
      const answeredId = randomUUID();
      const pendingId = randomUUID();
      await store.create(
        { ...record, version: 0, lastAppliedSequence: 0 },
        InvocationSchema.parse(fixture.invocations[0]),
      );
      const request = {
        kind: "approval",
        title: "Approval",
        prompt: "Approve this operation?",
        approveOption: "approve",
      };
      await store.commit({
        executionId: record.executionId,
        commitId: "historical-output",
        events: Array.from({ length: 220 }, (_, index) => ({
          invocationId: record.rootInvocationId,
          type: "runtime.message.delta",
          data: { text: `historical ${index}` },
        })),
      });
      const readEvents = store.readEvents.bind(store);
      let injected = false;
      const reads = vi.spyOn(store, "readEvents").mockImplementation(async (id, after, limit) => {
        if (!injected) {
          injected = true;
          // Real SQLite commit publishes to the real Core subscription while
          // the Host is still reconstructing durable Human requests.
          await store.commit({
            executionId: id,
            commitId: "live-during-catchup",
            events: [
              {
                eventId: "live-output",
                invocationId: record.rootInvocationId,
                type: "runtime.message.delta",
                data: { text: "visible live output" },
              },
              {
                eventId: "answered-request",
                invocationId: record.rootInvocationId,
                type: "human.requested",
                data: { interactionId: answeredId, request },
              },
              {
                eventId: "answered-response",
                invocationId: record.rootInvocationId,
                type: "human.responded",
                data: {
                  interactionId: answeredId,
                  response: { kind: "tool_approval", approved: true },
                },
              },
              ...(hasPending
                ? [
                    {
                      eventId: "pending-request",
                      invocationId: record.rootInvocationId,
                      type: "human.requested",
                      data: { interactionId: pendingId, request },
                    },
                  ]
                : []),
            ],
          });
          getExecutionLiveBus(store).complete(id);
        }
        return await readEvents(id, after, limit);
      });
      let finish!: (value: unknown) => void;
      const result = new Promise<unknown>((resolve) => {
        finish = resolve;
      });
      const view = new StoredExecutionView(record.executionId, store);
      const received: LocalHostRunEvent[] = [];
      const state = createLocalHostRunHandleState({
        coreHandle: Object.assign(view, {
          result,
          cancel: async () => undefined,
          stopForDeletion: async () => undefined,
          respondToHumanInteraction: async () => undefined,
          checkpointWaitingHuman: async () => undefined,
        }),
        executions: store,
        missionId: randomUUID(),
        release: async () => undefined,
        onEvent: (event) => received.push(event),
      });
      await state.pump;
      await Array.fromAsync(state.handle.events!);
      finish("done");
      await state.handle.result;
      expect(received.map((event) => ({ eventId: event.eventId, type: event.type }))).toEqual(
        expect.arrayContaining([expect.objectContaining({ eventId: "live-output" })]),
      );
      expect(received.filter((event) => event.type === "runtime.message.delta")).toHaveLength(1);
      expect(received.some((event) => event.eventId?.startsWith("answered-"))).toBe(false);
      expect(received.filter((event) => event.type === "human.interaction.requested")).toHaveLength(
        hasPending ? 1 : 0,
      );
      expect(reads).toHaveBeenCalledTimes(2);
      expect(reads.mock.calls.every((call) => call[2] === 200)).toBe(true);
    } finally {
      await store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.each(["completed", "waiting"] as const)(
  "fails the result and event stream promptly when durable Human catch-up fails (Native=%s)",
  async (native) => {
    const home = await mkdtemp(join(tmpdir(), "pragma-run-catchup-error-"));
    const store = createSqliteExecutionStore({ pragmaHome: home });
    try {
      const fixture = JSON.parse(
        await readFile(new URL("./fixtures/execution-file-v12.json", import.meta.url), "utf8"),
      ) as { execution: unknown; invocations: unknown[] };
      const record = ExecutionRecordSchema.parse(fixture.execution);
      const invocation = InvocationSchema.parse(fixture.invocations[0]);
      if (native === "waiting") {
        record.status = "waiting";
        invocation.status = "waiting";
        invocation.waitReason = "human_input";
      }
      await store.create(record, invocation);
      vi.spyOn(store, "readEvents").mockRejectedValueOnce(new Error("durable history read failed"));
      const subscriptionClose = vi.fn();
      const view = new StoredExecutionView(record.executionId, store);
      const subscribe = view.subscribeEvents.bind(view);
      vi.spyOn(view, "subscribeEvents").mockImplementation(async (options) => {
        const subscription = await subscribe(options);
        return {
          [Symbol.asyncIterator]: () => subscription[Symbol.asyncIterator](),
          close: async () => {
            subscriptionClose();
            await subscription.close();
          },
        };
      });
      const state = createLocalHostRunHandleState({
        coreHandle: Object.assign(view, {
          result: native === "completed" ? Promise.resolve("done") : new Promise(() => undefined),
          cancel: async () => undefined,
          stopForDeletion: async () => undefined,
          respondToHumanInteraction: async () => undefined,
          checkpointWaitingHuman: async () => undefined,
        }),
        executions: store,
        missionId: randomUUID(),
        release: async () => undefined,
      });
      const outcome = expect(
        Promise.race([
          state.handle.result,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("result remained pending")), 250),
          ),
        ]),
      ).rejects.toThrow("durable history read failed");
      await outcome;
      await expect(state.pump).rejects.toThrow("durable history read failed");
      await expect(Array.fromAsync(state.handle.events!)).rejects.toThrow(
        "durable history read failed",
      );
      expect(subscriptionClose).toHaveBeenCalledOnce();
    } finally {
      await store.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
