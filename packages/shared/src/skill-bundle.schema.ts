import { z } from "zod";

import { SemanticResourceIdSchema } from "./integration/primitives.schema.ts";
import { MAX_SKILL_PACKAGE_BYTES } from "./memory/skill-memory.schema.ts";

export const SkillBundleAssetIdSchema = z.union([SemanticResourceIdSchema, z.string().uuid()]);

export const SkillBundleFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(2_000)
      .refine(
        (path) =>
          !path.startsWith("/") &&
          !path.includes("\\") &&
          !path.includes("\0") &&
          path
            .split("/")
            .every(
              (segment) =>
                segment.length > 0 &&
                segment !== "." &&
                segment !== ".." &&
                segment.toLowerCase() !== ".git",
            ),
        "Skill Bundle paths must be safe relative paths.",
      ),
    sizeBytes: z.number().int().nonnegative().max(MAX_SKILL_PACKAGE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    executable: z.boolean(),
  })
  .strict();

export const SkillBundlePayloadDescriptorSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-bundle-payload/v1"),
    assetKey: SkillBundleAssetIdSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500),
    entryPath: z.literal("SKILL.md"),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    filesFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.array(SkillBundleFileSchema).min(1).max(1_000),
  })
  .strict()
  .superRefine((value, context) => {
    const paths = new Set(value.files.map((file) => file.path));
    if (paths.size !== value.files.length) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "Skill file paths must be unique.",
      });
    }
    if (!paths.has(value.entryPath)) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: `Skill entry file is missing: ${value.entryPath}`,
      });
    }
    const totalBytes = value.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (totalBytes > MAX_SKILL_PACKAGE_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: `Skill Bundles may contain at most ${MAX_SKILL_PACKAGE_BYTES} bytes.`,
      });
    }
  });

export type SkillBundlePayloadDescriptor = z.infer<typeof SkillBundlePayloadDescriptorSchema>;
export type SkillBundleFile = z.infer<typeof SkillBundleFileSchema>;

export function serializeSkillBundleFileManifest(files: readonly SkillBundleFile[]): string {
  return JSON.stringify(
    files.map(({ path, sizeBytes, sha256, executable }) => ({
      path,
      sizeBytes,
      sha256,
      executable,
    })),
  );
}

export function serializeSkillBundleWorkingTree(files: readonly SkillBundleFile[]): string {
  return JSON.stringify(
    files.map(({ path, sha256, sizeBytes, executable }) => [path, sha256, sizeBytes, executable]),
  );
}

export function serializeSkillBundleDefinition(
  descriptor: Pick<
    SkillBundlePayloadDescriptor,
    "contentHash" | "description" | "entryPath" | "name"
  >,
): string {
  return JSON.stringify({
    contentHash: descriptor.contentHash,
    description: descriptor.description,
    entryPath: descriptor.entryPath,
    kind: "skill",
    name: descriptor.name,
  });
}

export function assertValidSkillBundlePayload(input: {
  readonly descriptor: SkillBundlePayloadDescriptor;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly sha256: (value: string | Uint8Array) => string;
  readonly label: string;
}): void {
  const declaredPaths = new Set(input.descriptor.files.map((file) => file.path));
  for (const path of input.files.keys()) {
    if (path === "descriptor.json") continue;
    if (!path.startsWith("files/") || !declaredPaths.has(path.slice("files/".length))) {
      throw new Error(`Skill payload ${input.label} contains an undeclared file: ${path}.`);
    }
  }
  for (const file of input.descriptor.files) {
    const contents = input.files.get(`files/${file.path}`);
    if (contents === undefined) {
      throw new Error(`Skill payload file is missing: ${input.label}/${file.path}.`);
    }
    if (contents.byteLength !== file.sizeBytes || input.sha256(contents) !== file.sha256) {
      throw new Error(
        `Skill payload file fingerprint does not match: ${input.label}/${file.path}.`,
      );
    }
  }
  if (
    input.descriptor.filesFingerprint !==
    input.sha256(serializeSkillBundleFileManifest(input.descriptor.files))
  ) {
    throw new Error(`Skill payload files fingerprint does not match: ${input.label}.`);
  }
  if (
    input.descriptor.contentHash !==
    input.sha256(serializeSkillBundleWorkingTree(input.descriptor.files))
  ) {
    throw new Error(`Skill payload content hash does not match: ${input.label}.`);
  }
  if (
    input.descriptor.fingerprint !== input.sha256(serializeSkillBundleDefinition(input.descriptor))
  ) {
    throw new Error(`Skill payload definition fingerprint does not match: ${input.label}.`);
  }
}
