import { PragmaDiagnosticSchema, PragmaSemanticResourceRefSchema } from "@pragma/interpreter/ast";
import { z } from "zod";

export const DefaultAgentResourceSummarySchema = z.object({
  ref: PragmaSemanticResourceRefSchema,
  kind: z.enum(["Expert", "ExpertTeam", "Flow", "Capability", "ContextStore", "RuntimeProfile"]),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
});

export const DefaultAgentDslDocumentSchema = DefaultAgentResourceSummarySchema.extend({
  projectRevision: z.number().int().nonnegative(),
  source: z.string().min(1),
});

export const DefaultAgentRuntimeModelOptionSchema = z.object({
  key: z.string().min(1).max(500),
  runtimeProfileRef: PragmaSemanticResourceRefSchema.refine((value) =>
    value.startsWith("runtime-profile:"),
  ),
  runtimeName: z.string().min(1).max(200),
  providerName: z.string().min(1).max(200),
  modelName: z.string().min(1).max(200),
  isDefault: z.boolean(),
});

export const DefaultAgentCapabilityOptionSchema = z.object({
  key: z.string().min(1).max(500),
  ref: PragmaSemanticResourceRefSchema.refine((value) => value.startsWith("capability:")),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000),
  kind: z.enum(["skill", "tools"]),
  toolNames: z.array(z.string().min(1).max(128)).max(500),
});

export const DefaultAgentExpertOptionCatalogSchema = z.object({
  runtimeModels: z.array(DefaultAgentRuntimeModelOptionSchema),
  capabilities: z.array(DefaultAgentCapabilityOptionSchema),
});

export const DefaultAgentDslChangeSchema = z.object({ source: z.string().min(1).max(2_000_000) });

export const DefaultAgentChangeSetSchema = z.object({
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

export const DefaultAgentProjectCommitSchema = z.object({
  projectId: z.string().min(1),
  projectRevision: z.number().int().positive(),
  changedRefs: z.array(PragmaSemanticResourceRefSchema),
});

export const DefaultAgentTaskSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.string().min(1),
  executorRef: z.string().min(1),
  workspaceLabel: z.string().min(1),
  updatedAt: z.string().datetime(),
});

export const DefaultAgentTaskSchema = DefaultAgentTaskSummarySchema.extend({
  goal: z.string().min(1),
  workspaceId: z.string().min(1),
  details: z.unknown().optional(),
});

export const DefaultAgentTaskWorkItemSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  status: z.string().min(1),
  label: z.string().min(1),
  details: z.unknown().optional(),
});

export type DefaultAgentResourceSummary = z.infer<typeof DefaultAgentResourceSummarySchema>;
export type DefaultAgentDslDocument = z.infer<typeof DefaultAgentDslDocumentSchema>;
export type DefaultAgentRuntimeModelOption = z.infer<typeof DefaultAgentRuntimeModelOptionSchema>;
export type DefaultAgentCapabilityOption = z.infer<typeof DefaultAgentCapabilityOptionSchema>;
export type DefaultAgentExpertOptionCatalog = z.infer<typeof DefaultAgentExpertOptionCatalogSchema>;
export type DefaultAgentDslChange = z.infer<typeof DefaultAgentDslChangeSchema>;
export type DefaultAgentChangeSet = z.infer<typeof DefaultAgentChangeSetSchema>;
export type DefaultAgentProjectCommit = z.infer<typeof DefaultAgentProjectCommitSchema>;
export type DefaultAgentTaskSummary = z.infer<typeof DefaultAgentTaskSummarySchema>;
export type DefaultAgentTask = z.infer<typeof DefaultAgentTaskSchema>;
export type DefaultAgentTaskWorkItem = z.infer<typeof DefaultAgentTaskWorkItemSchema>;
