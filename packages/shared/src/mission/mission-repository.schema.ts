import { MissionIdSchema } from "../integration/primitives.schema.ts";
import { RuntimeContextWindowUsageSchema } from "../runtime-context-window.schema.ts";
import { IntegrationErrorSchema } from "../integration/error.schema.ts";
import { MissionQueueSteerOutcomeSchema } from "../integration/contracts.schema.ts";
import { z } from "zod";
import { ExpertPromptAttachmentSchema } from "../expert-prompt.schema.ts";
import {
  HumanInteractionRequestSchema,
  HumanInteractionResponseSchema,
} from "../execution/human-interaction.schema.ts";
import { PragmaAvatarIdSchema } from "../avatar.ts";
import { CapabilityIdSchema } from "../resources/capability.schema.ts";
import { ContextStoreIdSchema } from "../resources/context-store.schema.ts";
import { ToolPermissionModeSchema } from "../tool-permission.schema.ts";
import { MissionExecutorSchema, MissionExecutorRefSchema } from "./mission-executor.schema.ts";
import {
  MissionWorkspaceSchema,
  MissionModelOverrideSchema,
  MissionExecutionBindingSchema,
  MissionLifecycleStatusSchema,
  MissionContextMountsSchema,
} from "./mission-values.schema.ts";

const MissionExecutionStatusSchema = MissionExecutionBindingSchema.shape.status;
const MissionRuntimeIdSchema = z.string().trim().min(1).max(200);
const MissionAutomationRefSchema = z
  .string()
  .trim()
  .regex(/^automation:[0-9a-hjkmnp-tv-z]{16}$/i);

export const MissionUserMessageSchema = z.object({
  id: z.string().uuid(),
  content: z.string().min(1).max(100_000),
  attachments: z.array(ExpertPromptAttachmentSchema).max(20).optional(),
  createdAt: z.string().datetime(),
});

export const MissionTimelineRecordSchema = z.discriminatedUnion("kind", [
  MissionUserMessageSchema.extend({
    schemaVersion: z.literal("pragma.mission-message/v1"),
    sequence: z.number().int().positive(),
    kind: z.literal("user"),
  }),
  z.object({
    schemaVersion: z.literal("pragma.mission-message/v1"),
    sequence: z.number().int().positive(),
    kind: z.literal("execution"),
    inputMessageId: z.string().uuid(),
    executionId: z.string().uuid(),
    createdAt: z.string().datetime(),
  }),
]);

export const MissionBaseSchema = z.object({
  id: MissionIdSchema,
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(100_000),
  initialMessageId: z.string().uuid(),
  toolPermissionMode: ToolPermissionModeSchema.default("request-approval"),
  workspace: MissionWorkspaceSchema,
  project: z.object({
    id: z.string().trim().min(1),
    revision: z.number().int().positive(),
  }),
  executor: MissionExecutorSchema,
  modelOverride: MissionModelOverrideSchema.optional(),
  execution: MissionExecutionBindingSchema.optional(),
  lifecycleStatus: MissionLifecycleStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});

export const MissionOriginSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user") }),
  z.object({
    type: z.literal("automation"),
    automationRef: MissionAutomationRefSchema,
  }),
  z.object({
    type: z.literal("system-memory"),
    jobId: z.string().min(1),
  }),
  z.object({
    type: z.literal("system-store-revision"),
    jobId: z.string().uuid(),
    storeId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("system-skill-revision"),
    jobId: z.string().uuid(),
    capabilityId: CapabilityIdSchema,
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

export const MissionContextMountV10Schema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("context-store"),
      storeId: ContextStoreIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("context-store-draft"),
      draftId: z.string().uuid(),
      revisionJobId: z.string().uuid().optional(),
    })
    .strict(),
]);

