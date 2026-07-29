import { describe, expect, it, vi } from "vitest";

import { createRuntimeTokenCounter } from "../src/runtime/token-counter.ts";

describe("runtime token counter", () => {
  it("provides one deterministic Unicode-aware fallback before the tokenizer loads", () => {
    const counter = createRuntimeTokenCounter();
    expect(counter.countText("").tokens).toBe(0);
    expect(counter.countText("abcdefgh").tokens).toBe(2);
    expect(counter.countText("上下文").tokens).toBe(3);
    expect(counter.countText("test上下文").tokens).toBe(4);
    expect(counter.countText("😀").tokens).toBe(2);
    counter.dispose();
  });

  it("atomically upgrades existing callers to the shared local tokenizer", async () => {
    const listener = vi.fn();
    const counter = createRuntimeTokenCounter();
    counter.subscribe(listener);

    expect(counter.countText("abcdefgh")).toEqual({
      tokens: 2,
      source: "heuristic",
    });

    await expect(counter.load()).resolves.toBe(true);

    expect(counter.countText("abcdefgh")).toEqual({
      tokens: 1,
      source: "tokenizer",
    });
    expect(listener).toHaveBeenCalledOnce();
    counter.dispose();
  });

  it("deduplicates concurrent local tokenizer loads", async () => {
    const counter = createRuntimeTokenCounter();
    const first = counter.load();
    const second = counter.load();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(counter.countText("hello world")).toMatchObject({
      tokens: 2,
      source: "tokenizer",
    });
    counter.dispose();
  });
});
