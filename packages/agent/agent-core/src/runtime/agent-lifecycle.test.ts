import { describe, expect, it } from "vitest";

import { createQueuedAgentLifecycle } from "./agent-lifecycle.ts";

describe("createQueuedAgentLifecycle", () => {
  it("keeps session context stable and serializes submitted work", async () => {
    const context = { source: "test" };
    const lifecycle = createQueuedAgentLifecycle(context);
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = lifecycle.enqueue(async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first:end");
      return 1;
    });

    const second = lifecycle.enqueue(async () => {
      events.push("second:start");
      return 2;
    });

    await Promise.resolve();

    expect(lifecycle.currentContext).toBe(context);
    expect(lifecycle.state).toBe("running");
    expect(events).toEqual(["first:start"]);

    releaseFirst?.();

    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    expect(lifecycle.state).toBe("prepared");
  });

  it("cleans up and rejects queued work after abort", async () => {
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const lifecycle = createQueuedAgentLifecycle(undefined, {
      cleanup: () => {
        events.push("cleanup");
      },
    });

    const first = lifecycle.enqueue(async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });

    const second = lifecycle.enqueue(async () => {
      events.push("second:start");
    });

    await Promise.resolve();
    await lifecycle.abort();
    releaseFirst?.();

    await expect(first).rejects.toThrow("Agent session was aborted.");
    await expect(second).rejects.toThrow("Agent session was aborted.");
    expect(events).toEqual(["first:start", "cleanup"]);
    expect(lifecycle.state).toBe("aborted");
  });
});