export const MissionBranchSourceSchema = z.object({
  sourceMissionId: MissionIdSchema,
  sourceProjectRevision: z.number().int().positive(),
  cutoffExecutionId: z.string().uuid().optional(),
  cutoffMessageId: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const MissionSchema = MissionBaseSchema.extend({
  schemaVersion: z.literal("pragma.mission/v11"),
  flowInput: z.record(z.string(), z.unknown()).optional(),
  origin: MissionOriginSchema.default({ type: "user" }),
  contextMounts: MissionContextMountsSchema,
  branch: MissionBranchSourceSchema.optional(),
}).superRefine((mission, context) => {
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
  if (mission.branch !== undefined && mission.executor.kind === "flow") {
    context.addIssue({
      code: "custom",
      message: "Flow missions cannot be conversation branches.",
      path: ["branch"],
    });
  }
});

export const MissionRepositorySummarySchema = z.object({
  id: MissionIdSchema,
  title: z.string().trim().min(1).max(120),
  workspace: z.object({ basename: z.string().trim().min(1).max(255) }),
  executor: z.object({
    kind: z.enum(["expert", "team", "flow"]),
    name: z.string().trim().min(1).max(120),
    ref: MissionExecutorRefSchema.optional(),
  }),
  execution: z
    .object({
      id: z.string().uuid().optional(),
      status: MissionExecutionStatusSchema,
      waitReason: z.enum(["experts", "human_input"]).optional(),
    })
    .optional(),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("internal") }),
    z.object({ type: z.literal("task") }),
    z.object({
      type: z.literal("automation"),
      automationRef: MissionAutomationRefSchema,
    }),
    z.object({
      type: z.literal("managed-automation"),
      kind: z.enum(["knowledge-revision", "skill-revision"]),
      jobId: z.string().uuid(),
      storeId: z.string().uuid().optional(),
      capabilityId: CapabilityIdSchema.optional(),
    }),
  ]),
  lifecycleStatus: MissionLifecycleStatusSchema,
  updatedAt: z.string().datetime(),
});

export function isUserFacingMissionOrigin(origin: z.infer<typeof MissionOriginSchema>): boolean {
  return (
    origin.type === "user" ||
    origin.type === "automation" ||
    origin.type === "system-store-revision" ||
    origin.type === "system-skill-revision"
  );
}

export const MissionAttachmentsManifestSchema = z
  .object({
    schemaVersion: z.literal("pragma.mission-attachments/v1"),
    attachments: z.array(ExpertPromptAttachmentSchema).max(20),
  })
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    for (const [index, attachment] of manifest.attachments.entries()) {
      if (ids.has(attachment.id)) {
        context.addIssue({
          code: "custom",
          path: ["attachments", index, "id"],
          message: "Mission attachment ids must be unique.",
        });
      }
      ids.add(attachment.id);
    }
  });

export const MissionHumanInteractionSchema = z.object({
  interactionId: z.string().min(1),
  request: HumanInteractionRequestSchema,
});

const MissionChatEntryBaseSchema = z.object({
  id: z.string().min(1),
  timelineSequence: z.number().int().positive().optional(),
  eventSequence: z.number().int().nonnegative().optional(),
  executionId: z.string().min(1).optional(),
  invocationId: z.string().min(1).optional(),
  executorId: z.string().min(1).optional(),
  executorName: z.string().min(1).optional(),
  executorAvatarId: PragmaAvatarIdSchema.optional(),
  createdAt: z.string().datetime(),
});

