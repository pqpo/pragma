import { describe, expect, it } from "vitest";

import {
  assertValidSkillBundlePayload,
  SkillBundlePayloadDescriptorSchema,
  skillBundleContentHashChunks,
  serializeSkillBundleDefinition,
  serializeSkillBundleFileManifest,
  serializeSkillBundleWorkingTree,
  type SkillBundleFile,
} from "../src/index.ts";

describe("Skill Bundle payload codec", () => {
  const file: SkillBundleFile = {
    path: "SKILL.md",
    sizeBytes: 12,
    sha256: "a".repeat(64),
    executable: false,
  };

  it("canonically serializes file identity separately from content and working-tree hashes", () => {
    const earlierFile = {
      ...file,
      path: "README.md",
      sizeBytes: 6,
      sha256: "b".repeat(64),
    };
    expect(JSON.parse(serializeSkillBundleFileManifest([file]))).toEqual([
      {
        path: "SKILL.md",
        sizeBytes: 12,
        sha256: "a".repeat(64),
        executable: false,
      },
    ]);
    expect(JSON.parse(serializeSkillBundleWorkingTree([file]))).toEqual([
      ["SKILL.md", "a".repeat(64), 12, false],
    ]);
    expect(serializeSkillBundleFileManifest([file])).not.toBe(
      serializeSkillBundleWorkingTree([file]),
    );
    expect(serializeSkillBundleFileManifest([file, earlierFile])).toBe(
      serializeSkillBundleFileManifest([earlierFile, file]),
    );
    expect(serializeSkillBundleWorkingTree([file, earlierFile])).toBe(
      serializeSkillBundleWorkingTree([earlierFile, file]),
    );
    expect(
      skillBundleContentHashChunks([
        { path: file.path, contents: new TextEncoder().encode("Review code.") },
        { path: earlierFile.path, contents: new TextEncoder().encode("Read.\n") },
      ]),
    ).toEqual(
      skillBundleContentHashChunks([
        { path: earlierFile.path, contents: new TextEncoder().encode("Read.\n") },
        { path: file.path, contents: new TextEncoder().encode("Review code.") },
      ]),
    );
  });

  it("requires a unique, safe file manifest containing SKILL.md", () => {
    const descriptor = {
      schemaVersion: "pragma.skill-bundle-payload/v1",
      assetKey: "0123456789abcdef",
      name: "Review Skill",
      description: "Reviews code.",
      entryPath: "SKILL.md",
      contentHash: "b".repeat(64),
      filesFingerprint: "c".repeat(64),
      fingerprint: "d".repeat(64),
    } as const;

    expect(
      SkillBundlePayloadDescriptorSchema.safeParse({
        ...descriptor,
        files: [file, file],
      }).success,
    ).toBe(false);
    expect(
      SkillBundlePayloadDescriptorSchema.safeParse({
        ...descriptor,
        files: [{ ...file, path: "../SKILL.md" }],
      }).success,
    ).toBe(false);
    expect(
      SkillBundlePayloadDescriptorSchema.safeParse({
        ...descriptor,
        files: [{ ...file, path: "scripts/review.sh", executable: true }],
      }).success,
    ).toBe(false);
    expect(
      SkillBundlePayloadDescriptorSchema.safeParse({ ...descriptor, files: [file] }).success,
    ).toBe(true);
  });

  it("validates every declared file and all payload fingerprints", () => {
    const skillDocument = new TextEncoder().encode("Review code.");
    const descriptor = SkillBundlePayloadDescriptorSchema.parse({
      schemaVersion: "pragma.skill-bundle-payload/v1",
      assetKey: "0123456789abcdef",
      name: "Review Skill",
      description: "Reviews code.",
      entryPath: "SKILL.md",
      contentHash: "c".repeat(64),
      filesFingerprint: "b".repeat(64),
      fingerprint: "d".repeat(64),
      files: [file],
    });
    const sha256 = (value: string | Uint8Array | readonly (string | Uint8Array)[]): string => {
      if (Array.isArray(value)) return "c".repeat(64);
      if (value instanceof Uint8Array) return "a".repeat(64);
      if (value === serializeSkillBundleFileManifest(descriptor.files)) return "b".repeat(64);
      if (value === serializeSkillBundleDefinition(descriptor)) return "d".repeat(64);
      throw new Error(`Unexpected digest input: ${value}`);
    };

    expect(() =>
      assertValidSkillBundlePayload({
        descriptor,
        files: new Map([
          ["descriptor.json", new Uint8Array()],
          ["files/SKILL.md", skillDocument],
        ]),
        sha256,
        label: "capability:0123456789abcdef",
      }),
    ).not.toThrow();
    expect(() =>
      assertValidSkillBundlePayload({
        descriptor,
        files: new Map([
          ["descriptor.json", new Uint8Array()],
          ["files/SKILL.md", skillDocument],
          ["files/undeclared.txt", new Uint8Array()],
        ]),
        sha256,
        label: "capability:0123456789abcdef",
      }),
    ).toThrow("undeclared file");
  });
});
