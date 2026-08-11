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
import { PragmaExpertAvatarProfileSchema } from "@pragma/shared";
import { z } from "zod";

export * from "./revision-contracts.ts";

export const PragmaAgentResourceSummarySchema = z.object({
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

export const PragmaAgentDslDocumentSchema = PragmaAgentResourceSummarySchema.extend({
  projectRevision: z.number().int().nonnegative(),
  source: z.string().min(1),
});

export const PragmaAgentRuntimeModelOptionSchema = z.object({
  key: z.string().min(1).max(500),
  runtimeProfileRef: PragmaSemanticResourceRefSchema.refine((value) =>
    value.startsWith("runtime-profile:"),
  ),
  runtimeName: z.string().min(1).max(200),
  providerName: z.string().min(1).max(200),
  modelName: z.string().min(1).max(200),
  isDefault: z.boolean(),
});

export const PragmaAgentCapabilityOptionSchema = z.object({
  key: z.string().min(1).max(500),
  ref: PragmaSemanticResourceRefSchema.refine((value) => value.startsWith("capability:")),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000),
  kind: z.enum(["skill", "tools"]),
  toolNames: z.array(z.string().min(1).max(128)).max(500),
});

export const PragmaAgentExpertOptionCatalogSchema = z.object({
  runtimeModels: z.array(PragmaAgentRuntimeModelOptionSchema),
  capabilities: z.array(PragmaAgentCapabilityOptionSchema),
  avatars: z.array(PragmaExpertAvatarProfileSchema),
});

export const PragmaAgentDslChangeSchema = z.object({ source: z.string().min(1).max(2_000_000) });

export const PragmaAgentChangeSetSchema = z.object({
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

export const PragmaAgentPrepareResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("invalid"),
    diagnostics: z.array(PragmaDiagnosticSchema),
  }),
  z.object({
    status: z.literal("prepared"),
    changeSet: PragmaAgentChangeSetSchema,
  }),
]);

export const PragmaAgentFlowDraftDiagnosticSchema = z.object({
  severity: z.enum(["incomplete", "warning", "error"]),
  code: z.string().min(1),
  message: z.string().min(1),
  path: z.array(z.union([z.string(), z.number()])).default([]),
});

const CanonicalFlowSpecSchema = PragmaFlowResourceSchema.shape.spec;
const CanonicalFlowGraphSchema = CanonicalFlowSpecSchema.shape.graph;
const PragmaAgentFlowDraftResourceSchema = z
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

