import { describe, expect, it } from "vitest";

import {
  InMemoryRunEventStore,
  createRuntimeEventDispatcher,
} from "./event-dispatcher.ts";
import type { RuntimeStreamEvent } from "./stream-events.ts";

describe("RuntimeEventDispatcher", () => {
  it("stores and delivers events serially under async sink backpressure", async () => {
    const store = new InMemoryRunEventStore();
    const delivered: number[] = [];
    const dispatcher = createRuntimeEventDispatcher({
      store,
      sink: async (event) => {
        await Promise.resolve();
        delivered.push(event.sequence);
      },
    });

    dispatcher.dispatch(createEvent("run-1", "run.started"));
    dispatcher.dispatch(createEvent("run-1", "message.delta"));
    await dispatcher.emit(createEvent("run-1", "run.completed"));
    await dispatcher.drain();

    expect(delivered).toEqual([0, 1, 2]);
    expect((await store.list("run-1")).map((event) => event.sequence)).toEqual([0, 1, 2]);
  });

  it("captures sink errors without breaking the event queue", async () => {
    const delivered: string[] = [];
    const dispatcher = createRuntimeEventDispatcher({
      sink: async (event) => {
        if (event.sequence === 0) {
          throw new Error("sink failed");
        }

        delivered.push(event.type);
      },
    });

    dispatcher.dispatch(createEvent("run-1", "run.started"));
    dispatcher.dispatch(createEvent("run-1", "run.completed"));
    await dispatcher.drain();

    expect(dispatcher.errors()).toHaveLength(1);
    expect(delivered).toEqual(["run.completed"]);
  });
});

function createEvent(
  runId: string,
  type: "run.started" | "message.delta" | "run.completed",
): Omit<RuntimeStreamEvent, "sequence"> {
  const base = {
    schemaVersion: "expertmesh.stream/v1" as const,
    eventId: `${type}-event`,
    runId,
    emittedAt: new Date(0).toISOString(),
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
