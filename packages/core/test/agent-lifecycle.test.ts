import { describe, expect, it } from "vitest";

import { createQueuedAgentLifecycle } from "../src/runtime/agent-lifecycle.ts";

describe("queued Agent lifecycle", () => {
  it("cancels an exact queued task without aborting the active task", async () => {
    const lifecycle = createQueuedAgentLifecycle(undefined);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = false;

    const first = lifecycle.enqueue(async () => {
      await firstGate;
      return "first";
    });
    const second = lifecycle.enqueue(async () => {
      secondStarted = true;
      return "second";
    });

    await second.cancel();
    releaseFirst();

    await expect(first.result).resolves.toBe("first");
    await expect(second.result).rejects.toThrow("cancelled before it started");
    expect(secondStarted).toBe(false);
    await lifecycle.close();
  });
});
