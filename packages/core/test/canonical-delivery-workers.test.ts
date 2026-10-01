import { describe, expect, it } from "vitest";
import { CanonicalDeliveryWorkers } from "../src/execution/canonical-delivery-workers.ts";

describe("canonical delivery worker retirement", () => {
  it("drains a successor requested between the last delivery and Promise finalization", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let late!: Promise<unknown>;
    let calls = 0;
    const workers = new CanonicalDeliveryWorkers(async () => {
      calls += 1;
      if (calls === 1) {
        // First microtask precedes the await continuation, second follows it
        // but precedes the Promise.finally cleanup used by the old scheduler.
        queueMicrotask(() =>
          queueMicrotask(() => {
            late = workers.request("execution");
          }),
        );
      } else await gate;
      return { recovered: 1 };
    });
    await expect(workers.request("execution")).resolves.toEqual({ recovered: 1 });
    expect(late).toBeDefined();
    let drained = false;
    const drain = workers.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await Promise.all([late, drain]);
    expect(calls).toBe(2);
    expect(drained).toBe(true);
  });
});
