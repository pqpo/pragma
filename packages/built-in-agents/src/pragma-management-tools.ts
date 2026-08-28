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
  ContextStoreDraftOverlaySchema,
  ContextStoreDraftRebaseInspectionSchema,
  ContextStoreDraftRebaseResolutionSchema,
  ContextStoreDraftSchema,
  GetContextStoreDraftFileSchema,
} from "./revision-contracts.ts";

export const KNOWLEDGE_REVISION_LIST_TARGETS_TOOL_NAME = "knowledge_revision_list_targets" as const;
export const KNOWLEDGE_REVISION_LIST_DRAFTS_TOOL_NAME = "knowledge_revision_list_drafts" as const;
export const KNOWLEDGE_REVISION_START_TOOL_NAME = "knowledge_revision_start" as const;
export const KNOWLEDGE_REVISION_GET_DRAFT_TOOL_NAME = "knowledge_revision_get_draft" as const;
export const KNOWLEDGE_REVISION_INSPECT_REBASE_TOOL_NAME =
  "knowledge_revision_inspect_rebase" as const;
export const KNOWLEDGE_REVISION_REBASE_TOOL_NAME = "knowledge_revision_rebase" as const;
export const KNOWLEDGE_REVISION_SUBMIT_DRAFT_TOOL_NAME = "knowledge_revision_submit_draft" as const;

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
  "Exact targetRef returned by knowledge_revision_list_targets.",
);
const DraftIdSchema = z
  .string()
  .uuid()
  .describe("Exact draftId returned by a revision draft tool.");

export const KnowledgeRevisionDraftSummarySchema = z
  .object({
    draftId: ContextStoreDraftSchema.shape.id,
    revision: ContextStoreDraftSchema.shape.revision,
    name: ContextStoreDraftSchema.shape.name,
    storeId: ContextStoreDraftSchema.shape.storeId,
    baseRevision: ContextStoreDraftSchema.shape.baseRevision,
    state: ContextStoreDraftSchema.shape.state,
    activeMissionId: ContextStoreDraftSchema.shape.activeMissionId,
    submittedRevision: ContextStoreDraftSchema.shape.submittedRevision,
    summary: ContextStoreDraftSchema.shape.summary,
    createdAt: ContextStoreDraftSchema.shape.createdAt,
    updatedAt: ContextStoreDraftSchema.shape.updatedAt,
  })
  .strict();

export type KnowledgeRevisionDraftSummary = z.infer<typeof KnowledgeRevisionDraftSummarySchema>;

export const KnowledgeRevisionListTargetsInputSchema = z.object({}).strict();
export const KnowledgeRevisionListDraftsInputSchema = z
  .object({ targetRef: TargetRefSchema.optional() })
  .strict();
export const KnowledgeRevisionStartInputSchema = z
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
export const KnowledgeRevisionGetDraftInputSchema = z
  .object({
    draftId: DraftIdSchema,
    fileId: GetContextStoreDraftFileSchema.shape.id
      .optional()
      .describe(
        "Optional exact file id. Omit for a lightweight overlay summary; provide it to read only that effective draft file and its draft-scoped revision/etag.",
      ),
  })
  .strict();
export const KnowledgeRevisionDraftInputSchema = z.object({ draftId: DraftIdSchema }).strict();

