import { z } from "zod";

import { SemanticResourceIdSchema } from "./integration/primitives.schema.ts";

export const SkillBundleAssetIdSchema = z.union([SemanticResourceIdSchema, z.string().uuid()]);

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
  })
  .strict();

export type SkillBundlePayloadDescriptor = z.infer<typeof SkillBundlePayloadDescriptorSchema>;
