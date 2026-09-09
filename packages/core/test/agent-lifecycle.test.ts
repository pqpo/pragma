import { describe, expect, it, vi } from "vitest";

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

  it("runs cleanup and closes even when the native abort hook fails", async () => {
    const cleanup = vi.fn();
    const lifecycle = createQueuedAgentLifecycle(undefined, {
      abort: () => {
        throw new Error("native abort failed");
      },
      cleanup,
      forceCleanupTimeoutMs: 1,
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const task = lifecycle.enqueue(async ({ signal }) => {
      markStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    void task.result.catch(() => undefined);
    await started;

    await expect(lifecycle.close()).rejects.toThrow("native abort failed");

    expect(cleanup).toHaveBeenCalledOnce();
    expect(lifecycle.sessionState).toBe("closed");
  });

  it("reports that cleanup could not prove a non-cooperative task quiescent", async () => {
    const cleanup = vi.fn();
    const lifecycle = createQueuedAgentLifecycle(undefined, {
      cleanup,
      forceCleanupTimeoutMs: 1,
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const task = lifecycle.enqueue(async () => {
      markStarted();
      await new Promise<void>(() => undefined);
    });
    void task.result.catch(() => undefined);
    await started;

    await expect(lifecycle.close()).rejects.toMatchObject({
      name: "AgentLifecycleQuiescenceError",
    });

    expect(cleanup).toHaveBeenCalledOnce();
    expect(lifecycle.sessionState).toBe("closed");
  });
});
