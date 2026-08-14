import { describe, expect, it, vi } from "vitest";

import { RuntimeResourceScope } from "../src/runtime/resource-scope.ts";

describe("RuntimeResourceScope", () => {
  it("releases resources once in reverse acquisition order", async () => {
    const order: string[] = [];
    const scope = new RuntimeResourceScope("test");
    await scope.acquire(
      "first",
      () => 1,
      () => {
        order.push("first");
      },
    );
    scope.adopt("second", 2, () => {
      order.push("second");
    });
    scope.seal();
    scope.transfer();

    const firstDisposal = scope.dispose();
    const secondDisposal = scope.dispose();
    expect(firstDisposal).toBe(secondDisposal);
    await firstDisposal;

    expect(order).toEqual(["second", "first"]);
    expect(scope.receipts()).toEqual([
      { label: "first", order: 0, state: "disposed" },
      { label: "second", order: 1, state: "disposed" },
    ]);
  });

  it("continues cleanup and aggregates disposer failures", async () => {
    const dispose = vi.fn();
    const scope = new RuntimeResourceScope("failures");
    scope.adopt("first", 1, () => {
      dispose("first");
      throw new Error("first failed");
    });
    scope.adopt("second", 2, () => {
      dispose("second");
      throw new Error("second failed");
    });

    await expect(scope.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(dispose.mock.calls).toEqual([["second"], ["first"]]);
  });

  it("cleans an acquisition that resolves while the scope is closing", async () => {
    const scope = new RuntimeResourceScope("acquisition-race");
    const dispose = vi.fn();
    let resolve!: (value: object) => void;
    const pending = scope.acquire(
      "late",
      async () =>
        await new Promise<object>((next) => {
          resolve = next;
        }),
      dispose,
    );

    await scope.dispose();
    resolve({});

    await expect(pending).rejects.toThrow("is closing");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects registration after sealing while retaining Core cleanup ownership", async () => {
    const dispose = vi.fn();
    const scope = new RuntimeResourceScope("sealed");
    scope.adopt("prepared", {}, dispose);
    scope.seal();

    expect(() => scope.adopt("late", {}, dispose)).toThrow("is sealed");
    await scope.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("requires seal before ownership transfer", () => {
    const scope = new RuntimeResourceScope("unsealed");
    expect(() => scope.transfer()).toThrow("must be sealed before transfer");
  });
});
