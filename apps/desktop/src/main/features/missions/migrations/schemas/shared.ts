import { z } from "zod";

const HistoricalMissionIdSchema = z.string().uuid();
const HistoricalMissionWorkspaceSchema = z.object({
  path: z.string().trim().min(1).max(2_000),
  basename: z.string().trim().min(1).max(255),
});
const HistoricalDesktopToolPermissionModeSchema = z.enum([
  "request-approval",
  "auto-approve",
  "full-access",
]);

export const HistoricalMissionExecutionStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);

const HistoricalMissionExecutorRefSchema = z
  .string()
  .trim()
  .regex(/^(expert|team|flow):[0-9a-hjkmnp-tv-z]{16}$/iu);
const HistoricalPragmaAutomationRefSchema = z
  .string()
  .trim()
  .regex(/^automation:[0-9a-hjkmnp-tv-z]{16}$/iu);

const HistoricalMissionExecutorBaseSchema = z.object({
  ref: HistoricalMissionExecutorRefSchema,
  name: z.string().trim().min(1).max(120),
});

const HistoricalMissionExecutorSchema = z.discriminatedUnion("kind", [
  HistoricalMissionExecutorBaseSchema.extend({ kind: z.literal("expert") }),
  HistoricalMissionExecutorBaseSchema.extend({ kind: z.literal("team") }),
  HistoricalMissionExecutorBaseSchema.extend({ kind: z.literal("flow") }),
]);

/** Frozen common fields for the v3-v9 storage family. */
export const HistoricalMissionBaseSchema = z.object({
  id: HistoricalMissionIdSchema,
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(100_000),
  initialMessageId: z.string().uuid(),
  toolPermissionMode: HistoricalDesktopToolPermissionModeSchema.default("request-approval"),
  workspace: HistoricalMissionWorkspaceSchema,
  project: z.object({
    id: z.string().trim().min(1),
    revision: z.number().int().positive(),
  }),
  executor: HistoricalMissionExecutorSchema,
  modelOverride: z
    .object({
      providerId: z.string().trim().min(1).max(200),
      modelId: z.string().trim().min(1),
      thinkingLevel: z.string().trim().min(1).max(100).optional(),
    })
    .strict()
    .optional(),
  execution: z
    .object({
      id: z.string().uuid(),
      inputMessageId: z.string().uuid(),
      sessionId: z.string().uuid().optional(),
      status: HistoricalMissionExecutionStatusSchema,
      waitReason: z.enum(["experts", "human_input"]).optional(),
      contextMountsFingerprint: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      startedAt: z.string().datetime(),
      finishedAt: z.string().datetime().optional(),
      error: z.string().max(10_000).optional(),
    })
    .optional(),
  lifecycleStatus: z.enum(["active", "completed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});

export const HistoricalMissionExecutorV4Schema = z.object({
  kind: z.enum(["expert", "team", "flow"]),
  ref: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(100),
});

export const HistoricalMissionBaseV4Schema = HistoricalMissionBaseSchema.extend({
  executor: HistoricalMissionExecutorV4Schema,
});

export const HistoricalMissionOriginSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user") }),
  z.object({
    type: z.literal("automation"),
    automationRef: HistoricalPragmaAutomationRefSchema,
  }),
  z.object({ type: z.literal("system-memory"), jobId: z.string().min(1) }),
  z.object({
    type: z.literal("system-store-revision"),
    jobId: z.string().uuid(),
    storeId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("system-skill-revision"),
    jobId: z.string().uuid(),
    capabilityId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("system-skill-evaluation"),
    jobId: z.string().min(1),
    phase: z.enum(["subject", "judge"]),
  }),
  z.object({
    type: z.literal("system-evaluation"),
    runId: z.string().uuid(),
    caseId: z.string().min(1).max(100),
    phase: z.enum(["subject", "judge"]),
  }),
]);

export const HistoricalMissionBranchSourceV9Schema = z.object({
  sourceMissionId: HistoricalMissionIdSchema,
  sourceProjectRevision: z.number().int().positive(),
  cutoffExecutionId: z.string().uuid().optional(),
  cutoffMessageId: z.string().min(1),
  createdAt: z.string().datetime(),
});

export function refineHistoricalFlowMission(
  mission: { readonly executor: { readonly kind: string }; readonly flowInput?: unknown },
  context: z.RefinementCtx,
): void {
  if (mission.executor.kind === "flow" && mission.flowInput === undefined) {
    context.addIssue({
      code: "custom",
      message: "Flow missions require flowInput.",
      path: ["flowInput"],
    });
  }
  if (mission.executor.kind !== "flow" && mission.flowInput !== undefined) {
    context.addIssue({
      code: "custom",
      message: "Only Flow missions may store flowInput.",
      path: ["flowInput"],
    });
  }
}
