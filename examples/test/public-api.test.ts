import { describe, expect, it } from "vitest";

import * as core from "@pragma/core";

describe("public Expert and Flow API", () => {
  it("exports the current declaration and composition entry points", () => {
    expect(core.createAgentLauncher).toBeTypeOf("function");
    expect(core.defineExpert).toBeTypeOf("function");
    expect(core.defineExpertTeam).toBeTypeOf("function");
    expect(core.defineFlow).toBeTypeOf("function");
    expect(["define", "Agent"].join("") in core).toBe(false);
    expect("defineTask" in core).toBe(false);
    expect("defineHumanTask" in core).toBe(false);
  });
});
