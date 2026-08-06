import { describe, expect, it } from "vitest";

import { trimUtf8ToByteLimit } from "../src/storage/utf8.ts";

describe("trimUtf8ToByteLimit", () => {
  it("keeps the rendered value within the byte budget for multibyte content", () => {
    const trimmed = trimUtf8ToByteLimit("记忆".repeat(4_096), 4_096);

    expect(Buffer.byteLength(trimmed)).toBeLessThanOrEqual(4_096);
    expect(trimmed.endsWith("\n…")).toBe(true);
  });

  it("does not exceed budgets smaller than the truncation marker", () => {
    expect(trimUtf8ToByteLimit("记忆", 1)).toBe("");
    expect(trimUtf8ToByteLimit("abcd", 2)).toBe("ab");
  });
});
