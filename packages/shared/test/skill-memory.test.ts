import { describe, expect, it } from "vitest";

import {
  ExistingMemorySkillTargetSchema,
  MAX_SKILL_PACKAGE_BYTES,
  SkillPackageSchema,
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
});
