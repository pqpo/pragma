import {
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  EXECUTION_CURRENT_TEAM_ID_ATTR,
  readExecutionRunScope,
  type ExpertAgentManagedTool,
  type ExpertAgentManagedToolCallContext,
  type ExpertAgentToolCallResult,
} from "@pragma/core";
import { z } from "zod";

import {
  ContextStoreDraftRebaseInspectionSchema,
  ContextStoreDraftRebaseResolutionSchema,
  ContextStoreDraftSchema,
} from "./revision-contracts.ts";

export const LIST_KNOWLEDGE_REVISION_TARGETS_TOOL_NAME = "list_knowledge_revision_targets" as const;
export const LIST_KNOWLEDGE_REVISION_DRAFTS_TOOL_NAME = "list_knowledge_revision_drafts" as const;
export const START_KNOWLEDGE_REVISION_TOOL_NAME = "start_knowledge_revision" as const;
export const GET_KNOWLEDGE_REVISION_DRAFT_TOOL_NAME = "get_knowledge_revision_draft" as const;
export const INSPECT_KNOWLEDGE_REVISION_REBASE_TOOL_NAME =
  "inspect_knowledge_revision_rebase" as const;
export const REBASE_KNOWLEDGE_REVISION_DRAFT_TOOL_NAME = "rebase_knowledge_revision_draft" as const;
export const SUBMIT_KNOWLEDGE_REVISION_DRAFT_TOOL_NAME = "submit_knowledge_revision_draft" as const;

export const PRAGMA_MANAGEMENT_TOOL_NAMES = [
  LIST_KNOWLEDGE_REVISION_TARGETS_TOOL_NAME,
  LIST_KNOWLEDGE_REVISION_DRAFTS_TOOL_NAME,
  START_KNOWLEDGE_REVISION_TOOL_NAME,
  GET_KNOWLEDGE_REVISION_DRAFT_TOOL_NAME,
  INSPECT_KNOWLEDGE_REVISION_REBASE_TOOL_NAME,
  REBASE_KNOWLEDGE_REVISION_DRAFT_TOOL_NAME,
  SUBMIT_KNOWLEDGE_REVISION_DRAFT_TOOL_NAME,
] as const;

