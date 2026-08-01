import { describe, expect, it } from "vitest";

import {
  PRAGMA_TEXT_LIMITS,
  pragmaKnowledgeBaseEntryNameIssue,
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
    expect(PRAGMA_TEXT_LIMITS.automation).toMatchObject({
      promptAuthoring: 5_000,
      prompt: 100_000,
    });
    expect(PRAGMA_TEXT_LIMITS.contextStore).toMatchObject({ entryName: 100 });
  });

  it("counts and truncates Unicode code points instead of UTF-16 code units", () => {
    expect(pragmaUnicodeLength("知识😀库")).toBe(4);
    expect(truncatePragmaUnicode("知识😀库", 3)).toBe("知识😀");
    expect(truncatePragmaTrimmedUnicode("  知识😀库  ", 3)).toBe("  知识😀  ");
  });

  it("validates portable knowledge-base entry names without excluding Chinese", () => {
    expect(pragmaKnowledgeBaseEntryNameIssue("产品说明-v2（草稿）")).toBeUndefined();
    expect(pragmaKnowledgeBaseEntryNameIssue("two words")).toBe("whitespace");
    expect(pragmaKnowledgeBaseEntryNameIssue("parent/child")).toBe("invalid_character");
    expect(pragmaKnowledgeBaseEntryNameIssue("parent\\child")).toBe("invalid_character");
    expect(pragmaKnowledgeBaseEntryNameIssue("CON")).toBe("reserved_name");
    expect(pragmaKnowledgeBaseEntryNameIssue(".hidden")).toBe("dot_name");
    expect(pragmaKnowledgeBaseEntryNameIssue("知".repeat(101))).toBe("too_long");
  });
});
