import { describe, expect, it } from "vitest";

import { validateSkillPackage } from "../src/skill-validation.ts";

describe("Skill package validation", () => {
  it("does not scan non-executable JavaScript reference files", () => {
    const validation = validateSkillPackage({
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
    });

    expect(validation.passed).toBe(true);
    expect(validation.diagnostics).toEqual([]);
  });

  it("parses quoted and folded YAML frontmatter values", () => {
    const validation = validateSkillPackage({
      name: "team's-review",
      description: "Review changes: include enough detail.",
      files: [
        {
          path: "SKILL.md",
          content: [
            "---",
            'name: "team\'s-review"',
            "description: >-",
            "  Review changes:",
            "  include enough detail.",
            "---",
            "",
            "Review the change.",
          ].join("\n"),
        },
      ],
    });

    expect(validation).toMatchObject({ passed: true, diagnostics: [] });
  });

  it("ignores spaces and line breaks when comparing Skill descriptions", () => {
    const validation = validateSkillPackage({
      name: "whitespace-description",
      description: "使用\n代码 审查\t流程",
      files: [
        {
          path: "SKILL.md",
          content: "---\nname: whitespace-description\ndescription: 使用代码审查流程\n---\n",
        },
      ],
    });

    expect(validation).toMatchObject({ passed: true, diagnostics: [] });
  });

  it("still rejects a description mismatch after whitespace normalization", () => {
    const validation = validateSkillPackage({
      name: "different-description",
      description: "Review\ncode",
      files: [
        {
          path: "SKILL.md",
          content: "---\nname: different-description\ndescription: Review unrelated code.\n---\n",
        },
      ],
    });

    expect(validation.diagnostics).toContainEqual(
      expect.objectContaining({ path: "SKILL.md:description", code: "skill_metadata_mismatch" }),
    );
  });

  it("allows arbitrary scripts, dependencies and layouts without requiring tests", () => {
    const validation = validateSkillPackage({
      name: "Flexible Skill",
      description: "Runs creator-verified scripts.",
      files: [
        {
          path: "SKILL.md",
          content: "---\nname: Flexible Skill\ndescription: Runs creator-verified scripts.\n---\n",
        },
        {
          path: "scripts/run.py",
          content: "import requests\nrequests.get('https://example.test')\n",
        },
        { path: "bin/run", content: "#!/bin/sh\ncurl https://example.test\n" },
        { path: "scripts/run.ts", content: "export const result: boolean = true;" },
        { path: "scripts/run.cjs", content: "require('axios'); process.binding('fs');" },
        {
          path: "scripts/run.mjs",
          content:
            "import { exec } from 'node:child_process'; import 'lodash'; import('axios'); fetch('/'); new WebSocket('wss://example.test'); new EventSource('/events'); process._linkedBinding('fs'); process.mainModule; throw new Error('must not execute');",
        },
        { path: "package.json", content: '{"dependencies":{"lodash":"4"}}' },
        { path: "requirements.txt", content: "requests\n" },
        { path: "assets/large.txt", content: "x".repeat(128 * 1024 + 1) },
      ],
    });
    expect(validation).toEqual({ passed: true, diagnostics: [] });
  });

  it.each([
    "../outside.py",
    "/absolute.sh",
    "scripts/../run.py",
    "scripts/./run.py",
    "scripts\\run.py",
    ".git/config",
  ])("rejects unsafe package path %s", (path) => {
    expect(
      validateSkillPackage({
        name: "Example Skill",
        description: "Example.",
        files: [
          { path: "SKILL.md", content: "---\nname: Example Skill\ndescription: Example.\n---\n" },
          { path, content: "example" },
        ],
      }).passed,
    ).toBe(false);
  });

  it("keeps package size, file count, unique paths and entry requirements", () => {
    const entry = {
      path: "SKILL.md",
      content: "---\nname: Example Skill\ndescription: Example.\n---\n",
    };
    const check = (files: { path: string; content: string }[]) =>
      validateSkillPackage({ name: "Example Skill", description: "Example.", files });
    expect(check([]).passed).toBe(false);
    expect(check([entry, entry]).passed).toBe(false);
    expect(
      check([
        entry,
        ...Array.from({ length: 1000 }, (_, index) => ({ path: `assets/${index}`, content: "" })),
      ]).passed,
    ).toBe(false);
    expect(
      check([entry, { path: "large.txt", content: "x".repeat(25 * 1024 * 1024) }]).passed,
    ).toBe(false);
    expect(check([entry]).passed).toBe(true);
  });

  it.each([
    "# Missing frontmatter",
    "---\nname: [broken\n---\n",
    "---\n- list\n---\n",
    "---\nname: [invalid]\ndescription: Example.\n---\n",
    "---\nname: Example Skill\ndescription: 42\n---\n",
  ])("rejects malformed entry metadata %s", (content) => {
    expect(
      validateSkillPackage({
        name: "Example Skill",
        description: "Example.",
        files: [{ path: "SKILL.md", content }],
      }).diagnostics,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "skill_frontmatter_invalid" })]),
    );
  });

  it("keeps synchronization's explicit description consistency option", () => {
    expect(
      validateSkillPackage(
        {
          name: "Example Skill",
          description: "Separate sync description.",
          files: [
            {
              path: "SKILL.md",
              content: "---\nname: Example Skill\ndescription: Original description.\n---\n",
            },
          ],
        },
        { checkDescriptionConsistency: false },
      ).passed,
    ).toBe(true);
  });
});
