import { z } from "zod";
import {
  AgentEvaluationCaseResultSchema,
  AgentEvaluationJudgeResultSchema,
  AgentEvaluationSummarySchema,
} from "@pragma/evaluation/ast";
import { PragmaAgentJudgeEvaluationResourceSchema } from "@pragma/interpreter/ast";

import { ExpertModelConfigSchema } from "./capabilities.ts";

const EvaluationTargetRefSchema = z.string().regex(/^(expert|team):[0-9a-hjkmnp-tv-z]{16}$/);

export const EvaluationQueueSettingsSchema = z
  .object({
    schemaVersion: z.literal("pragma.evaluation-settings/v1"),
    revision: z.number().int().nonnegative(),
    concurrency: z.number().int().min(1).max(16),
    judge: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("inherit-default") }).strict(),
      z.object({ mode: z.literal("pinned"), model: ExpertModelConfigSchema }).strict(),
    ]),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const UpdateEvaluationQueueSettingsSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    concurrency: z.number().int().min(1).max(16).optional(),
    judge: EvaluationQueueSettingsSchema.shape.judge.optional(),
  })
  .strict()
  .refine((input) => input.concurrency !== undefined || input.judge !== undefined, {
    message: "At least one evaluation setting must change.",
  });

export const CreateAgentEvaluationRunSchema = z
  .object({
    projectRevision: z.number().int().positive(),
    evaluationRef: z.string().regex(/^evaluation:[0-9a-hjkmnp-tv-z]{16}$/),
    targetRef: EvaluationTargetRefSchema,
    sampleSize: z.number().int().positive().max(500),
    liveConfirmed: z.boolean().default(false),
  })
  .strict();

export const ImportAgentEvaluationDatasetYamlSchema = z
  .object({
    baseRevision: z.number().int().positive(),
    source: z.string().trim().min(1).max(2_000_000),
  })
  .strict();

export const AgentEvaluationTaskStatusSchema = z.enum([
  "queued",
  "running-subject",
  "running-judge",
  "resolved",
  "unresolved",
  "needs_attention",
  "cancelled",
]);

export const AgentEvaluationTaskSchema = z
  .object({
    caseId: z.string().min(1).max(100),
    caseName: z.string().min(1).max(200),
    status: AgentEvaluationTaskStatusSchema,
    attempt: z.number().int().positive(),
    result: AgentEvaluationCaseResultSchema.optional(),
    errorCode: z.string().min(1).max(200).optional(),
    error: z.string().min(1).max(10_000).optional(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    finishedAt: z.string().datetime().optional(),
  })
  .strict();

export const AgentEvaluationRunStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "needs_attention",
  "cancelled",
]);

export const AgentEvaluationRunSchema = z
  .object({
    schemaVersion: z.literal("pragma.agent-evaluation-run/v1"),
    id: z.string().uuid(),
    projectId: z.string().min(1).max(200),
    projectRevision: z.number().int().positive(),
    evaluationRef: z.string().regex(/^evaluation:[0-9a-hjkmnp-tv-z]{16}$/),
    evaluationName: z.string().min(1).max(200),
    group: z.string().min(1).max(100),
    executionMode: z.enum(["mock", "live"]),
    targetRef: EvaluationTargetRefSchema,
    targetName: z.string().min(1).max(200),
    selectionSeed: z.string().min(1).max(200),
    selectedCaseIds: z.array(z.string().min(1).max(100)).min(1).max(500),
    dataset: PragmaAgentJudgeEvaluationResourceSchema,
    judgeResultVersion: AgentEvaluationJudgeResultSchema.shape.schemaVersion,
    status: AgentEvaluationRunStatusSchema,
    tasks: z.array(AgentEvaluationTaskSchema).min(1).max(500),
    summary: AgentEvaluationSummarySchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
  })
  .strict();

export const AgentEvaluationRunRefSchema = z.object({ id: z.string().uuid() }).strict();

export const RetryAgentEvaluationTaskSchema = AgentEvaluationRunRefSchema.extend({
  caseId: z.string().min(1).max(100),
}).strict();

export type EvaluationQueueSettings = z.infer<typeof EvaluationQueueSettingsSchema>;
export type UpdateEvaluationQueueSettings = z.infer<typeof UpdateEvaluationQueueSettingsSchema>;
export type CreateAgentEvaluationRun = z.infer<typeof CreateAgentEvaluationRunSchema>;
export type ImportAgentEvaluationDatasetYaml = z.infer<
  typeof ImportAgentEvaluationDatasetYamlSchema
>;
export type AgentEvaluationTask = z.infer<typeof AgentEvaluationTaskSchema>;
export type AgentEvaluationRun = z.infer<typeof AgentEvaluationRunSchema>;
export type AgentEvaluationRunRef = z.infer<typeof AgentEvaluationRunRefSchema>;
export type RetryAgentEvaluationTask = z.infer<typeof RetryAgentEvaluationTaskSchema>;