const KnowledgeRevisionDraftFileSummarySchema = z
  .object({
    id: z.string().min(1).max(500),
    metadata: ContextStoreDraftOverlaySchema.shape.files.element.shape.metadata,
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const KnowledgeRevisionDraftInspectionSchema = z
  .object({
    mode: z.literal("summary"),
    draft: KnowledgeRevisionDraftSummarySchema.extend({
      baseSnapshotHash: ContextStoreDraftSchema.shape.baseSnapshotHash,
    }).strict(),
    currentStoreRevision: z.number().int().positive(),
    currentSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    stale: z.boolean(),
    overlay: z
      .object({
        files: z.array(KnowledgeRevisionDraftFileSummarySchema),
        deletedFiles: ContextStoreDraftOverlaySchema.shape.deletedFiles,
        directories: ContextStoreDraftOverlaySchema.shape.directories,
        deletedDirectories: ContextStoreDraftOverlaySchema.shape.deletedDirectories,
      })
      .strict(),
  })
  .strict();

export const KnowledgeRevisionDraftFileSchema = z
  .object({
    mode: z.literal("file"),
    draftId: DraftIdSchema,
    draftRevision: ContextStoreDraftSchema.shape.revision,
    id: z.string().min(1).max(500),
    content: z.string().max(1_000_000),
    metadata: ContextStoreDraftOverlaySchema.shape.files.element.shape.metadata,
    revision: z.string().optional(),
    etag: z.string().optional(),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const KnowledgeRevisionGetDraftResultSchema = z.discriminatedUnion("mode", [
  KnowledgeRevisionDraftInspectionSchema,
  KnowledgeRevisionDraftFileSchema,
]);

export type KnowledgeRevisionGetDraftResult = z.infer<typeof KnowledgeRevisionGetDraftResultSchema>;
export const KnowledgeRevisionRebaseInputSchema = z
  .object({
    draftId: DraftIdSchema,
    expectedRevision: z.number().int().positive(),
    resolutions: z.array(ContextStoreDraftRebaseResolutionSchema).default([]),
  })
  .strict();
export const KnowledgeRevisionSubmitDraftInputSchema = z
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
  ): Promise<readonly KnowledgeRevisionDraftSummary[]>;
  start(
    input: KnowledgeRevisionToolInvocation & z.infer<typeof KnowledgeRevisionStartInputSchema>,
  ): Promise<unknown>;
  getDraft(
    input: KnowledgeRevisionToolInvocation & z.infer<typeof KnowledgeRevisionGetDraftInputSchema>,
  ): Promise<KnowledgeRevisionGetDraftResult>;
  inspectRebase(
    input: KnowledgeRevisionToolInvocation & { readonly draftId: string },
  ): Promise<z.infer<typeof ContextStoreDraftRebaseInspectionSchema>>;
  rebase(
    input: KnowledgeRevisionToolInvocation & z.infer<typeof KnowledgeRevisionRebaseInputSchema>,
  ): Promise<z.infer<typeof ContextStoreDraftSchema>>;
  submitDraft(
    input: KnowledgeRevisionToolInvocation &
      z.infer<typeof KnowledgeRevisionSubmitDraftInputSchema>,
  ): Promise<z.infer<typeof ContextStoreDraftSchema>>;
}

export interface PragmaManagementToolPorts {
  readonly knowledgeRevisions: KnowledgeRevisionSubmissionPort;
}

type PragmaManagementTool = ExpertAgentManagedTool<string, ExpertAgentToolCallResult>;

function definition<TSchema extends z.ZodType>(name: string, description: string, schema: TSchema) {
  return { name, description, schema, inputSchema: z.toJSONSchema(schema) } as const;
}

export const PRAGMA_MANAGEMENT_TOOL_DEFINITIONS = [
  definition(
    KNOWLEDGE_REVISION_LIST_TARGETS_TOOL_NAME,
    "List knowledge bases that may be revised, with their exact target refs and current revisions.",
    KnowledgeRevisionListTargetsInputSchema,
  ),
  definition(
    KNOWLEDGE_REVISION_LIST_DRAFTS_TOOL_NAME,
    "List lightweight summaries of sparse knowledge revision drafts, optionally for one exact target ref.",
    KnowledgeRevisionListDraftsInputSchema,
  ),
  definition(
    KNOWLEDGE_REVISION_START_TOOL_NAME,
    "Start a revision in a new named draft or continue an existing draft by draftId, transferring an idle earlier Mission claim when necessary. Returns the writable Context namespace for immediate same-turn editing inside a Store Revision Mission; never changes formal knowledge.",
    KnowledgeRevisionStartInputSchema,
  ),
  definition(
    KNOWLEDGE_REVISION_GET_DRAFT_TOOL_NAME,
    "Inspect one knowledge draft without loading full overlay content. Omit fileId for hashes, current formal-store revision/snapshot, and staleness; provide one fileId to read only that effective draft file with its draft-scoped revision/etag.",
    KnowledgeRevisionGetDraftInputSchema,
  ),
  definition(
    KNOWLEDGE_REVISION_INSPECT_REBASE_TOOL_NAME,
    "Compare a stale draft with the latest formal store and list every explicit three-way conflict.",
    KnowledgeRevisionDraftInputSchema,
  ),
  definition(
    KNOWLEDGE_REVISION_REBASE_TOOL_NAME,
    "Explicitly rebase a draft onto the latest formal store. Every reported conflict requires a resolution.",
    KnowledgeRevisionRebaseInputSchema,
  ),
  definition(
    KNOWLEDGE_REVISION_SUBMIT_DRAFT_TOOL_NAME,
    "Submit a non-empty validated knowledge draft for human review. This does not merge or publish it.",
    KnowledgeRevisionSubmitDraftInputSchema,
  ),
] as const;

export const PRAGMA_MANAGEMENT_TOOL_NAMES = PRAGMA_MANAGEMENT_TOOL_DEFINITIONS.map(
  ({ name }) => name,
);

export function createPragmaManagementTools(
  ports: PragmaManagementToolPorts,
): readonly PragmaManagementTool[] {
  const port = ports.knowledgeRevisions;
  const [listTargets, listDrafts, start, getDraft, inspectRebase, rebase, submitDraft] =
    PRAGMA_MANAGEMENT_TOOL_DEFINITIONS;
  return [
    tool(
      listTargets,
      "none",
      async (_input, context) => await port.listTargets(invocation(context)),
    ),
    tool(
      listDrafts,
      "none",
      async (input, context) => await port.listDrafts({ ...invocation(context), ...input }),
    ),
    tool(
      start,
      "required",
      async (input, context) => await port.start({ ...invocation(context), ...input }),
    ),
    tool(
      getDraft,
      "none",
      async (input, context) => await port.getDraft({ ...invocation(context), ...input }),
    ),
    tool(
      inspectRebase,
      "none",
      async (input, context) => await port.inspectRebase({ ...invocation(context), ...input }),
    ),
    tool(
      rebase,
      "none",
      async (input, context) => await port.rebase({ ...invocation(context), ...input }),
    ),
    tool(
      submitDraft,
      "none",
      async (input, context) => await port.submitDraft({ ...invocation(context), ...input }),
    ),
  ];
}

function tool<TSchema extends z.ZodType>(
  toolDefinition: {
    readonly name: string;
    readonly description: string;
    readonly schema: TSchema;
    readonly inputSchema: PragmaManagementTool["inputSchema"];
  },
  approval: "none" | "required",
  call: (
    input: z.infer<TSchema>,
    context: ExpertAgentManagedToolCallContext | undefined,
  ) => Promise<unknown>,
): PragmaManagementTool {
  return {
    name: toolDefinition.name,
    description: toolDefinition.description,
    inputSchema: toolDefinition.inputSchema,
    approval:
      approval === "none"
        ? { mode: "none" }
        : { mode: "required", reason: "Start a managed knowledge revision task." },
    call: async (args, _signal, context) =>
      result(await call(toolDefinition.schema.parse(args), context)),
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
