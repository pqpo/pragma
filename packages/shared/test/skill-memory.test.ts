import { describe, expect, it } from "vitest";

import {
  ExistingMemorySkillTargetSchema,
  GeneratedSkillPackageSchema,
  MAX_SKILL_PACKAGE_BYTES,
  SkillPackageSchema,
  SkillExtractionOutputSchema,
} from "../src/index.ts";

describe("Skill memory contracts", () => {
  it("accepts canonical Capability ids as existing Skill targets", () => {
    expect(
      ExistingMemorySkillTargetSchema.parse({
        bindingId: "00000000-0000-4000-8000-000000000001",
        capabilityId: "0123456789abcdef",
        name: "Synced Skill",
        description: "Imported from a configured remote.",
        normalizedKeys: ["synced-skill"],
      }).capabilityId,
    ).toBe("0123456789abcdef");
  });

  it("rejects generated Skill packages above the aggregate byte limit", () => {
    const maximumChunk = "a".repeat(128 * 1_024);
    const packageFiles = Array.from(
      { length: MAX_SKILL_PACKAGE_BYTES / maximumChunk.length },
      (_, index) => ({ path: `references/${index}.md`, content: maximumChunk }),
    );
    const result = SkillPackageSchema.safeParse({
      name: "Oversized Skill",
      description: "Exceeds the aggregate limit by one byte.",
      files: [{ path: "SKILL.md", content: "x" }, ...packageFiles],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["files"],
          message: `Skill packages may contain at most ${MAX_SKILL_PACKAGE_BYTES} bytes.`,
        }),
      );
    }
  });

  it("rejects Git metadata directories anywhere in a Skill path", () => {
    expect(
      SkillPackageSchema.safeParse({
        name: "Unsafe Skill",
        description: "Attempts to write repository metadata.",
        files: [
          { path: "SKILL.md", content: "# Unsafe" },
          { path: "references/.GiT/config", content: "[core]" },
        ],
      }).success,
    ).toBe(false);
  });

  it("allows portable files in ordinary Skill packages but rejects them in extraction output", () => {
    const candidate = {
      content: {
        normalizedKey: "diagram-workflow",
        applicability: ["When diagrams are needed."],
        failureModes: ["The diagram asset is missing."],
        recoverySteps: ["Restore the diagram asset."],
        package: {
          name: "diagram-workflow",
          description: "Use an accompanying diagram.",
          files: [
            {
              path: "SKILL.md",
              content:
                "---\nname: diagram-workflow\ndescription: Use an accompanying diagram.\n---",
            },
            { path: "assets/diagram.svg", content: "<svg />" },
          ],
        },
      },
      sourceRefs: [
        { kind: "episodic", id: "source-one", revision: 1 },
        { kind: "episodic", id: "source-two", revision: 1 },
        { kind: "episodic", id: "source-three", revision: 1 },
      ],
      route: { type: "create" },
    };

    expect(SkillPackageSchema.safeParse(candidate.content.package).success).toBe(true);
    expect(GeneratedSkillPackageSchema.safeParse(candidate.content.package).success).toBe(false);
    expect(
      SkillExtractionOutputSchema.safeParse({ retain: true, candidates: [candidate] }).success,
    ).toBe(false);
  });

  it("rejects non-ESM executable paths from extraction candidates", () => {
    const result = GeneratedSkillPackageSchema.safeParse({
      name: "unsafe-generated-skill",
      description: "Has a non-ESM script path.",
      files: [
        { path: "SKILL.md", content: "# Skill" },
        { path: "scripts/run.js", content: "export const run = true;" },
      ],
    });

    expect(result.success).toBe(false);
  });
});
