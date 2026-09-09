import { describe, expect, it } from "vitest";

import { paginateManagementItems } from "./management-pagination.ts";

describe("management pagination", () => {
  it("returns stable pages and rejects a cursor after the source changes", () => {
    const first = paginateManagementItems({
      items: ["a", "b", "c"],
      scope: "resources",
      fingerprintValue: ["a", "b", "c"],
      filters: { query: undefined },
      limit: 2,
    });

    expect(first.items).toEqual(["a", "b"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(
      paginateManagementItems({
        items: ["a", "b", "c"],
        scope: "resources",
        fingerprintValue: ["a", "b", "c"],
        filters: { query: undefined },
        cursor: first.nextCursor,
        limit: 2,
      }),
    ).toEqual({ items: ["c"] });

    expect(() =>
      paginateManagementItems({
        items: ["a", "b", "changed"],
        scope: "resources",
        fingerprintValue: ["a", "b", "changed"],
        filters: { query: undefined },
        cursor: first.nextCursor,
        limit: 2,
      }),
    ).toThrow("cursor_expired");
  });

  it("rejects cursors reused for a different scope or filter", () => {
    const page = paginateManagementItems({
      items: [1, 2],
      scope: "missions",
      fingerprintValue: [1, 2],
      filters: { status: "running" },
      limit: 1,
    });

    for (const input of [
      { scope: "automations", filters: { status: "running" } },
      { scope: "missions", filters: { status: "failed" } },
    ]) {
      expect(() =>
        paginateManagementItems({
          items: [1, 2],
          scope: input.scope,
          fingerprintValue: [1, 2],
          filters: input.filters,
          cursor: page.nextCursor,
          limit: 1,
        }),
      ).toThrow("cursor_invalid");
    }
  });
});
