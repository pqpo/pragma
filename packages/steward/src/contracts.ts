import { PragmaDiagnosticSchema, PragmaSemanticResourceRefSchema } from "@pragma/interpreter/ast";
import { z } from "zod";

export const StewardResourceSummarySchema = z.object({
  ref: PragmaSemanticResourceRefSchema,
  kind: z.enum(["Expert", "ExpertTeam", "Flow", "Capability", "ContextStore", "RuntimeProfile"]),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
});

export const StewardDslDocumentSchema = StewardResourceSummarySchema.extend({
  projectRevision: z.number().int().nonnegative(),
  source: z.string().min(1),
});

export const StewardRuntimeModelOptionSchema = z.object({
  key: z.string().min(1).max(500),
  runtimeProfileRef: PragmaSemanticResourceRefSchema.refine((value) =>
    value.startsWith("runtime-profile:"),
  ),
  runtimeName: z.string().min(1).max(200),
  providerName: z.string().min(1).max(200),
  modelName: z.string().min(1).max(200),
  isDefault: z.boolean(),
});

export const StewardCapabilityOptionSchema = z.object({
  key: z.string().min(1).max(500),
  ref: PragmaSemanticResourceRefSchema.refine((value) => value.startsWith("capability:")),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000),
  kind: z.enum(["skill", "tools"]),
  toolNames: z.array(z.string().min(1).max(128)).max(500),
});

export const StewardExpertOptionCatalogSchema = z.object({
  runtimeModels: z.array(StewardRuntimeModelOptionSchema),
  capabilities: z.array(StewardCapabilityOptionSchema),
});

export const StewardDslChangeSchema = z.object({ source: z.string().min(1).max(2_000_000) });

export const StewardChangeSetSchema = z.object({
  changeSetId: z.string().uuid(),
  projectRevision: z.number().int().nonnegative(),
  diagnostics: z.array(PragmaDiagnosticSchema),
  changes: z.array(
    z.object({
      ref: PragmaSemanticResourceRefSchema,
      kind: z.enum(["created", "updated"]),
      source: z.string().min(1),
    }),
  ),
  createdAt: z.string().datetime(),
});

export const StewardProjectCommitSchema = z.object({
  projectId: z.string().min(1),
  projectRevision: z.number().int().positive(),
  changedRefs: z.array(PragmaSemanticResourceRefSchema),
});

export const StewardTaskSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.string().min(1),
  executorRef: z.string().min(1),
  workspaceLabel: z.string().min(1),
  updatedAt: z.string().datetime(),
});

export const StewardTaskSchema = StewardTaskSummarySchema.extend({
  goal: z.string().min(1),
  workspaceId: z.string().min(1),
  details: z.unknown().optional(),
});

export const StewardTaskWorkItemSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  status: z.string().min(1),
  label: z.string().min(1),
  details: z.unknown().optional(),
});

export type StewardResourceSummary = z.infer<typeof StewardResourceSummarySchema>;
export type StewardDslDocument = z.infer<typeof StewardDslDocumentSchema>;
export type StewardRuntimeModelOption = z.infer<typeof StewardRuntimeModelOptionSchema>;
export type StewardCapabilityOption = z.infer<typeof StewardCapabilityOptionSchema>;
export type StewardExpertOptionCatalog = z.infer<typeof StewardExpertOptionCatalogSchema>;
export type StewardDslChange = z.infer<typeof StewardDslChangeSchema>;
export type StewardChangeSet = z.infer<typeof StewardChangeSetSchema>;
export type StewardProjectCommit = z.infer<typeof StewardProjectCommitSchema>;
export type StewardTaskSummary = z.infer<typeof StewardTaskSummarySchema>;
export type StewardTask = z.infer<typeof StewardTaskSchema>;
export type StewardTaskWorkItem = z.infer<typeof StewardTaskWorkItemSchema>;
