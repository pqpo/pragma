import { describe, expect, it } from "vitest";

import {
  decodeShortPageCursor,
  encodeShortPageAnchor,
  encodeShortPageCursor,
  findPageAnchorIndex,
  SHORT_PAGE_CURSOR_MAX_LENGTH,
} from "../src/pagination/short-page-cursor.ts";

describe("short page cursor", () => {
  const binding = {
    scope: "list_dsl_resources",
    filters: { query: "a".repeat(2_000) },
    fingerprint: { revision: 3 },
  };

  it("is fixed-length, URL safe, and stateless across calls", () => {
    const cursor = encodeShortPageCursor(binding, 123_456);
    expect(cursor).toMatch(/^p1\.[A-Za-z0-9_-]{40}$/u);
    expect(cursor.length).toBeLessThanOrEqual(SHORT_PAGE_CURSOR_MAX_LENGTH);
    expect(encodeShortPageCursor(binding, 123_456)).toBe(cursor);
    expect(decodeShortPageCursor(cursor, binding)).toBe(123_456);
  });

  it("distinguishes invalid bindings and expired sources", () => {
    const cursor = encodeShortPageCursor(binding, 2);
    expect(() => decodeShortPageCursor(cursor, { ...binding, scope: "list_missions" })).toThrow(
      "cursor_invalid",
    );
    expect(() =>
      decodeShortPageCursor(cursor, { ...binding, filters: { query: "other" } }),
    ).toThrow("cursor_invalid");
    expect(() =>
      decodeShortPageCursor(cursor, { ...binding, fingerprint: { revision: 4 } }),
    ).toThrow("cursor_expired");
    expect(() => decodeShortPageCursor(`${cursor}x`, binding)).toThrow("cursor_invalid");
    expect(() => decodeShortPageCursor("p1." + "a".repeat(4_096), binding)).toThrow(
      "cursor_invalid",
    );
  });

  it("uses a bounded keyset anchor while accepting an old raw ID", () => {
    const ids = ["first", "custom-" + "x".repeat(1_000), "last"];
    const cursor = encodeShortPageAnchor(ids[1]!);
    expect(cursor).toMatch(/^a1\.[A-Za-z0-9_-]{22}$/u);
    expect(cursor.length).toBeLessThanOrEqual(SHORT_PAGE_CURSOR_MAX_LENGTH);
    expect(findPageAnchorIndex(ids, cursor, (id) => id)).toBe(1);
    expect(findPageAnchorIndex(ids, ids[1], (id) => id)).toBe(1);
    expect(findPageAnchorIndex(ids, "missing", (id) => id)).toBe(-1);
  });
});
