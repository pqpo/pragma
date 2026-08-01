import { describe, expect, it } from "vitest";

import {
  PRAGMA_TEXT_LIMITS,
  pragmaUnicodeLength,
  truncatePragmaTrimmedUnicode,
  truncatePragmaUnicode,
} from "../src/pragma-text-limits.ts";

describe("Pragma text limits", () => {
  it("keeps the public resource limits in one immutable table", () => {
    expect(PRAGMA_TEXT_LIMITS.expert).toEqual({
      name: 50,
      description: 500,
      tag: 20,
      tags: 10,
      scope: 1_000,
      instructions: 5_000,
    });
    expect(PRAGMA_TEXT_LIMITS.expertTeam).toMatchObject({ instructions: 5_000 });
    expect(PRAGMA_TEXT_LIMITS.flow).toMatchObject({ promptTextSegment: 5_000 });
    expect(PRAGMA_TEXT_LIMITS.automation).toMatchObject({ prompt: 100_000 });
  });

  it("counts and truncates Unicode code points instead of UTF-16 code units", () => {
    expect(pragmaUnicodeLength("知识😀库")).toBe(4);
    expect(truncatePragmaUnicode("知识😀库", 3)).toBe("知识😀");
    expect(truncatePragmaTrimmedUnicode("  知识😀库  ", 3)).toBe("  知识😀  ");
  });
});