export const MissionChatEntrySchema = z.discriminatedUnion("kind", [
  MissionChatEntryBaseSchema.extend({
    kind: z.literal("user"),
    content: z.string().max(200_000),
    attachments: z.array(ExpertPromptAttachmentSchema).max(20).optional(),
    delivery: z
      .object({
        requestedMode: z.enum(["enqueue", "steer"]),
        effectiveMode: z.enum(["enqueue", "steer"]),
        status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]),
        activatedAt: z.string().datetime().optional(),
        fallbackReason: z.string().min(1).optional(),
        removed: z.boolean().optional(),
      })
      .optional(),
  }),
  MissionChatEntryBaseSchema.extend({
    kind: z.literal("assistant"),
    content: z.string().max(200_000),
    streaming: z.boolean().default(false),
    finalAnswer: z.boolean().optional(),
  }),
  MissionChatEntryBaseSchema.extend({
    kind: z.literal("thinking"),
    content: z.string().max(200_000),
    streaming: z.boolean().default(false),
  }),
  MissionChatEntryBaseSchema.extend({
    kind: z.literal("tool"),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    status: z.enum(["running", "approval_required", "succeeded", "failed"]),
    inputPreview: z.string().max(801).optional(),
    outputPreview: z.string().max(801).optional(),
    error: z.string().max(10_000).optional(),
  }),
  MissionChatEntryBaseSchema.extend({
    kind: z.literal("agent_activity"),
    commandId: z.string().min(1),
    action: z.enum(["spawn", "wait", "list", "send", "resume", "interrupt", "run"]),
    phase: z.enum(["started", "completed", "failed"]),
    senderSessionId: z.string().min(1).optional(),
    targetSessionIds: z.array(z.string().min(1)).default([]),
    label: z.string().max(500).optional(),
    error: z.string().max(10_000).optional(),
  }),
  MissionChatEntryBaseSchema.extend({
    kind: z.literal("context_operation"),
    operationId: z.string().min(1),
    operation: z.literal("compaction"),
    trigger: z.enum(["auto", "manual", "overflow", "unknown"]),
    runtimeId: MissionRuntimeIdSchema,
    status: z.enum(["running", "succeeded", "failed"]),
    error: z.string().max(10_000).optional(),
  }),
]);

type MissionChatEntryValue = z.infer<typeof MissionChatEntrySchema>;
type MissionAssistantEntryValue = Extract<MissionChatEntryValue, { readonly kind: "assistant" }>;

const SYNTHETIC_MISSION_REPLY_ID = /(?:^|:)(?:missing|result):[^:]+$/;

export function isMissionBranchableReply(
  entry: MissionChatEntryValue,
): entry is MissionAssistantEntryValue {
  return (
    entry.kind === "assistant" &&
    entry.streaming === false &&
    !SYNTHETIC_MISSION_REPLY_ID.test(entry.id)
  );
}

export function latestMissionBranchableReply(
  entries: readonly MissionChatEntryValue[],
): MissionAssistantEntryValue | undefined {
  return [...entries].reverse().find(isMissionBranchableReply);
}

export const MissionBranchHistorySchema = z.object({
  schemaVersion: z.literal("pragma.mission-branch-history/v1"),
  source: MissionBranchSourceSchema,
  entries: z.array(MissionChatEntrySchema),
});

