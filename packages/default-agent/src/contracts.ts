import {
  PragmaDiagnosticSchema,
  PragmaFlowLoopSchema,
  PragmaFlowResourceSchema,
  PragmaFlowStepSchema,
  PragmaFlowTransitionSchema,
  PragmaMetadataSchema,
  PragmaSemanticResourceRefSchema,
} from "@pragma/interpreter/ast";
import { z } from "zod";

export const DefaultAgentResourceSummarySchema = z.object({
  ref: PragmaSemanticResourceRefSchema,
  kind: z.enum([
    "Expert",
    "ExpertTeam",
    "Flow",
    "Automation",
    "Capability",
    "ContextStore",
    "RuntimeProfile",
  ]),
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

export const DefaultAgentPrepareResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("invalid"),
    diagnostics: z.array(PragmaDiagnosticSchema),
  }),
  z.object({
    status: z.literal("prepared"),
    changeSet: DefaultAgentChangeSetSchema,
  }),
]);

export const DefaultAgentFlowDraftDiagnosticSchema = z.object({
  severity: z.enum(["incomplete", "warning", "error"]),
  code: z.string().min(1),
  message: z.string().min(1),
  path: z.array(z.union([z.string(), z.number()])).default([]),
});

const CanonicalFlowSpecSchema = PragmaFlowResourceSchema.shape.spec;
const CanonicalFlowGraphSchema = CanonicalFlowSpecSchema.shape.graph;
const DefaultAgentFlowDraftResourceSchema = z
  .object({
    apiVersion: PragmaFlowResourceSchema.shape.apiVersion,
    kind: PragmaFlowResourceSchema.shape.kind,
    metadata: PragmaMetadataSchema,
    spec: z
      .object({
        input: CanonicalFlowSpecSchema.shape.input,
        output: CanonicalFlowSpecSchema.shape.output,
        limits: CanonicalFlowSpecSchema.shape.limits,
        graph: z
          .object({
            start: CanonicalFlowGraphSchema.shape.start.optional(),
            steps: CanonicalFlowGraphSchema.shape.steps,
            transitions: CanonicalFlowGraphSchema.shape.transitions,
            loops: CanonicalFlowGraphSchema.shape.loops,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const DefaultAgentFlowDraftSchema = z.object({
  draftId: z.string().uuid(),
  baseProjectRevision: z.number().int().nonnegative(),
  draftRevision: z.number().int().nonnegative(),
  resource: DefaultAgentFlowDraftResourceSchema,
  diagnostics: z.array(DefaultAgentFlowDraftDiagnosticSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const DraftGraphIdSchema = z.string().trim().min(1);

export const DefaultAgentFlowDraftOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_start"), stepId: DraftGraphIdSchema }),
  z.object({
    type: z.literal("upsert_step"),
    stepId: DraftGraphIdSchema,
    step: PragmaFlowStepSchema,
  }),
  z.object({ type: z.literal("remove_step"), stepId: DraftGraphIdSchema }),
  z.object({
    type: z.literal("set_transition"),
    stepId: DraftGraphIdSchema,
    transition: PragmaFlowTransitionSchema,
  }),
  z.object({ type: z.literal("remove_transition"), stepId: DraftGraphIdSchema }),
  z.object({
    type: z.literal("upsert_loop"),
    loopId: DraftGraphIdSchema,
    loop: PragmaFlowLoopSchema,
  }),
  z.object({ type: z.literal("remove_loop"), loopId: DraftGraphIdSchema }),
  z.object({
    type: z.literal("set_contracts"),
    input: z
      .union([DefaultAgentFlowDraftResourceSchema.shape.spec.shape.input, z.null()])
      .optional(),
    output: z
      .union([DefaultAgentFlowDraftResourceSchema.shape.spec.shape.output, z.null()])
      .optional(),
    limits: DefaultAgentFlowDraftResourceSchema.shape.spec.shape.limits.optional(),
  }),
  z.object({ type: z.literal("rebase"), projectRevision: z.number().int().nonnegative() }),
]);

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

export const DefaultAgentAutomationSummarySchema = z.object({
  ref: PragmaSemanticResourceRefSchema.refine((value) => value.startsWith("automation:")),
  name: z.string().min(1),
  enabled: z.boolean(),
  status: z.enum(["scheduled", "disabled", "expired", "needs_attention"]),
  executorRef: PragmaSemanticResourceRefSchema,
  interaction: z.enum(["reuse-session", "new-mission"]),
  workspaceId: z.string().min(1).optional(),
  nextRunAt: z.string().datetime().optional(),
  missionId: z.string().uuid().optional(),
  queueDepth: z.number().int().nonnegative(),
  diagnostic: z.string().optional(),
});

export type DefaultAgentResourceSummary = z.infer<typeof DefaultAgentResourceSummarySchema>;
export type DefaultAgentDslDocument = z.infer<typeof DefaultAgentDslDocumentSchema>;
export type DefaultAgentRuntimeModelOption = z.infer<typeof DefaultAgentRuntimeModelOptionSchema>;
export type DefaultAgentCapabilityOption = z.infer<typeof DefaultAgentCapabilityOptionSchema>;
export type DefaultAgentExpertOptionCatalog = z.infer<typeof DefaultAgentExpertOptionCatalogSchema>;
export type DefaultAgentDslChange = z.infer<typeof DefaultAgentDslChangeSchema>;
export type DefaultAgentChangeSet = z.infer<typeof DefaultAgentChangeSetSchema>;
export type DefaultAgentPrepareResult = z.infer<typeof DefaultAgentPrepareResultSchema>;
export type DefaultAgentFlowDraft = z.infer<typeof DefaultAgentFlowDraftSchema>;
export type DefaultAgentFlowDraftDiagnostic = z.infer<typeof DefaultAgentFlowDraftDiagnosticSchema>;
export type DefaultAgentFlowDraftOperation = z.infer<typeof DefaultAgentFlowDraftOperationSchema>;
export type DefaultAgentProjectCommit = z.infer<typeof DefaultAgentProjectCommitSchema>;
export type DefaultAgentTaskSummary = z.infer<typeof DefaultAgentTaskSummarySchema>;
export type DefaultAgentTask = z.infer<typeof DefaultAgentTaskSchema>;
export type DefaultAgentTaskWorkItem = z.infer<typeof DefaultAgentTaskWorkItemSchema>;
export type DefaultAgentAutomationSummary = z.infer<typeof DefaultAgentAutomationSummarySchema>;