export const KnowledgeRevisionTargetMountSchema = z
  .object({
    ownerKind: z.enum(["expert", "team"]),
    ownerRef: z.string().min(1).max(200),
    ownerName: z.string().min(1).max(200),
    namespace: z.string().min(1).max(100),
    required: z.boolean(),
    visibility: z
      .discriminatedUnion("mode", [
        z.object({ mode: z.literal("all") }).strict(),
        z
          .object({
            mode: z.enum(["whitelist", "blacklist"]),
            expertIds: z.array(z.string().min(1).max(200)),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

export const KnowledgeRevisionTargetSchema = z
  .object({
    targetRef: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    description: z.string().max(2_000),
    revision: z.number().int().positive(),
    mounted: z.boolean(),
    mounts: z.array(KnowledgeRevisionTargetMountSchema),
  })
  .strict();

export type KnowledgeRevisionTarget = z.infer<typeof KnowledgeRevisionTargetSchema>;

const TargetRefSchema = KnowledgeRevisionTargetSchema.shape.targetRef.describe(
  "Exact targetRef returned by list_knowledge_revision_targets.",
);
const DraftIdSchema = z
  .string()
  .uuid()
  .describe("Exact draftId returned by a revision draft tool.");

const ListDraftsInputSchema = z.object({ targetRef: TargetRefSchema.optional() }).strict();
const StartRevisionInputSchema = z
  .object({
    targetRef: TargetRefSchema,
    prompt: z.string().trim().min(1).max(50_000),
    draftId: DraftIdSchema.optional(),
    draftName: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.draftId !== undefined && input.draftName !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["draftName"],
        message: "Choose an existing draft or name a new draft, not both.",
      });
    }
  });
const DraftInputSchema = z.object({ draftId: DraftIdSchema }).strict();
const RebaseDraftInputSchema = z
  .object({
    draftId: DraftIdSchema,
    expectedRevision: z.number().int().positive(),
    resolutions: z.array(ContextStoreDraftRebaseResolutionSchema).default([]),
  })
  .strict();
const SubmitDraftInputSchema = z
  .object({
    draftId: DraftIdSchema,
    expectedRevision: z.number().int().positive(),
    summary: z.string().trim().min(1).max(2_000),
  })
  .strict();

export interface KnowledgeRevisionToolInvocation {
  readonly executionId: string;
  readonly invocationId: string;
  readonly expertId: string;
  readonly teamId?: string | undefined;
  readonly operationId: string;
}

export interface KnowledgeRevisionSubmissionPort {
  listTargets(input: KnowledgeRevisionToolInvocation): Promise<readonly KnowledgeRevisionTarget[]>;
  listDrafts(
    input: KnowledgeRevisionToolInvocation & { readonly targetRef?: string | undefined },
  ): Promise<readonly z.infer<typeof ContextStoreDraftSchema>[]>;
  start(
    input: KnowledgeRevisionToolInvocation & z.infer<typeof StartRevisionInputSchema>,
  ): Promise<unknown>;
  getDraft(
    input: KnowledgeRevisionToolInvocation & { readonly draftId: string },
  ): Promise<z.infer<typeof ContextStoreDraftSchema>>;
  inspectRebase(
    input: KnowledgeRevisionToolInvocation & { readonly draftId: string },
  ): Promise<z.infer<typeof ContextStoreDraftRebaseInspectionSchema>>;
  rebase(
    input: KnowledgeRevisionToolInvocation & z.infer<typeof RebaseDraftInputSchema>,
  ): Promise<z.infer<typeof ContextStoreDraftSchema>>;
  submitDraft(
    input: KnowledgeRevisionToolInvocation & z.infer<typeof SubmitDraftInputSchema>,
  ): Promise<z.infer<typeof ContextStoreDraftSchema>>;
}

export interface PragmaManagementToolPorts {
  readonly knowledgeRevisions: KnowledgeRevisionSubmissionPort;
}

type PragmaManagementTool = ExpertAgentManagedTool<string, ExpertAgentToolCallResult>;

export function createPragmaManagementTools(
  ports: PragmaManagementToolPorts,
): readonly PragmaManagementTool[] {
  const port = ports.knowledgeRevisions;
  return [
    tool(
      LIST_KNOWLEDGE_REVISION_TARGETS_TOOL_NAME,
      "List knowledge bases that may be revised, with their exact target refs and current revisions.",
      z.object({}).strict(),
      "none",
      async (input, context) => await port.listTargets(invocation(context)),
    ),
    tool(
      LIST_KNOWLEDGE_REVISION_DRAFTS_TOOL_NAME,
      "List sparse knowledge revision drafts, optionally for one exact target ref.",
      ListDraftsInputSchema,
      "none",
      async (input, context) =>
        await port.listDrafts({ ...invocation(context), ...ListDraftsInputSchema.parse(input) }),
    ),
    tool(
      START_KNOWLEDGE_REVISION_TOOL_NAME,
      "Start a revision in a new named draft or continue an existing draft. This creates or reuses a managed revision task and never changes formal knowledge.",
      StartRevisionInputSchema,
      "required",
      async (input, context) =>
        await port.start({ ...invocation(context), ...StartRevisionInputSchema.parse(input) }),
    ),
    tool(
      GET_KNOWLEDGE_REVISION_DRAFT_TOOL_NAME,
      "Read the current sparse overlay, base revision, state, and revision of one knowledge draft.",
      DraftInputSchema,
      "none",
      async (input, context) =>
        await port.getDraft({ ...invocation(context), ...DraftInputSchema.parse(input) }),
    ),
    tool(
      INSPECT_KNOWLEDGE_REVISION_REBASE_TOOL_NAME,
      "Compare a stale draft with the latest formal store and list every explicit three-way conflict.",
      DraftInputSchema,
      "none",
      async (input, context) =>
        await port.inspectRebase({ ...invocation(context), ...DraftInputSchema.parse(input) }),
    ),
    tool(
      REBASE_KNOWLEDGE_REVISION_DRAFT_TOOL_NAME,
      "Explicitly rebase a draft onto the latest formal store. Every reported conflict requires a resolution.",
      RebaseDraftInputSchema,
      "none",
      async (input, context) =>
        await port.rebase({ ...invocation(context), ...RebaseDraftInputSchema.parse(input) }),
    ),
    tool(
      SUBMIT_KNOWLEDGE_REVISION_DRAFT_TOOL_NAME,
      "Submit a non-empty validated knowledge draft for human review. This does not merge or publish it.",
      SubmitDraftInputSchema,
      "none",
      async (input, context) =>
        await port.submitDraft({ ...invocation(context), ...SubmitDraftInputSchema.parse(input) }),
    ),
  ];
}

function tool<TSchema extends z.ZodType>(
  name: string,
  description: string,
  schema: TSchema,
  approval: "none" | "required",
  call: (
    input: z.infer<TSchema>,
    context: ExpertAgentManagedToolCallContext | undefined,
  ) => Promise<unknown>,
): PragmaManagementTool {
  return {
    name,
    description,
    inputSchema: z.toJSONSchema(schema),
    approval:
      approval === "none"
        ? { mode: "none" }
        : { mode: "required", reason: "Start a managed knowledge revision task." },
    call: async (args, _signal, context) => result(await call(schema.parse(args), context)),
  };
}

function invocation(
  context: ExpertAgentManagedToolCallContext | undefined,
): KnowledgeRevisionToolInvocation {
  const scope = readExecutionRunScope(context?.runContext);
  const expertId = context?.runContext?.attributes?.[EXECUTION_CURRENT_EXPERT_ID_ATTR];
  const teamId = context?.runContext?.attributes?.[EXECUTION_CURRENT_TEAM_ID_ATTR];
  if (
    scope.executionId === undefined ||
    scope.invocationId === undefined ||
    typeof expertId !== "string" ||
    expertId.length === 0 ||
    context?.toolCallId === undefined
  ) {
    throw new Error("pragma_management_execution_context_unavailable");
  }
  return {
    executionId: scope.executionId,
    invocationId: scope.invocationId,
    expertId,
    ...(typeof teamId === "string" && teamId.length > 0 ? { teamId } : {}),
    operationId: context.toolCallId,
  };
}

function result(details: unknown): ExpertAgentToolCallResult {
  return { text: JSON.stringify(details, null, 2), details };
}
