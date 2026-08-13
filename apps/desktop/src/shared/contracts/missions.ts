import {
  HumanInteractionRequestSchema,
  HumanInteractionResponseSchema,
  ExpertPromptAttachmentSchema,
  MissionExecutorRefSchema,
  MissionExecutorSchema,
  PragmaAvatarIdSchema,
  RuntimeContextWindowUsageSchema,
  type MissionExecutor,
} from "@pragma/shared";
import {
  canonicalPragmaResourceRef,
  PragmaAutomationRefSchema,
  type PragmaInvocableResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import { z } from "zod";

import {
  MissionIdSchema,
  MissionModelOverrideSchema,
  MissionWorkspaceSchema,
} from "./mission-base.ts";
import { DesktopRuntimeIdSchema, DesktopRuntimeModelSchema } from "./runtime.ts";
import { DesktopToolPermissionModeSchema } from "./settings.ts";

export const MissionModelOptionsRequestSchema = z.object({
  executorRef: MissionExecutorRefSchema,
  missionId: MissionIdSchema.optional(),
});

export const MissionModelOptionsSchema = z.object({
  status: z.enum(["ready", "reset_required"]),
  runtime: z.object({
    id: DesktopRuntimeIdSchema,
    displayName: z.string().trim().min(1).max(200),
  }),
  models: z.array(DesktopRuntimeModelSchema),
  defaultSelection: MissionModelOverrideSchema.optional(),
});

export const MissionLifecycleStatusSchema = z.enum(["active", "completed"]);

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
  origin: z.enum(["core", "runtime"]),
  status: MissionWorkTaskSchema.shape.status,
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

const MissionExecutionStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);

const MissionBaseSchema = z.object({
  id: MissionIdSchema,
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(100_000),
  initialMessageId: z.string().uuid(),
  toolPermissionMode: DesktopToolPermissionModeSchema.default("request-approval"),
  workspace: MissionWorkspaceSchema,
  project: z.object({
    id: z.string().trim().min(1),
    revision: z.number().int().positive(),
  }),
  executor: MissionExecutorSchema,
  modelOverride: MissionModelOverrideSchema.optional(),
  execution: z
    .object({
      id: z.string().uuid(),
      inputMessageId: z.string().uuid(),
      sessionId: z.string().uuid().optional(),
      status: MissionExecutionStatusSchema,
      startedAt: z.string().datetime(),
      finishedAt: z.string().datetime().optional(),
      error: z.string().max(10_000).optional(),
    })
    .optional(),
  lifecycleStatus: MissionLifecycleStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});

const MissionExecutorV4Schema = z.object({
  kind: z.enum(["expert", "team", "flow"]),
  ref: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(100),
});

const MissionBaseV4Schema = MissionBaseSchema.extend({
  executor: MissionExecutorV4Schema,
});

export const MissionV3Schema = MissionBaseV4Schema.extend({
  schemaVersion: z.literal("pragma.mission/v3"),
});

export const MissionV4Schema = MissionBaseV4Schema.extend({
  schemaVersion: z.literal("pragma.mission/v4"),
  flowInput: z.record(z.string(), z.unknown()).optional(),
});

export const MissionV5Schema = MissionBaseSchema.extend({
  schemaVersion: z.literal("pragma.mission/v5"),
  flowInput: z.record(z.string(), z.unknown()).optional(),
});

export const MissionOriginSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user") }),
  z.object({
    type: z.literal("automation"),
    automationRef: PragmaAutomationRefSchema,
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

export const MissionV6Schema = MissionBaseSchema.extend({
  schemaVersion: z.literal("pragma.mission/v6"),
  flowInput: z.record(z.string(), z.unknown()).optional(),
  origin: z.discriminatedUnion("type", [
    z.object({ type: z.literal("user") }),
    z.object({ type: z.literal("system-memory"), jobId: z.string().min(1) }),
  ]),
});

export const MissionSchema = MissionBaseSchema.extend({
  schemaVersion: z.literal("pragma.mission/v7"),
  flowInput: z.record(z.string(), z.unknown()).optional(),
  origin: MissionOriginSchema.default({ type: "user" }),
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
});

export const MissionSummarySchema = z.object({
  id: MissionIdSchema,
  title: z.string().trim().min(1).max(120),
  workspace: z.object({ basename: z.string().trim().min(1).max(255) }),
  executor: z.object({
    kind: z.enum(["expert", "team", "flow"]),
    name: z.string().trim().min(1).max(120),
  }),
  execution: z.object({ status: MissionExecutionStatusSchema }).optional(),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("task") }),
    z.object({
      type: z.literal("automation"),
      automationRef: PragmaAutomationRefSchema,
    }),
  ]),
  lifecycleStatus: MissionLifecycleStatusSchema,
  updatedAt: z.string().datetime(),
});

export const MissionUpdateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("upsert"),
    mission: MissionSchema,
    source: MissionSummarySchema.shape.source,
  }),
  z.object({
    kind: z.literal("remove"),
    missionId: MissionIdSchema,
  }),
]);

export function isUserFacingMissionOrigin(origin: z.infer<typeof MissionOriginSchema>): boolean {
  return origin.type === "user" || origin.type === "automation";
}

export const CreateMissionSchema = z.object({
  workspace: z.string().trim().min(1).max(2_000),
  executor: z.object({
    ref: MissionExecutorRefSchema,
  }),
  input: z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("prompt"),
        value: z.string().trim().min(1).max(100_000),
        attachments: z.array(ExpertPromptAttachmentSchema).max(20).default([]),
      })
      .strict(),
    z
      .object({
        kind: z.literal("flow"),
        value: z.record(z.string(), z.unknown()),
      })
      .strict(),
  ]),
  toolPermissionMode: DesktopToolPermissionModeSchema.optional(),
  modelOverride: MissionModelOverrideSchema.optional(),
});

