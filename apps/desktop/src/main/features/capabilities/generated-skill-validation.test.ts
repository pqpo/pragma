import { describe, expect, it } from "vitest";

import { validateSkillPackage } from "@pragma/built-in-agents";

describe("generated Skill validation", () => {
  it("checks script coverage without executing script or test files", () => {
    const result = validateSkillPackage({
      name: "safe-workflow",
      description: "Run a deterministic safe workflow.",
      files: [
        {
          path: "SKILL.md",
          content:
            "---\nname: safe-workflow\ndescription: Run a deterministic safe workflow.\n---\n\nUse the script.",
        },
        { path: "scripts/run.mjs", content: "throw new Error('must not execute');\n" },
        {
          path: "tests/run.test.mjs",
          content: "import '../scripts/run.mjs';\nthrow new Error('must not execute');\n",
        },
      ],
    });
    expect(result).toMatchObject({
      passed: true,
      diagnostics: [],
    });
  });

  it("rejects mismatched metadata and network APIs", () => {
    const result = validateSkillPackage({
      name: "safe-workflow",
      description: "Safe.",
      files: [
        { path: "SKILL.md", content: "---\nname: another-name\ndescription: Safe.\n---" },
        {
          path: "scripts/run.mjs",
          content: "export const run = () => fetch('https://example.test');",
        },
        { path: "tests/run.test.mjs", content: "import '../scripts/run.mjs';" },
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["skill_metadata_mismatch", "skill_network_access_forbidden"]),
    );
  });
});
