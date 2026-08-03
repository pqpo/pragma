import {
  PragmaDiagnosticSchema,
  PragmaFlowLoopSchema,
  PragmaFlowResourceSchema,
  PragmaFlowStepSchema,
  PragmaFlowTransitionSchema,
  PragmaMetadataSchema,
  PragmaSemanticResourceRefSchema,
} from "@pragma/interpreter/ast";
import {
  PragmaEvaluationFlowRefSchema,
  PragmaEvaluationMetadataSchema,
  PragmaEvaluationRefSchema,
  PragmaFlowRunDryCaseResultSchema,
  PragmaFlowRunDryCaseSchema,
  PragmaFlowRunDrySuiteResultSchema,
} from "@pragma/evaluation/ast";
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
    "Evaluation",
  ]),
  name: z.string().min(1),
  description: z.string(),
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

export const DefaultAgentFlowDraftUpdateSummarySchema = z.object({
  draftId: z.string().uuid(),
  baseProjectRevision: z.number().int().nonnegative(),
  draftRevision: z.number().int().nonnegative(),
  applied: z.object({
    operationCount: z.number().int().positive(),
    stepsChanged: z.array(DraftGraphIdSchema),
    transitionsChanged: z.array(DraftGraphIdSchema),
    loopsChanged: z.array(DraftGraphIdSchema),
    startChanged: z.boolean(),
    contractsChanged: z.boolean(),
    rebasedToProjectRevision: z.number().int().nonnegative().optional(),
  }),
  diagnostics: z.array(DefaultAgentFlowDraftDiagnosticSchema),
  stepCount: z.number().int().nonnegative(),
  transitionCount: z.number().int().nonnegative(),
  loopCount: z.number().int().nonnegative(),
  hasErrors: z.boolean(),
  isComplete: z.boolean(),
  updatedAt: z.string().datetime(),
});

export const DefaultAgentEvaluationDraftDiagnosticSchema = z.object({
  severity: z.enum(["incomplete", "warning", "error"]),
  code: z.string().min(1),
  message: z.string().min(1),
  path: z.array(z.union([z.string(), z.number()])).default([]),
});

const DefaultAgentEvaluationDraftResourceSchema = z
  .object({
    apiVersion: z.literal("pragma/v3"),
    kind: z.literal("Evaluation"),
    metadata: PragmaEvaluationMetadataSchema,
    spec: z
      .object({
        target: z.object({ ref: PragmaEvaluationFlowRefSchema }).strict(),
        method: z
          .object({
            type: z.literal("flow-run-dry"),
            cases: z.array(PragmaFlowRunDryCaseSchema).max(500),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const DefaultAgentEvaluationDraftSchema = z.object({
  draftId: z.string().uuid(),
  baseProjectRevision: z.number().int().nonnegative(),
  draftRevision: z.number().int().nonnegative(),
  resource: DefaultAgentEvaluationDraftResourceSchema,
  sourceEvaluationRef: PragmaEvaluationRefSchema.optional(),
  diagnostics: z.array(DefaultAgentEvaluationDraftDiagnosticSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const DefaultAgentEvaluationDraftOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("upsert_case"), case: PragmaFlowRunDryCaseSchema }),
  z.object({
    type: z.literal("remove_case"),
    caseId: PragmaFlowRunDryCaseSchema.shape.id,
  }),
  z.object({ type: z.literal("rebase"), projectRevision: z.number().int().nonnegative() }),
]);

export const DefaultAgentEvaluationDraftSummarySchema = z.object({
  draftId: z.string().uuid(),
  baseProjectRevision: z.number().int().nonnegative(),
  draftRevision: z.number().int().nonnegative(),
  metadata: PragmaEvaluationMetadataSchema,
  targetRef: PragmaEvaluationFlowRefSchema,
  sourceEvaluationRef: PragmaEvaluationRefSchema.optional(),
  cases: z.array(
    z.object({
      id: PragmaFlowRunDryCaseSchema.shape.id,
      name: PragmaFlowRunDryCaseSchema.shape.name,
    }),
  ),
  diagnostics: z.array(DefaultAgentEvaluationDraftDiagnosticSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const DefaultAgentEvaluationDraftViewSchema =
  DefaultAgentEvaluationDraftSummarySchema.extend({
    selectedCases: z.array(PragmaFlowRunDryCaseSchema).max(10),
  });

export const DefaultAgentEvaluationDraftRunResultSchema = z.object({
  draft: DefaultAgentEvaluationDraftSummarySchema,
  requestedCases: z.array(PragmaFlowRunDryCaseResultSchema).min(1).max(10),
  suite: z.object({
    passed: z.boolean(),
    total: z.number().int().nonnegative(),
    passedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    failedCaseIds: z.array(PragmaFlowRunDryCaseSchema.shape.id),
  }),
  coverage: PragmaFlowRunDrySuiteResultSchema.shape.coverage,
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
export type DefaultAgentFlowDraftUpdateSummary = z.infer<
  typeof DefaultAgentFlowDraftUpdateSummarySchema
>;
export type DefaultAgentEvaluationDraft = z.infer<typeof DefaultAgentEvaluationDraftSchema>;
export type DefaultAgentEvaluationDraftDiagnostic = z.infer<
  typeof DefaultAgentEvaluationDraftDiagnosticSchema
>;
export type DefaultAgentEvaluationDraftOperation = z.infer<
  typeof DefaultAgentEvaluationDraftOperationSchema
>;
export type DefaultAgentEvaluationDraftSummary = z.infer<
  typeof DefaultAgentEvaluationDraftSummarySchema
>;
export type DefaultAgentEvaluationDraftView = z.infer<typeof DefaultAgentEvaluationDraftViewSchema>;
export type DefaultAgentEvaluationDraftRunResult = z.infer<
  typeof DefaultAgentEvaluationDraftRunResultSchema
>;
export type DefaultAgentProjectCommit = z.infer<typeof DefaultAgentProjectCommitSchema>;
export type DefaultAgentTaskSummary = z.infer<typeof DefaultAgentTaskSummarySchema>;
export type DefaultAgentTask = z.infer<typeof DefaultAgentTaskSchema>;
export type DefaultAgentTaskWorkItem = z.infer<typeof DefaultAgentTaskWorkItemSchema>;
export type DefaultAgentAutomationSummary = z.infer<typeof DefaultAgentAutomationSummarySchema>;