export type Mission = z.infer<typeof MissionSchema>;
export type MissionOrigin = z.infer<typeof MissionOriginSchema>;
export type MissionUserMessage = z.infer<typeof MissionUserMessageSchema>;
export type MissionTimelineRecord = z.infer<typeof MissionTimelineRecordSchema>;
export type MissionAttachmentsManifest = z.infer<typeof MissionAttachmentsManifestSchema>;
export type MissionBranchHistory = z.infer<typeof MissionBranchHistorySchema>;
export type MissionBranchSource = z.infer<typeof MissionBranchSourceSchema>;
export type MissionChatEntry = z.infer<typeof MissionChatEntrySchema>;
export type MissionHumanInteraction = z.infer<typeof MissionHumanInteractionSchema>;
export type MissionRepositorySummary = z.infer<typeof MissionRepositorySummarySchema>;
export const MissionWorkTaskSchema = z.object({
  taskId: z.string().min(1),
  executionId: z.string().min(1),
  invocationId: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().nonnegative().optional(),
  status: z.enum([
    "queued",
    "running",
    "waiting",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  waitReason: z.enum(["experts", "human_input"]).optional(),
  inputSummary: z.string().max(500),
  outputSummary: z.string().max(1_000).optional(),
  error: z.string().max(10_000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const MissionWorkRecordSchema = z.object({
  recordId: z.string().min(1),
  kind: z.enum(["root", "agent", "runtime-agent", "flow", "task", "human-task"]),
  sessionId: z.string().min(1),
  parentRecordId: z.string().min(1).optional(),
  title: z.string().min(1),
  fallbackOrdinal: z.number().int().positive().optional(),
  executorId: z.string().min(1).optional(),
  avatarId: z.string().min(1).optional(),
  origin: z.enum(["core", "runtime"]),
  status: MissionWorkTaskSchema.shape.status,
  waitReason: MissionWorkTaskSchema.shape.waitReason,
  tasks: z.array(MissionWorkTaskSchema),
  summary: z.string().max(1_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const MissionWorkSnapshotSchema = z.object({
  missionId: MissionIdSchema,
  revision: z.number().int().nonnegative(),
  records: z.array(MissionWorkRecordSchema),
});

export const MissionUpdateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("upsert"),
    mission: MissionSchema,
    source: MissionRepositorySummarySchema.shape.source,
  }),
  z.object({
    kind: z.literal("remove"),
    missionId: MissionIdSchema,
  }),
]);

export const MissionStatusUpdateSchema = z.object({
  missionId: MissionIdSchema,
  revision: z.number().int().positive(),
  execution: z
    .object({
      id: z.string().uuid(),
      status: MissionExecutionStatusSchema,
    })
    .optional(),
});

/** Detail/interaction access only. Top-level list placement is resolved by the Host. */

export const UpdateMissionOptionsSchema = z.object({
  id: MissionIdSchema,
  toolPermissionMode: ToolPermissionModeSchema,
  modelOverride: MissionModelOverrideSchema.nullable(),
});

export const UpdateMissionContextMountsSchema = z.object({
  id: MissionIdSchema,
  contextMounts: MissionContextMountsSchema,
});

export const MissionActionSchema = z.object({ id: MissionIdSchema });
export const ResumeMissionQueueSchema = MissionActionSchema.extend({
  recovery: z.literal("abandon").optional(),
});
export const MissionExecutionActionSchema = z
  .object({
    id: MissionIdSchema,
    requestId: z.string().uuid(),
    expectedExecutionId: z.string().uuid(),
  })
  .strict();
export const CreateMissionBranchSchema = z.object({
  sourceMissionId: MissionIdSchema,
  expectedExecutionId: z.string().uuid().nullable(),
  expectedMessageId: z.string().min(1),
});
export const MissionQueuePromptActionSchema = z
  .object({
    id: MissionIdSchema,
    requestId: z.string().uuid(),
    queueItemRequestId: z.string().uuid(),
  })
  .refine((input) => input.requestId !== input.queueItemRequestId, {
    message: "Queue actions require a requestId distinct from the queue item requestId.",
    path: ["requestId"],
  });
export const GetMissionChatPageSchema = z.object({
  id: MissionIdSchema,
  beforeCursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(50),
});
export const GetMissionWorkConversationSchema = z.object({
  id: MissionIdSchema,
  recordId: z.string().min(1),
  beforeCursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export const OpenMissionWorkConversationStreamSchema = z.object({
  subscriptionId: z.string().uuid(),
  missionId: MissionIdSchema,
  recordId: z.string().min(1),
  limit: z.number().int().min(1).max(200).default(100),
});
export const CloseMissionWorkConversationStreamSchema = z.object({
  subscriptionId: z.string().uuid(),
});
export const SendMissionMessageSchema = z.object({
  id: MissionIdSchema,
  content: z.string().trim().min(1).max(100_000),
  requestId: z.string().uuid(),
  attachments: z.array(ExpertPromptAttachmentSchema).max(20).default([]),
  mode: z.enum(["enqueue", "steer"]).default("enqueue"),
});

export const MissionCommandReceiptSchema = z.object({
  schemaVersion: z.literal("pragma.desktop-mission-command-receipt/v1"),
  missionId: MissionIdSchema,
  requestId: z.string().uuid(),
  kind: z.enum([
    "send",
    "steer",
    "respond",
    "interrupt",
    "queue.remove",
    "queue.resume",
    "queue.steer",
    "queue.try-steer",
  ]),
  state: z.enum(["queued", "accepted", "applying", "applied", "rejected", "expired", "failed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  requestedMode: z.enum(["enqueue", "steer"]),
});

export const MissionCommandOutcomeSchema = z.object({
  schemaVersion: z.literal("pragma.desktop-mission-command-outcome/v1"),
  missionId: MissionIdSchema,
  requestId: z.string().uuid(),
  state: z.enum(["applied", "rejected"]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: IntegrationErrorSchema.optional(),
});

export const MissionQueueSteerResultSchema = z.object({
  mission: MissionSchema,
  queueSteer: MissionQueueSteerOutcomeSchema,
});

export const MissionWorkConversationSnapshotSchema = z.object({
  missionId: MissionIdSchema,
  recordId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  entries: z.array(MissionChatEntrySchema),
  nextBeforeCursor: z.string().min(1).optional(),
});

export const OpenMissionWorkConversationStreamResultSchema = z.object({
  subscriptionId: z.string().uuid(),
  streamId: z.string().uuid(),
  snapshot: MissionWorkConversationSnapshotSchema,
});

export const MissionWorkUpdateSchema = z.object({
  missionId: MissionIdSchema,
  revision: z.number().int().positive(),
});

export const MissionChatExecutionSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]),
  interruptible: z.boolean(),
  error: z.string().max(10_000).optional(),
});

export const MissionControlHealthSchema = z.object({
  state: z.enum([
    "idle",
    "healthy_active",
    "reconciling",
    "orphaned",
    "interrupt_uncertain",
    "recovery_failed",
    "deletion_pending",
  ]),
  reasonCode: z.string().min(1).optional(),
  executionId: z.string().uuid().optional(),
  observedAt: z.string().datetime(),
  staleSince: z.string().datetime().optional(),
  availableActions: z.array(z.enum(["recover", "force_interrupt", "force_remove"])),
});

export const MissionContextWindowUsageSchema = RuntimeContextWindowUsageSchema;

export const MissionContextWindowStateSchema = z.object({
  supportsInspection: z.boolean(),
  supportsCompaction: z.boolean(),
  canCompact: z.boolean(),
  compactionBlockedReason: z.enum(["not_ready", "busy", "inactive", "not_started"]).optional(),
  usage: MissionContextWindowUsageSchema.optional(),
});

export const MissionContextCompactionResultSchema = z.object({
  outcome: z.enum(["compacted", "not_needed"]),
  contextWindow: MissionContextWindowStateSchema,
});

export const MissionChatSyncIssueSchema = z.object({
  code: z.literal("execution_state_unavailable"),
  section: z.enum(["history", "pending_interactions", "context_window"]),
  retryable: z.literal(true),
});

const MissionChatPageInfoSchema = z.object({
  oldestSequence: z.number().int().positive().optional(),
  newestSequence: z.number().int().positive().optional(),
  nextBeforeCursor: z.string().min(1).max(2_048).optional(),
  truncation: z
    .object({
      omittedEntries: z.number().int().nonnegative(),
      truncatedFields: z.number().int().nonnegative(),
    })
    .optional(),
});

const MissionMessageDeliverySchema = z.object({
  requestedMode: z.enum(["enqueue", "steer"]),
  effectiveMode: z.enum(["enqueue", "steer"]),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]),
  activatedAt: z.string().datetime().optional(),
  fallbackReason: z.string().min(1).optional(),
  removed: z.boolean().optional(),
});

export const MissionChatPageSchema = z.object({
  sourceVerification: z.enum(["verified", "pending", "unavailable"]).optional(),
  missionId: MissionIdSchema,
  revision: z.number().int().nonnegative(),
  entries: z.array(MissionChatEntrySchema),
  page: MissionChatPageInfoSchema,
  syncIssues: z.array(MissionChatSyncIssueSchema).max(1).optional(),
});

export const MissionConversationStateSchema = z.object({
  missionId: MissionIdSchema,
  revision: z.number().int().nonnegative(),
  pendingInteractions: z.array(MissionHumanInteractionSchema),
  queue: z
    .object({
      state: z.enum(["idle", "running", "paused"]),
      pendingCount: z.number().int().nonnegative(),
      supportsSteer: z.boolean().default(false),
      deliveryUncertain: z.boolean().optional(),
      steeringRecovery: z.enum(["receipt", "terminal"]).optional(),
      items: z
        .array(
          z.object({
            requestId: z.string().uuid(),
            content: z.string().min(1).max(100_000),
            hasAttachments: z.boolean(),
            deliveryUncertain: z.boolean().optional(),
          }),
        )
        .default([]),
      pausedAfterRequestId: z.string().min(1).optional(),
    })
    .optional(),
  execution: MissionChatExecutionSchema.optional(),
  controlHealth: MissionControlHealthSchema.optional(),
  deliveries: z
    .array(
      z.object({
        entryId: z.string().min(1),
        delivery: MissionMessageDeliverySchema,
      }),
    )
    .default([]),
  hiddenEntryIds: z.array(z.string().min(1)).default([]),
  syncIssues: z.array(MissionChatSyncIssueSchema).max(1).optional(),
});

export const MissionContextWindowSnapshotSchema = z.object({
  missionId: MissionIdSchema,
  revision: z.number().int().nonnegative(),
  contextWindow: MissionContextWindowStateSchema.optional(),
  syncIssues: z.array(MissionChatSyncIssueSchema).max(1).optional(),
});

/** Renderer-side aggregate assembled progressively from the independent read models. */
export const MissionConversationSnapshotSchema = z.object({
  sourceVerification: z.enum(["verified", "pending", "unavailable"]).optional(),
  missionId: MissionIdSchema,
  revision: z.number().int().nonnegative(),
  stateRevision: z.number().int().nonnegative().optional(),
  // Control responses cannot predate an already consumed control-affecting update.
  controlRevision: z.number().int().nonnegative().optional(),
  queueRevision: z.number().int().nonnegative().optional(),
  contextRevision: z.number().int().nonnegative().optional(),
  entries: z.array(MissionChatEntrySchema),
  page: MissionChatPageInfoSchema,
  pendingInteractions: z.array(MissionHumanInteractionSchema),
  queue: MissionConversationStateSchema.shape.queue,
  execution: MissionChatExecutionSchema.optional(),
  controlHealth: MissionControlHealthSchema.optional(),
  contextWindow: MissionContextWindowStateSchema.optional(),
  syncIssues: z.array(MissionChatSyncIssueSchema).max(3).optional(),
});

export const MissionChatPatchSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("queue.update"),
    queue: MissionConversationStateSchema.shape.queue.unwrap(),
  }),
  z.object({
    type: z.literal("entry.upsert"),
    entry: MissionChatEntrySchema,
    beforeEntryId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("entry.append"),
    entryId: z.string().min(1),
    field: z.enum(["content", "outputPreview"]),
    delta: z.string().max(200_000),
  }),
  z.object({
    type: z.literal("entry.streaming"),
    entryId: z.string().min(1),
    streaming: z.boolean(),
  }),
  z.object({
    type: z.literal("context-window.update"),
    usage: MissionContextWindowUsageSchema,
  }),
]);

