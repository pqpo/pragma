import { describe, expect, it } from "vitest";

import { validatePortableSkillPackage, validateSkillPackage } from "../src/skill-validation.ts";

describe("Skill package validation", () => {
  it("does not scan non-executable JavaScript reference files", () => {
    const validation = validatePortableSkillPackage(
      {
        name: "Example Skill",
        description: "Uses a JavaScript reference example.",
        files: [
          {
            path: "SKILL.md",
            content:
              "---\nname: Example Skill\ndescription: Uses a JavaScript reference example.\n---\n",
          },
          {
            path: "references/example.js",
            content: "fetch('https://example.test'); import('optional-package');\n",
          },
        ],
      },
      { executablePaths: new Set() },
    );

    expect(validation.passed).toBe(true);
    expect(validation.diagnostics).toEqual([]);
  });

  it("still scans generated scripts and tests while skipping reference examples", () => {
    const validation = validateSkillPackage(
      {
        name: "Generated Skill",
        description: "Has generated script tests.",
        files: [
          {
            path: "SKILL.md",
            content: "---\nname: Generated Skill\ndescription: Has generated script tests.\n---\n",
          },
          {
            path: "references/example.js",
            content: "fetch('https://example.test');\n",
          },
          { path: "scripts/run.mjs", content: "export const run = () => fetch('/');\n" },
          { path: "tests/run.test.mjs", content: "import '../scripts/run.mjs';\n" },
        ],
      },
      { executablePaths: new Set() },
    );

    expect(validation.diagnostics).toContainEqual(
      expect.objectContaining({
        path: "scripts/run.mjs",
        code: "skill_network_access_forbidden",
      }),
    );
    expect(
      validation.diagnostics.some((diagnostic) => diagnostic.path === "references/example.js"),
    ).toBe(false);
  });

  it("applies the generated per-file size limit without narrowing portable packages", () => {
    const largeContent = "x".repeat(128 * 1_024 + 1);
    const skill = {
      name: "Large Skill",
      description: "Has a larger reference file.",
      files: [
        {
          path: "SKILL.md",
          content: "---\nname: Large Skill\ndescription: Has a larger reference file.\n---\n",
        },
        { path: "references/large.md", content: largeContent },
      ],
    };

    const generated = validateSkillPackage(skill, { executablePaths: new Set() });
    const portable = validatePortableSkillPackage(skill, { executablePaths: new Set() });

    expect(generated.diagnostics).toContainEqual(
      expect.objectContaining({ path: "files.1.content", code: "custom" }),
    );
    expect(portable.passed).toBe(true);
  });
});
