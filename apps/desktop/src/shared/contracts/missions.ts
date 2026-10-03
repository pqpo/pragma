export {
  MissionUserMessageSchema,
  MissionTimelineRecordSchema,
  MissionBaseSchema,
  MissionOriginSchema,
  MissionContextMountV10Schema,
  MissionBranchSourceSchema,
  MissionSchema,
  isUserFacingMissionOrigin,
  MissionAttachmentsManifestSchema,
  MissionHumanInteractionSchema,
  MissionChatEntrySchema,
  isMissionBranchableReply,
  latestMissionBranchableReply,
  MissionBranchHistorySchema,
  MissionWorkTaskSchema,
  MissionWorkRecordSchema,
  MissionWorkSnapshotSchema,
  MissionUpdateSchema,
  MissionStatusUpdateSchema,
  UpdateMissionOptionsSchema,
  UpdateMissionContextMountsSchema,
  MissionActionSchema,
  ResumeMissionQueueSchema,
  MissionExecutionActionSchema,
  CreateMissionBranchSchema,
  MissionQueuePromptActionSchema,
  GetMissionChatPageSchema,
  GetMissionWorkConversationSchema,
  OpenMissionWorkConversationStreamSchema,
  CloseMissionWorkConversationStreamSchema,
  SendMissionMessageSchema,
  MissionCommandReceiptSchema,
  MissionCommandOutcomeSchema,
  MissionQueueSteerResultSchema,
  MissionWorkConversationSnapshotSchema,
  OpenMissionWorkConversationStreamResultSchema,
  MissionWorkUpdateSchema,
  MissionChatExecutionSchema,
  MissionControlHealthSchema,
  MissionContextWindowUsageSchema,
  MissionContextWindowStateSchema,
  MissionContextCompactionResultSchema,
  MissionChatSyncIssueSchema,
  MissionChatPageSchema,
  MissionConversationStateSchema,
  MissionContextWindowSnapshotSchema,
  MissionConversationSnapshotSchema,
  MissionChatPatchSchema,
  MissionChatUpdateSchema,
  MissionWorkConversationStreamUpdateSchema,
  RespondMissionHumanInteractionSchema,
  MissionRepositorySummarySchema as MissionSummarySchema,
} from "@pragma/shared";
import {
  canonicalPragmaResourceRef,
  type PragmaInvocableResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import {
  ExpertPromptAttachmentSchema,
  MissionContextMountSchema,
  MissionContextMountsSchema,
  MissionExecutorRefSchema,
  MissionLifecycleStatusSchema,
  MissionExecutorSchema,
  type MissionExecutor,
} from "@pragma/shared";
import { z } from "zod";

import { MissionIdSchema, MissionModelOverrideSchema } from "./mission-base.ts";
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

export { MissionContextMountSchema, MissionContextMountsSchema, MissionLifecycleStatusSchema };

export const CreateMissionSchema = z.object({
  requestId: z.string().uuid().optional(),
  workspace: z.string().trim().min(1).max(2_000),
  contextMounts: MissionContextMountsSchema.refine(
    (mounts) =>
      mounts.every(
        (mount) => mount.kind !== "context-store-draft" || mount.revisionJobId === undefined,
      ),
    "Managed revision draft claims are Host-owned.",
  ).default([]),
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
