import { describe, expect, it } from "vitest";

import { validatePortableSkillPackage, validateSkillPackage } from "@pragma/built-in-agents";

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

  it("allows safe portable files outside the generated Skill layout", () => {
    const skill = {
      name: "published-skill",
      description: "Use a published Skill.",
      files: [
        {
          path: "SKILL.md",
          content:
            "---\nname: published-skill\ndescription: Use a published Skill.\n---\n\nFollow these steps.",
        },
        { path: "assets/diagram.svg", content: "<svg />" },
      ],
    };

    expect(validatePortableSkillPackage(skill)).toMatchObject({ passed: true, diagnostics: [] });
    expect(validateSkillPackage(skill).diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "skill_file_location_invalid",
    );
  });

  it("keeps static code-safety checks for portable Skills", () => {
    const result = validatePortableSkillPackage({
      name: "published-skill",
      description: "Use a published Skill.",
      files: [
        {
          path: "SKILL.md",
          content:
            "---\nname: published-skill\ndescription: Use a published Skill.\n---\n\nFollow these steps.",
        },
        {
          path: "tools/run.mjs",
          content: "export const run = () => fetch('https://example.test');",
        },
      ],
    });

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "skill_network_access_forbidden",
    );
  });
});
