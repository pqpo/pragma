import { PragmaExpertMetadataSchema, PragmaToolBindingSchema } from "@pragma/interpreter/ast";
import { PragmaAvatarIdSchema } from "@pragma/shared";
import { z } from "zod";
import {
  ExpertAdditionalInstructionsSchema,
  ExpertCapabilityReferenceSchema,
  ExpertModelConfigSchema,
} from "../../../../../../shared/contracts/capabilities.ts";
import { ExpertContextStoreMountSchema } from "../../../../../../shared/contracts/context-stores.ts";
import {
  ExpertPluginReferenceSchema,
  ExpertToolApprovalModeSchema,
} from "../../../../../../shared/contracts/plugins.ts";

// Aggregate snapshot from b4b3cc1ca537046e5324138efcbacbaf47a3fa3d. Leaf contracts are unchanged.
export const SystemExpertCustomizationConfigV8Schema = z.object({
  schemaVersion: z.literal(8),
  customizations: z
    .array(
      z
        .object({
          avatarId: PragmaAvatarIdSchema.optional(),
          name: PragmaExpertMetadataSchema.shape.name,
          description: PragmaExpertMetadataSchema.shape.description,
          tags: PragmaExpertMetadataSchema.shape.tags,
          model: ExpertModelConfigSchema.optional(),
          capabilities: z.array(ExpertCapabilityReferenceSchema),
          toolApprovals: z.record(z.string().max(200), ExpertToolApprovalModeSchema),
          plugins: z.array(ExpertPluginReferenceSchema),
          contextStoreMounts: z.array(ExpertContextStoreMountSchema),
          resourceTools: z.array(PragmaToolBindingSchema).default([]),
          additionalInstructions: ExpertAdditionalInstructionsSchema,
          ref: z.enum([
            "expert:0000000000pragma",
            "expert:0000000000st0rev",
            "expert:0000000000sk1rev",
          ]),
          revision: z.number().int().min(2),
          updatedAt: z.string().datetime(),
        })
        .strict(),
    )
    .max(100),
});
export type SystemExpertCustomizationConfigV8 = z.infer<
  typeof SystemExpertCustomizationConfigV8Schema
>;