const MissionChatUpdateBaseSchema = z.object({
  missionId: MissionIdSchema,
  streamId: z.string().uuid(),
  revision: z.number().int().positive(),
});

export const MissionChatUpdateSchema = z.discriminatedUnion("kind", [
  MissionChatUpdateBaseSchema.extend({
    kind: z.literal("patch"),
    patches: z.array(MissionChatPatchSchema).min(1),
  }),
  MissionChatUpdateBaseSchema.extend({
    kind: z.literal("invalidate"),
    userVisibleOutput: z.literal(true).optional(),
  }),
]);

export const MissionWorkConversationStreamUpdateSchema = z.discriminatedUnion("kind", [
  z.object({
    subscriptionId: z.string().uuid(),
    streamId: z.string().uuid(),
    sequence: z.number().int().positive(),
    missionId: MissionIdSchema,
    recordId: z.string().min(1),
    kind: z.literal("patch"),
    patches: z.array(MissionChatPatchSchema).min(1),
  }),
  z.object({
    subscriptionId: z.string().uuid(),
    streamId: z.string().uuid(),
    sequence: z.number().int().positive(),
    missionId: MissionIdSchema,
    recordId: z.string().min(1),
    kind: z.literal("invalidate"),
  }),
]);

export const RespondMissionHumanInteractionSchema = z.object({
  missionId: MissionIdSchema,
  interactionId: z.string().min(1),
  requestId: z.string().uuid(),
  response: HumanInteractionResponseSchema,
});