export const PragmaAgentFlowDraftSchema = z.object({
  draftId: z.string().uuid(),
  baseProjectRevision: z.number().int().nonnegative(),
  draftRevision: z.number().int().nonnegative(),
  resource: PragmaAgentFlowDraftResourceSchema,
  diagnostics: z.array(PragmaAgentFlowDraftDiagnosticSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const DraftGraphIdSchema = z.string().trim().min(1);

export const PragmaAgentFlowDraftOperationSchema = z.discriminatedUnion("type", [
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
      .union([PragmaAgentFlowDraftResourceSchema.shape.spec.shape.input, z.null()])
      .optional(),
    output: z
      .union([PragmaAgentFlowDraftResourceSchema.shape.spec.shape.output, z.null()])
      .optional(),
    limits: PragmaAgentFlowDraftResourceSchema.shape.spec.shape.limits.optional(),
  }),
  z.object({ type: z.literal("rebase"), projectRevision: z.number().int().nonnegative() }),
]);

export const PragmaAgentFlowDraftUpdateSummarySchema = z.object({
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
  diagnostics: z.array(PragmaAgentFlowDraftDiagnosticSchema),
  stepCount: z.number().int().nonnegative(),
  transitionCount: z.number().int().nonnegative(),
  loopCount: z.number().int().nonnegative(),
  hasErrors: z.boolean(),
  isComplete: z.boolean(),
  updatedAt: z.string().datetime(),
});

export const PragmaAgentEvaluationDraftDiagnosticSchema = z.object({
  severity: z.enum(["incomplete", "warning", "error"]),
  code: z.string().min(1),
  message: z.string().min(1),
  path: z.array(z.union([z.string(), z.number()])).default([]),
});

const PragmaAgentEvaluationDraftResourceSchema = z
  .object({
    apiVersion: z.literal("pragma/v4"),
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

export const PragmaAgentEvaluationDraftSchema = z.object({
  draftId: z.string().uuid(),
  baseProjectRevision: z.number().int().nonnegative(),
  draftRevision: z.number().int().nonnegative(),
  resource: PragmaAgentEvaluationDraftResourceSchema,
  sourceEvaluationRef: PragmaEvaluationRefSchema.optional(),
  diagnostics: z.array(PragmaAgentEvaluationDraftDiagnosticSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const PragmaAgentEvaluationDraftOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("upsert_case"), case: PragmaFlowRunDryCaseSchema }),
  z.object({
    type: z.literal("remove_case"),
    caseId: PragmaFlowRunDryCaseSchema.shape.id,
  }),
  z.object({ type: z.literal("rebase"), projectRevision: z.number().int().nonnegative() }),
]);

export const PragmaAgentEvaluationDraftSummarySchema = z.object({
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
  diagnostics: z.array(PragmaAgentEvaluationDraftDiagnosticSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const PragmaAgentEvaluationDraftViewSchema = PragmaAgentEvaluationDraftSummarySchema.extend({
  selectedCases: z.array(PragmaFlowRunDryCaseSchema).max(10),
});

export const PragmaAgentEvaluationDraftRunResultSchema = z.object({
  draft: PragmaAgentEvaluationDraftSummarySchema,
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

export const PragmaAgentProjectCommitSchema = z.object({
  projectId: z.string().min(1),
  projectRevision: z.number().int().positive(),
  changedRefs: z.array(PragmaSemanticResourceRefSchema),
});

export const PragmaAgentTaskSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.string().min(1),
  executorRef: z.string().min(1),
  workspaceLabel: z.string().min(1),
  updatedAt: z.string().datetime(),
});

export const PragmaAgentTaskSchema = PragmaAgentTaskSummarySchema.extend({
  goal: z.string().min(1),
  workspaceId: z.string().min(1),
  details: z.unknown().optional(),
});

export const PragmaAgentTaskWorkItemSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  status: z.string().min(1),
  label: z.string().min(1),
  details: z.unknown().optional(),
});

export const PragmaAgentAutomationSummarySchema = z.object({
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

export type PragmaAgentResourceSummary = z.infer<typeof PragmaAgentResourceSummarySchema>;
export type PragmaAgentDslDocument = z.infer<typeof PragmaAgentDslDocumentSchema>;
export type PragmaAgentRuntimeModelOption = z.infer<typeof PragmaAgentRuntimeModelOptionSchema>;
export type PragmaAgentCapabilityOption = z.infer<typeof PragmaAgentCapabilityOptionSchema>;
export type PragmaAgentExpertOptionCatalog = z.infer<typeof PragmaAgentExpertOptionCatalogSchema>;
export type PragmaAgentDslChange = z.infer<typeof PragmaAgentDslChangeSchema>;
export type PragmaAgentChangeSet = z.infer<typeof PragmaAgentChangeSetSchema>;
export type PragmaAgentPrepareResult = z.infer<typeof PragmaAgentPrepareResultSchema>;
export type PragmaAgentFlowDraft = z.infer<typeof PragmaAgentFlowDraftSchema>;
export type PragmaAgentFlowDraftDiagnostic = z.infer<typeof PragmaAgentFlowDraftDiagnosticSchema>;
export type PragmaAgentFlowDraftOperation = z.infer<typeof PragmaAgentFlowDraftOperationSchema>;
export type PragmaAgentFlowDraftUpdateSummary = z.infer<
  typeof PragmaAgentFlowDraftUpdateSummarySchema
>;
export type PragmaAgentEvaluationDraft = z.infer<typeof PragmaAgentEvaluationDraftSchema>;
export type PragmaAgentEvaluationDraftDiagnostic = z.infer<
  typeof PragmaAgentEvaluationDraftDiagnosticSchema
>;
export type PragmaAgentEvaluationDraftOperation = z.infer<
  typeof PragmaAgentEvaluationDraftOperationSchema
>;
export type PragmaAgentEvaluationDraftSummary = z.infer<
  typeof PragmaAgentEvaluationDraftSummarySchema
>;
export type PragmaAgentEvaluationDraftView = z.infer<typeof PragmaAgentEvaluationDraftViewSchema>;
export type PragmaAgentEvaluationDraftRunResult = z.infer<
  typeof PragmaAgentEvaluationDraftRunResultSchema
>;
export type PragmaAgentProjectCommit = z.infer<typeof PragmaAgentProjectCommitSchema>;
export type PragmaAgentTaskSummary = z.infer<typeof PragmaAgentTaskSummarySchema>;
export type PragmaAgentTask = z.infer<typeof PragmaAgentTaskSchema>;
export type PragmaAgentTaskWorkItem = z.infer<typeof PragmaAgentTaskWorkItemSchema>;
export type PragmaAgentAutomationSummary = z.infer<typeof PragmaAgentAutomationSummarySchema>;
