import { describe, expect, it } from "vitest";

import * as core from "@pragma/core";

describe("public declaration API", () => {
  it("exports only the new top-level declaration entry points", () => {
    expect(core.defineExpert).toBeTypeOf("function");
    expect(core.defineExpertTeam).toBeTypeOf("function");
    expect(core.defineFlow).toBeTypeOf("function");
    expect(["define", "Agent"].join("") in core).toBe(false);
    expect("defineTask" in core).toBe(false);
    expect("defineHumanTask" in core).toBe(false);
  });
});
