import { describe, expect, it } from "vitest";
import { createMemoryAttentionRequestLimiter } from "../src/memory-attention-request-limiter.ts";

describe("Memory Attention request admission", () => {
  it("reserves slots for queued callers and cancels a waiter without waiting for active requests", async () => {
    const limit = createMemoryAttentionRequestLimiter();
    const signal = new AbortController().signal;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let peak = 0;
    const operation = async () => {
      active++;
      peak = Math.max(peak, active);
      await blocked;
      active--;
    };
    const first = limit(signal, operation);
    const second = limit(signal, operation);
    const abort = new AbortController();
    const cancelled = limit(abort.signal, operation);
    const rejected = expect(cancelled).rejects.toThrow("cancel waiter");
    abort.abort(new Error("cancel waiter"));
    await rejected;
    const queued = limit(signal, operation);
    release();
    const newcomers = Array.from({ length: 20 }, () => limit(signal, operation));
    await Promise.all([first, second, queued, ...newcomers]);
    expect(peak).toBe(2);
  });
});
