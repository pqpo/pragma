import { describe, expect, it, vi } from "vitest";

import {
  AsyncPushQueue,
  createLoggerProvider,
  createRuntimeStreamController,
  type Expert,
  type RuntimeStreamEvent,
  type RuntimeTokenCounter,
} from "../src/index.ts";

describe("Runtime stream telemetry", () => {
  it("does no tokenization for 10,000 deltas and memoizes terminal fallback", async () => {
    const countText = vi.fn(() => ({ tokens: 5 }));
    const { controller, queue } = createFixture({ countText } as unknown as RuntimeTokenCounter);
    controller.beginUsageCapture({ prompt: "hello" });
    for (let index = 0; index < 10_000; index++) {
      controller.writer.write({
        runId: "run-1",
        source: controller.source,
        type: "message.delta",
        payload: { contentType: "text", delta: "x" },
      });
    }
    expect(countText).not.toHaveBeenCalled();
    expect(controller.getUsage()?.measurement).toBe("estimated");
    controller.getUsage();
    expect(countText).toHaveBeenCalledTimes(2);
    await controller.complete();
    const events: RuntimeStreamEvent[] = [];
    for await (const event of queue) events.push(event);
    expect(events.filter((event) => event.type === "usage.updated")).toHaveLength(1);
    expect(events.filter((event) => event.type === "context-window.updated")).toEqual([]);
  });

  it("publishes reported usage once without tokenization or live context estimates", async () => {
    const countText = vi.fn(() => {
      throw new Error("unexpected estimate");
    });
    const { controller, queue } = createFixture({ countText } as unknown as RuntimeTokenCounter);
    controller.beginUsageCapture({ prompt: "hello" });
    controller.writer.writeNative(123);
    expect(controller.getUsage()?.totalTokens).toBe(123);
    await controller.complete();
    expect(countText).not.toHaveBeenCalled();
    const events: RuntimeStreamEvent[] = [];
    for await (const event of queue) events.push(event);
    expect(events.filter((event) => event.type === "usage.updated")).toHaveLength(1);
    expect(events.find((event) => event.type === "usage.updated")?.payload.usage.totalTokens).toBe(
      123,
    );
    expect(events.filter((event) => event.type === "context-window.updated")).toEqual([]);
  });
});

function createFixture(tokenCounter?: RuntimeTokenCounter) {
  const queue = new AsyncPushQueue<RuntimeStreamEvent>();
  const controller = createRuntimeStreamController<number>({
    agent: {
      id: "telemetry-expert",
      hooks: undefined,
    } as unknown as Expert,
    queue,
    tokenCounter,
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
