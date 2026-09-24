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
});
