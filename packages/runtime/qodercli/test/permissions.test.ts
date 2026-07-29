import { describe, expect, it } from "vitest";

import { resolveQoderApprovedToolInput } from "../src/session.ts";

describe("Qoder tool approval input", () => {
  it("accepts plain records and rejects values that cannot be Qoder tool input", () => {
    const original = { path: "original" };
    const updated = { path: "updated" };

    expect(resolveQoderApprovedToolInput(original, updated)).toBe(updated);
    expect(resolveQoderApprovedToolInput(original, Object.assign(new Map(), updated))).toBe(
      original,
    );
    expect(resolveQoderApprovedToolInput(original, new Date())).toBe(original);
    expect(resolveQoderApprovedToolInput(original, ["updated"])).toBe(original);
  });
});
