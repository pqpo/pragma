import { describe, expect, it } from "vitest";

import {
  formatExpertMentionToken,
  parseExpertMentionSegments,
  serializeExpertMentionSegments,
} from "../src/expert-mention.ts";

describe("Expert mention tokens", () => {
  it("round-trips text and multiple canonical mentions", () => {
    const value =
      "Ask <@expert:1xddvess309a6gme> to test, then <@expert:3sfd30h5017wd17d> to review.";
    expect(serializeExpertMentionSegments(parseExpertMentionSegments(value))).toBe(value);
  });

  it("preserves malformed and non-canonical tokens as text", () => {
    const value = "Keep <@expert:INVALID> and @reviewer unchanged.";
    expect(parseExpertMentionSegments(value)).toEqual([{ kind: "text", text: value }]);
  });

  it("rejects non-canonical Expert references", () => {
    expect(() => formatExpertMentionToken("expert:INVALID")).toThrow();
  });
});
