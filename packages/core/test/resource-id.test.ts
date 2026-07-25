import { describe, expect, it } from "vitest";

import { derivePragmaResourceId, generatePragmaResourceId } from "../src/resource-id.ts";

const SHORT_RESOURCE_ID = /^[0-9a-hjkmnp-tv-z]{16}$/;

describe("Pragma resource IDs", () => {
  it("generates compact 80-bit Crockford Base32 IDs", () => {
    const ids = new Set(Array.from({ length: 1_000 }, () => generatePragmaResourceId()));

    expect(ids.size).toBe(1_000);
    for (const id of ids) expect(id).toMatch(SHORT_RESOURCE_ID);
  });

  it("derives stable IDs without exposing a UUID", () => {
    expect(derivePragmaResourceId("same seed")).toBe(derivePragmaResourceId("same seed"));
    expect(derivePragmaResourceId("same seed")).not.toBe(derivePragmaResourceId("other seed"));
    expect(derivePragmaResourceId("same seed")).toMatch(SHORT_RESOURCE_ID);
  });
});
