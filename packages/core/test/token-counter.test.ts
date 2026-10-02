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

  it.each(["x", "。", "上", "😀", " ", "\t", "\n", "\u3000"])(
    "uses the shared heuristic for an oversized unbroken %s run after warm-up",
    async (character) => {
      const text = character.repeat(200_001);
      const cold = createRuntimeTokenCounter();
      const expected = cold.countText(text);
      cold.dispose();
      const warm = createRuntimeTokenCounter();
      await expect(warm.load()).resolves.toBe(true);
      expect(warm.countText(text)).toEqual(expected);
      expect(warm.countText("hello world")).toEqual({ tokens: 2, source: "tokenizer" });
      warm.dispose();
    },
  );

  it("keeps long ordinary text on the tokenizer and treats Unicode whitespace as a boundary", async () => {
    const { countTokens } = await import("gpt-tokenizer/encoding/o200k_base");
    const counter = createRuntimeTokenCounter();
    await counter.load();
    const text = "Ordinary text with short words and Unicode whitespace.\u3000".repeat(2500);
    expect(counter.countText(text)).toEqual({ tokens: countTokens(text), source: "tokenizer" });
    expect(counter.countText("x".repeat(4096)).source).toBe("tokenizer");
    expect(counter.countText("x".repeat(4097))).toEqual({ tokens: 1025, source: "heuristic" });
    counter.dispose();
  });
});
