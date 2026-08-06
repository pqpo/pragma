import { describe, expect, it } from "vitest";

import { validateGeneratedSkillPackage } from "./generated-skill-validation.ts";

describe("generated Skill validation", () => {
  it("runs covered Node 22 ESM scripts in the restricted test process", async () => {
    const result = await validateGeneratedSkillPackage({
      name: "safe-workflow",
      description: "Run a deterministic safe workflow.",
      files: [
        {
          path: "SKILL.md",
          content:
            "---\nname: safe-workflow\ndescription: Run a deterministic safe workflow.\n---\n\nUse the script.",
        },
        { path: "scripts/run.mjs", content: "export const add = (left, right) => left + right;\n" },
        {
          path: "tests/run.test.mjs",
          content:
            "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from '../scripts/run.mjs';\ntest('adds', () => assert.equal(add(1, 2), 3));\n",
        },
      ],
    });
    expect(result).toMatchObject({
      staticChecksPassed: true,
      scriptTestsPassed: true,
      diagnostics: [],
    });
  });

  it("rejects mismatched metadata and network APIs before execution", async () => {
    const result = await validateGeneratedSkillPackage({
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
    expect(result.staticChecksPassed).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["skill_metadata_mismatch", "skill_network_access_forbidden"]),
    );
  });
});
