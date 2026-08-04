import { MissionExecutorRefSchema } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import { MEMORY_CURATOR_ID, MEMORY_CURATOR_REF } from "../src/index.ts";

describe("Memory Curator identity", () => {
  it("is a valid canonical Mission executor reference", () => {
    expect(MEMORY_CURATOR_ID).toMatch(/^[0-9a-hjkmnp-tv-z]{16}$/);
    expect(MissionExecutorRefSchema.parse(MEMORY_CURATOR_REF)).toBe(`expert:${MEMORY_CURATOR_ID}`);
  });
});