export const PickMissionAttachmentsSchema = z.object({
  kind: z.enum(["image", "file", "directory"]),
});

export const PickMissionAttachmentsResultSchema = z.object({
  attachments: z.array(ExpertPromptAttachmentSchema).max(20),
  previews: z
    .array(
      z.object({
        attachmentId: z.string().uuid(),
        dataUrl: z.string().startsWith("data:image/").max(512_000),
      }),
    )
    .max(20)
    .default([]),
});

export const DiscardMissionAttachmentDraftsSchema = z.object({
  attachmentIds: z.array(z.string().uuid()).max(20),
});

export const StageMissionClipboardImageSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.enum(["image/gif", "image/jpeg", "image/png", "image/webp"]),
  data: z
    .string()
    .min(1)
    .max(28_000_000)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/u),
});

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

export const UpdateMissionOptionsSchema = z.object({
  id: MissionIdSchema,
  toolPermissionMode: DesktopToolPermissionModeSchema,
  modelOverride: MissionModelOverrideSchema.nullable(),
});

export function isMissionExecutorResource(
  resource: PragmaResource,
): resource is PragmaInvocableResource {
  return resource.kind === "Expert" || resource.kind === "ExpertTeam" || resource.kind === "Flow";
}

export function missionExecutorKind(resource: PragmaInvocableResource): "expert" | "team" | "flow" {
  switch (resource.kind) {
    case "Expert":
      return "expert";
    case "ExpertTeam":
      return "team";
    case "Flow":
      return "flow";
  }
}

export function missionExecutorRef(resource: PragmaInvocableResource): string {
  return canonicalPragmaResourceRef(resource);
}

export function missionExecutorSnapshot(resource: PragmaInvocableResource): MissionExecutor {
  return MissionExecutorSchema.parse({
    kind: missionExecutorKind(resource),
    ref: missionExecutorRef(resource),
    name: resource.metadata.name,
  });
}

export const MissionActionSchema = z.object({ id: MissionIdSchema });
export const GetMissionChatSchema = z.object({
  id: MissionIdSchema,
  beforeSequence: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export const GetMissionWorkConversationSchema = z.object({
  id: MissionIdSchema,
  recordId: z.string().min(1),
  beforeCursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export const SendMissionMessageSchema = z.object({
  id: MissionIdSchema,
  content: z.string().trim().min(1).max(100_000),
  requestId: z.string().uuid(),
  attachments: z.array(ExpertPromptAttachmentSchema).max(20).default([]),
});
export const MissionHumanInteractionSchema = z.object({
  interactionId: z.string().min(1),
  request: HumanInteractionRequestSchema,
});

const MissionChatEntryBaseSchema = z.object({
  id: z.string().min(1),
  timelineSequence: z.number().int().positive().optional(),
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
  }),
  MissionChatEntryBaseSchema.extend({
    kind: z.literal("assistant"),
    content: z.string().max(200_000),
    streaming: z.boolean().default(false),
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
    runtimeId: DesktopRuntimeIdSchema,
    status: z.enum(["running", "succeeded", "failed"]),
    error: z.string().max(10_000).optional(),
  }),
]);

export const MISSION_ATTACHMENT_PREVIEW_SCHEME = "pragma-mission-attachment";

export function missionAttachmentPreviewUrl(missionId: string, attachmentId: string): string {
  return `${MISSION_ATTACHMENT_PREVIEW_SCHEME}://preview/${encodeURIComponent(missionId)}/${encodeURIComponent(attachmentId)}`;
}

export function missionAttachmentOriginalUrl(missionId: string, attachmentId: string): string {
  return `${MISSION_ATTACHMENT_PREVIEW_SCHEME}://original/${encodeURIComponent(missionId)}/${encodeURIComponent(attachmentId)}`;
}

export function missionAttachmentDraftOriginalUrl(attachmentId: string): string {
  return `${MISSION_ATTACHMENT_PREVIEW_SCHEME}://draft-original/${encodeURIComponent(attachmentId)}`;
}

export const MissionWorkConversationSnapshotSchema = z.object({
  missionId: MissionIdSchema,
  recordId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  entries: z.array(MissionChatEntrySchema),
  nextBeforeCursor: z.string().min(1).optional(),
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

export const MissionChatSnapshotSchema = z.object({
  missionId: MissionIdSchema,
  revision: z.number().int().nonnegative(),
  entries: z.array(MissionChatEntrySchema),
  page: z.object({
    oldestSequence: z.number().int().positive().optional(),
    newestSequence: z.number().int().positive().optional(),
    nextBeforeSequence: z.number().int().positive().optional(),
  }),
  pendingInteractions: z.array(MissionHumanInteractionSchema),
  execution: MissionChatExecutionSchema.optional(),
  contextWindow: MissionContextWindowStateSchema.optional(),
  syncIssues: z.array(MissionChatSyncIssueSchema).max(3).optional(),
});

export const MissionChatPatchSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("entry.upsert"),
    entry: MissionChatEntrySchema,
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
  revision: z.number().int().positive(),
});

export const MissionChatUpdateSchema = z.discriminatedUnion("kind", [
  MissionChatUpdateBaseSchema.extend({
    kind: z.literal("patch"),
    patches: z.array(MissionChatPatchSchema).min(1),
  }),
  MissionChatUpdateBaseSchema.extend({
    kind: z.literal("invalidate"),
  }),
]);

export const RespondMissionHumanInteractionSchema = z.object({
  missionId: MissionIdSchema,
  interactionId: z.string().min(1),
  requestId: z.string().uuid(),
  response: HumanInteractionResponseSchema,
});
