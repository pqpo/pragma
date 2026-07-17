import { describe, expect, it } from "vitest";

import {
  mergeExpertAgentToolApprovals,
  resolveExpertAgentToolApprovalRequirement,
} from "../src/tools/managed-tool.ts";

describe("managed tool approval merging", () => {
  it("does not let a conditional requirement disable an unconditional policy", async () => {
    const merged = mergeExpertAgentToolApprovals(
      { mode: "required", when: () => false },
      { mode: "ask" },
    );

    expect(merged).toMatchObject({ mode: "required" });
    expect(merged?.when).toBeUndefined();
    await expect(
      resolveExpertAgentToolApprovalRequirement(merged, {
        kind: "tool_approval",
        toolName: "write",
        input: {},
      }),
    ).resolves.toBe("required");
  });
});
