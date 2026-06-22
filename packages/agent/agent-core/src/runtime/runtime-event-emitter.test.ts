import { describe, expect, it } from "vitest";

import { AsyncPushQueue } from "./async-push-queue.ts";
import { createRuntimeEventEmitter } from "./runtime-event-emitter.ts";
import type { RuntimeStreamEvent } from "./stream-events.ts";

describe("RuntimeEventEmitter", () => {
  it("adds stream metadata and monotonically increasing sequence numbers", async () => {
    const queue = new AsyncPushQueue<RuntimeStreamEvent>();
    const emitter = createRuntimeEventEmitter(queue);

    emitter.emit(createEvent("run-1", "run.started"));
    emitter.emit(createEvent("run-1", "message.delta"));
    emitter.emit(createEvent("run-1", "run.completed"));
    emitter.complete();

    const events: RuntimeStreamEvent[] = [];
    for await (const event of queue) {
      events.push(event);
    }

    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(events.map((event) => event.schemaVersion)).toEqual([
      "expertmesh.stream/v1",
      "expertmesh.stream/v1",
      "expertmesh.stream/v1",
    ]);
    expect(events.every((event) => event.eventId.length > 0)).toBe(true);
  });
});

function createEvent(
  runId: string,
  type: "run.started" | "message.delta" | "run.completed",
): Parameters<ReturnType<typeof createRuntimeEventEmitter>["emit"]>[0] {
  const base = {
    runId,
    source: {
      kind: "agent" as const,
      runId,
      path: [],
    },
  };

  if (type === "run.started") {
    return {
      ...base,
      type,
      payload: {
        task: "task",
      },
    };
  }

  if (type === "message.delta") {
    return {
      ...base,
      type,
      payload: {
        role: "assistant",
        contentType: "text",
        delta: "hello",
      },
    };
  }

  return {
    ...base,
    type,
    payload: {},
  };
}
