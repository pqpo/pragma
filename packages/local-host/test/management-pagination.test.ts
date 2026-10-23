import { describe, expect, it } from "vitest";
import { encodeShortPageCursor } from "@pragma/core";
import { createHash } from "node:crypto";
import { paginateManagementItems } from "../src/management-pagination.ts";

describe("streamed management pagination", () => {
  it("consumes only a page and one lookahead result, including subsequent pages", () => {
    const consumed: number[] = [];
    function* items() {
      for (let index = 0; index < 10_000; index++) {
        if (index > 4) throw new Error("Read beyond the requested page");
        consumed.push(index);
        yield index;
      }
    }
    const input = { scope: "search", fingerprintValue: "snapshot", filters: {}, limit: 2 };
    const first = paginateManagementItems({ ...input, items: items() });
    expect(first.items).toEqual([0, 1]);
    expect(consumed).toEqual([0, 1, 2]);
    consumed.length = 0;
    const second = paginateManagementItems({ ...input, items: items(), cursor: first.nextCursor });
    expect(second.items).toEqual([2, 3]);
    expect(consumed).toEqual([0, 1, 2, 3, 4]);
  });

  it("handles an exact final page and rejects offsets beyond the stream", () => {
    function* items() {
      yield "a";
      yield "b";
    }
    const input = { scope: "search", fingerprintValue: "snapshot", filters: {}, limit: 2 };
    expect(paginateManagementItems({ ...input, items: items() })).toEqual({ items: ["a", "b"] });
    const digest = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const cursor = encodeShortPageCursor(
      {
        scope: input.scope,
        fingerprint: digest(input.fingerprintValue),
        filters: digest(input.filters),
      },
      3,
    );
    expect(() => paginateManagementItems({ ...input, items: items(), cursor })).toThrow(
      "cursor_expired",
    );
  });
});
