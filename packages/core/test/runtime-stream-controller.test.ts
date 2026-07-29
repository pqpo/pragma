import { describe, expect, it } from "vitest";

import {
  AsyncPushQueue,
  createLoggerProvider,
  createRuntimeStreamController,
  type Expert,
  type RuntimeStreamEvent,
} from "../src/index.ts";

describe("Runtime stream telemetry", () => {
  it("keeps context estimates independent from full reported turn usage", async () => {
    const { controller, queue } = createFixture();

    controller.beginUsagePreview({
      prompt: "1234",
      startupMessages: ["1234"],
      sessionSeed: "12345678",
      contextWindow: {
        usedTokens: 1_000,
        contextWindowTokens: 100_000,
        percent: 1,
        measurement: "reported",
        observedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    controller.writer.write({
      runId: "run-1",
      source: controller.source,
      type: "message.delta",
      payload: { contentType: "text", delta: "12345678" },
    });
    controller.writer.writeNative(50_000);
    controller.flushTelemetry(false);
    await controller.complete();

    const events: RuntimeStreamEvent[] = [];
    for await (const event of queue) events.push(event);
    const contextUpdates = events.filter((event) => event.type === "context-window.updated");
    const last = contextUpdates.at(-1);

    expect(last?.payload.usage).toMatchObject({
      usedTokens: 1_005,
      measurement: "estimated",
    });
    expect(
      events.findLast((event) => event.type === "usage.updated")?.payload.usage.totalTokens,
    ).toBe(50_000);
  });

  it("includes the session prompt seed only for an empty context", async () => {
    const { controller, queue } = createFixture();
    controller.beginUsagePreview({
      prompt: "1234",
      startupMessages: ["1234"],
      sessionSeed: "12345678",
      contextWindow: {
        usedTokens: 0,
        contextWindowTokens: 100_000,
        percent: 0,
        measurement: "estimated",
        observedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    controller.writer.write({
      runId: "run-1",
      source: controller.source,
      type: "message.delta",
      payload: { contentType: "text", delta: "12345678" },
    });
    controller.flushTelemetry(false);
    await controller.complete();

    const events: RuntimeStreamEvent[] = [];
    for await (const event of queue) events.push(event);

    expect(
      events.findLast((event) => event.type === "context-window.updated")?.payload.usage,
    ).toMatchObject({ usedTokens: 7, measurement: "estimated" });
  });
});

function createFixture() {
  const queue = new AsyncPushQueue<RuntimeStreamEvent>();
  const controller = createRuntimeStreamController<number>({
    agent: {
      id: "telemetry-expert",
      hooks: undefined,
    } as unknown as Expert,
    queue,
    runId: "run-1",
    session: () => ({
      systemSessionId: "session-1",
      runtimeSession: { type: "test", id: "native-1" },
      agentId: "telemetry-expert",
      runtime: { id: "test", kind: "test", displayName: "Test" },
      sessionState: "active",
      runState: "running",
    }),
    logger: createLoggerProvider({
      minimumLevel: "silent",
      handler: { write: () => undefined },
    }).createLogger({ component: "test" }),
    mapEvent: (usage) => ({
      usage: {
        measurement: "reported",
        input: usage,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: usage,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
    }),
  });
  return { controller, queue };
}
