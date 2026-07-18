import { PragmaDiagnosticSchema, PragmaSemanticResourceRefSchema } from "@pragma/interpreter/ast";
import {
  HumanInteractionRequestSchema,
  HumanInteractionResponseSchema,
  PromptRuntimeModelSelectionSchema,
} from "@pragma/shared";
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

export const StewardSessionStateSchema = z.object({
  schemaVersion: z.literal("pragma.steward-state/v1"),
  sessionId: z.string().min(1),
  runtimeId: z.string().min(1),
  status: z.enum(["idle", "running", "waiting", "failed"]),
  modelSelection: PromptRuntimeModelSelectionSchema.optional(),
  workspace: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const StewardChatEntrySchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "thinking", "tool"]),
  content: z.string(),
  toolName: z.string().min(1).optional(),
  isError: z.boolean().optional(),
  createdAt: z.string().datetime(),
});

export const StewardChatSnapshotSchema = z.object({
  state: StewardSessionStateSchema.nullable(),
  entries: z.array(StewardChatEntrySchema),
});

export const StewardInteractionSchema = z.object({
  interactionId: z.string().min(1),
  request: HumanInteractionRequestSchema,
});

export const InitializeStewardSchema = z.object({ runtimeId: z.string().min(1) });
export const PromptStewardSchema = z.object({
  content: z.string().trim().min(1).max(100_000),
  requestId: z.string().uuid(),
  taskWorkspaceId: z.string().min(1).max(2_000).optional(),
  modelSelection: PromptRuntimeModelSelectionSchema.optional(),
});
export const RespondStewardInteractionSchema = z.object({
  interactionId: z.string().min(1),
  requestId: z.string().uuid(),
  response: HumanInteractionResponseSchema,
});

export type StewardResourceSummary = z.infer<typeof StewardResourceSummarySchema>;
export type StewardDslDocument = z.infer<typeof StewardDslDocumentSchema>;
export type StewardDslChange = z.infer<typeof StewardDslChangeSchema>;
export type StewardChangeSet = z.infer<typeof StewardChangeSetSchema>;
export type StewardProjectCommit = z.infer<typeof StewardProjectCommitSchema>;
export type StewardTaskSummary = z.infer<typeof StewardTaskSummarySchema>;
export type StewardTask = z.infer<typeof StewardTaskSchema>;
export type StewardTaskWorkItem = z.infer<typeof StewardTaskWorkItemSchema>;
export type StewardSessionState = z.infer<typeof StewardSessionStateSchema>;
export type StewardChatEntry = z.infer<typeof StewardChatEntrySchema>;
export type StewardChatSnapshot = z.infer<typeof StewardChatSnapshotSchema>;
export type StewardInteraction = z.infer<typeof StewardInteractionSchema>;
export type InitializeSteward = z.infer<typeof InitializeStewardSchema>;
export type PromptSteward = z.infer<typeof PromptStewardSchema>;
export type RespondStewardInteraction = z.infer<typeof RespondStewardInteractionSchema>;

export interface PragmaStewardAPI {
  getStewardState(): Promise<StewardSessionState | null>;
  initializeSteward(input: InitializeSteward): Promise<StewardSessionState>;
  promptSteward(input: PromptSteward): Promise<StewardSessionState>;
  getStewardChat(): Promise<StewardChatSnapshot>;
  listStewardInteractions(): Promise<StewardInteraction[]>;
  respondStewardInteraction(input: RespondStewardInteraction): Promise<void>;
  interruptSteward(): Promise<StewardSessionState>;
  resetSteward(): Promise<void>;
}