export type MissionWorkTask = z.infer<typeof MissionWorkTaskSchema>;
export type MissionWorkRecord = z.infer<typeof MissionWorkRecordSchema>;
export type MissionWorkSnapshot = z.infer<typeof MissionWorkSnapshotSchema>;
export type MissionUpdate = z.infer<typeof MissionUpdateSchema>;
export type MissionStatusUpdate = z.infer<typeof MissionStatusUpdateSchema>;
export type UpdateMissionOptions = z.infer<typeof UpdateMissionOptionsSchema>;
export type UpdateMissionContextMounts = z.infer<typeof UpdateMissionContextMountsSchema>;
export type MissionAction = z.infer<typeof MissionActionSchema>;
export type ResumeMissionQueue = z.infer<typeof ResumeMissionQueueSchema>;
export type MissionExecutionAction = z.infer<typeof MissionExecutionActionSchema>;
export type CreateMissionBranch = z.infer<typeof CreateMissionBranchSchema>;
export type MissionQueuePromptAction = z.infer<typeof MissionQueuePromptActionSchema>;
export type GetMissionChatPage = z.infer<typeof GetMissionChatPageSchema>;
export type GetMissionWorkConversation = z.infer<typeof GetMissionWorkConversationSchema>;
export type OpenMissionWorkConversationStream = z.infer<
  typeof OpenMissionWorkConversationStreamSchema
