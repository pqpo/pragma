import {
  PragmaExpertIdSchema,
  PragmaExpertRefSchema,
  PragmaExpertResourceSchema,
  PragmaResourceRefSchema,
  PragmaToolBindingSchema,
} from "@pragma/interpreter/ast";
import { z } from "zod";
import { DEFAULT_PRAGMA_EXPERT_AVATAR_ID, PragmaAvatarIdSchema } from "@pragma/shared";

import {
  ExpertAdditionalInstructionsSchema,
  ExpertCapabilityReferenceSchema,
  ExpertInstructionsSchema,
  ExpertModelConfigSchema,
  ExpertScopeSchema,
} from "./capabilities.ts";
import { ExpertContextStoreMountSchema } from "./context-stores.ts";
import { ExpertPluginReferenceSchema, ExpertToolApprovalModeSchema } from "./plugins.ts";

export const ExpertExecutionProfileSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("pinned"), model: ExpertModelConfigSchema }),
  z.object({ mode: z.literal("system-default") }),
]);

export const ExpertDefinitionSchema = z.object({
  schemaVersion: z.literal("pragma.desktop-expert-view/v1"),
  ref: PragmaExpertRefSchema,
  id: PragmaExpertIdSchema,
  avatarId: PragmaAvatarIdSchema.default(DEFAULT_PRAGMA_EXPERT_AVATAR_ID),
  name: PragmaExpertResourceSchema.shape.metadata.shape.name,
  description: PragmaExpertResourceSchema.shape.metadata.shape.description,
  tags: PragmaExpertResourceSchema.shape.metadata.shape.tags,
  scope: ExpertScopeSchema,
  instructions: ExpertInstructionsSchema,
  additionalInstructions: ExpertAdditionalInstructionsSchema,
  origin: z.enum(["project", "built-in"]),
  readOnly: z.boolean(),
  customized: z.boolean(),
  executionProfile: ExpertExecutionProfileSchema,
  capabilities: z.array(ExpertCapabilityReferenceSchema),
  toolApprovals: z.record(z.string().max(200), ExpertToolApprovalModeSchema),
  plugins: z.array(ExpertPluginReferenceSchema),
  contextStoreMounts: z.array(ExpertContextStoreMountSchema),
  resourceTools: z.array(PragmaToolBindingSchema).default([]),
  resourceRuntime: PragmaExpertResourceSchema.shape.spec.shape.runtime.optional(),
  opaqueCapabilities: PragmaExpertResourceSchema.shape.spec.shape.capabilities.optional(),
  opaqueContextStores: PragmaExpertResourceSchema.shape.spec.shape.contextStores.optional(),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ExpertSummarySchema = ExpertDefinitionSchema.pick({
  schemaVersion: true,
  ref: true,
  id: true,
  avatarId: true,
  name: true,
  description: true,
  tags: true,
  scope: true,
  origin: true,
  readOnly: true,
  customized: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
});

export const CreateExpertDefinitionSchema = ExpertDefinitionSchema.omit({
  schemaVersion: true,
  ref: true,
  id: true,
  resourceRuntime: true,
  origin: true,
  readOnly: true,
  customized: true,
  additionalInstructions: true,
  executionProfile: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
})
  .extend({
    baseRevision: z.number().int().nonnegative(),
    avatarId: PragmaAvatarIdSchema.optional(),
    requiredUnchangedRefs: z.array(PragmaResourceRefSchema).default([]),
    instructions: ExpertInstructionsSchema,
    model: ExpertModelConfigSchema,
    capabilities: z.array(ExpertCapabilityReferenceSchema).max(500).optional(),
    toolApprovals: z.record(z.string().max(200), ExpertToolApprovalModeSchema).optional(),
    plugins: z.array(ExpertPluginReferenceSchema).max(100).optional(),
    contextStoreMounts: z.array(ExpertContextStoreMountSchema).max(200).optional(),
    resourceTools: z.array(PragmaToolBindingSchema).max(200).optional(),
    opaqueCapabilities: PragmaExpertResourceSchema.shape.spec.shape.capabilities.optional(),
  })
  .strict();

export const UpdateExpertDefinitionSchema = CreateExpertDefinitionSchema.omit({
  requiredUnchangedRefs: true,
})
  .extend({
    baseRevision: z.number().int().positive(),
    avatarId: PragmaAvatarIdSchema.optional(),
  })
  .strict();

export const UpdateBuiltInExpertDefinitionSchema = CreateExpertDefinitionSchema.pick({
  avatarId: true,
  name: true,
  description: true,
  tags: true,
  model: true,
  capabilities: true,
  toolApprovals: true,
  plugins: true,
  contextStoreMounts: true,
})
  .extend({
    avatarId: PragmaAvatarIdSchema.optional(),
    additionalInstructions: ExpertAdditionalInstructionsSchema,
    model: ExpertModelConfigSchema.optional(),
    capabilities: ExpertDefinitionSchema.shape.capabilities,
    toolApprovals: ExpertDefinitionSchema.shape.toolApprovals,
    plugins: ExpertDefinitionSchema.shape.plugins,
    contextStoreMounts: ExpertDefinitionSchema.shape.contextStoreMounts,
  })
  .strict();

export const ExpertRefSchema = PragmaExpertRefSchema;
export const DeleteExpertDefinitionSchema = z.object({ ref: ExpertRefSchema });
export const ResetBuiltInExpertDefinitionSchema = z.object({ ref: ExpertRefSchema });