>;
export type CloseMissionWorkConversationStream = z.infer<
  typeof CloseMissionWorkConversationStreamSchema
>;
export type SendMissionMessage = z.infer<typeof SendMissionMessageSchema>;
export type MissionCommandReceipt = z.infer<typeof MissionCommandReceiptSchema>;
export type MissionCommandOutcome = z.infer<typeof MissionCommandOutcomeSchema>;
export type MissionQueueSteerResult = z.infer<typeof MissionQueueSteerResultSchema>;
export type MissionWorkConversationSnapshot = z.infer<typeof MissionWorkConversationSnapshotSchema>;
export type OpenMissionWorkConversationStreamResult = z.infer<
  typeof OpenMissionWorkConversationStreamResultSchema
>;
export type MissionWorkUpdate = z.infer<typeof MissionWorkUpdateSchema>;
export type MissionChatExecution = z.infer<typeof MissionChatExecutionSchema>;
export type MissionControlHealth = z.infer<typeof MissionControlHealthSchema>;
export type MissionContextWindowUsage = z.infer<typeof MissionContextWindowUsageSchema>;
export type MissionContextWindowState = z.infer<typeof MissionContextWindowStateSchema>;
export type MissionContextCompactionResult = z.infer<typeof MissionContextCompactionResultSchema>;
export type MissionChatSyncIssue = z.infer<typeof MissionChatSyncIssueSchema>;
export type MissionChatPage = z.infer<typeof MissionChatPageSchema>;
export type MissionConversationState = z.infer<typeof MissionConversationStateSchema>;
export type MissionContextWindowSnapshot = z.infer<typeof MissionContextWindowSnapshotSchema>;
export type MissionConversationSnapshot = z.infer<typeof MissionConversationSnapshotSchema>;
export type MissionChatPatch = z.infer<typeof MissionChatPatchSchema>;
export type MissionChatUpdate = z.infer<typeof MissionChatUpdateSchema>;
export type MissionWorkConversationStreamUpdate = z.infer<
  typeof MissionWorkConversationStreamUpdateSchema
>;
export type RespondMissionHumanInteraction = z.infer<typeof RespondMissionHumanInteractionSchema>;
export type MissionChatPageQuery = z.output<typeof GetMissionChatPageSchema>;
