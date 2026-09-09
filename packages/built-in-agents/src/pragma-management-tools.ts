import {
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  EXECUTION_CURRENT_TEAM_ID_ATTR,
  readExecutionRunScope,
  type ExpertAgentManagedTool,
  type ExpertAgentManagedToolCallContext,
  type ExpertAgentToolCallResult,
} from "@pragma/core";
import { z } from "zod";

import type {
  PragmaAgentAutomationPort,
  PragmaAgentDslProjectPort,
  PragmaAgentMissionPort,
} from "./ports.ts";
import {
  PRAGMA_MANAGEMENT_HOST_TOOL_DEFINITIONS,
  createPragmaManagementHostTools,
} from "./pragma-host-management-tools.ts";
import {
  PRAGMA_MANAGEMENT_MAX_PAGE_LIMIT,
  PragmaContentChunkSchema,
  PragmaManagementErrorSchema,
  PragmaManagementPageInputSchema,
  PragmaManagementPageSchema,
} from "./contracts.ts";

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
export const KNOWLEDGE_REVISION_GET_REBASE_CONFLICT_TOOL_NAME =
  "knowledge_revision_get_rebase_conflict" as const;
export const KNOWLEDGE_REVISION_REBASE_TOOL_NAME = "knowledge_revision_rebase" as const;
export const KNOWLEDGE_REVISION_SUBMIT_DRAFT_TOOL_NAME = "knowledge_revision_submit_draft" as const;
export const KNOWLEDGE_REVISION_DISCARD_DRAFT_TOOL_NAME =
  "knowledge_revision_discard_draft" as const;

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
const WritableNamespaceSchema = z
  .string()
  .min(1)
  .max(100)
  .describe(
    "Writable Context namespace for this draft in the current Mission. Pass it unchanged to Expert Context tools.",
  );

export const KnowledgeRevisionDraftSummarySchema = z
  .object({
    draftId: ContextStoreDraftSchema.shape.id,
    revision: ContextStoreDraftSchema.shape.revision,
    name: ContextStoreDraftSchema.shape.name,
    storeId: ContextStoreDraftSchema.shape.storeId,
    baseRevision: ContextStoreDraftSchema.shape.baseRevision,
    state: ContextStoreDraftSchema.shape.state,
    activeMissionId: ContextStoreDraftSchema.shape.activeMissionId,
    writableNamespace: WritableNamespaceSchema.optional(),
    submittedRevision: ContextStoreDraftSchema.shape.submittedRevision,
    summary: ContextStoreDraftSchema.shape.summary,
    createdAt: ContextStoreDraftSchema.shape.createdAt,
    updatedAt: ContextStoreDraftSchema.shape.updatedAt,
  })
  .strict();

export type KnowledgeRevisionDraftSummary = z.infer<typeof KnowledgeRevisionDraftSummarySchema>;

export const KnowledgeRevisionListTargetsInputSchema = PragmaManagementPageInputSchema.extend({
  mounted: z.boolean().optional(),
  query: z.string().trim().min(1).max(200).optional(),
}).strict();
export const KnowledgeRevisionListDraftsInputSchema = PragmaManagementPageInputSchema.extend({
  targetRef: TargetRefSchema.optional(),
  states: z.array(ContextStoreDraftSchema.shape.state).max(6).optional(),
  query: z.string().trim().min(1).max(200).optional(),
}).strict();
export const KnowledgeRevisionTargetPageSchema = PragmaManagementPageSchema(
  KnowledgeRevisionTargetSchema,
);
export const KnowledgeRevisionDraftPageSchema = PragmaManagementPageSchema(
  KnowledgeRevisionDraftSummarySchema,
);
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
    offset: z.number().int().nonnegative().default(0),
    limitChars: z.number().int().min(1).max(100_000).default(20_000),
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
    writableNamespace: WritableNamespaceSchema.optional(),
    draftRevision: ContextStoreDraftSchema.shape.revision,
    id: z.string().min(1).max(500),
    content: PragmaContentChunkSchema,
    metadata: ContextStoreDraftOverlaySchema.shape.files.element.shape.metadata,
    revision: z.string().optional(),
    etag: z.string().optional(),
    sizeBytes: z.number().int().nonnegative(),
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
export const KnowledgeRevisionDiscardDraftInputSchema = z
  .object({
    draftId: DraftIdSchema,
    expectedRevision: z.number().int().positive(),
  })
  .strict();

export const KnowledgeRevisionDiscardDraftResultSchema = z
  .object({
    draftId: DraftIdSchema,
    discarded: z.literal(true),
  })
  .strict();

export const KnowledgeRevisionDraftReceiptSchema = z
  .object({
    draftId: DraftIdSchema,
    revision: z.number().int().positive(),
    state: ContextStoreDraftSchema.shape.state,
    baseRevision: z.number().int().positive(),
    stale: z.boolean(),
    changedPaths: z.array(z.string().min(1).max(500)).max(1_000),
    submittedRevision: z.number().int().positive().optional(),
  })
  .strict();

export const KnowledgeRevisionConflictSummarySchema = z
  .object({
    id: z.string().min(1).max(500),
    kind: ContextStoreDraftRebaseInspectionSchema.shape.conflicts.element.shape.kind,
    availableSides: z.array(z.enum(["base", "current", "draft"])).max(3),
  })
  .strict();
export const KnowledgeRevisionConflictPageSchema = z
  .object({
    draftId: DraftIdSchema,
    draftRevision: z.number().int().positive(),
    currentStoreRevision: z.number().int().positive(),
    currentSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    items: z.array(KnowledgeRevisionConflictSummarySchema).max(PRAGMA_MANAGEMENT_MAX_PAGE_LIMIT),
    nextCursor: z.string().min(1).max(4_096).optional(),
  })
  .strict();
export const KnowledgeRevisionInspectRebaseInputSchema = PragmaManagementPageInputSchema.extend({
  draftId: DraftIdSchema,
}).strict();
export const KnowledgeRevisionGetRebaseConflictInputSchema = z
  .object({
    draftId: DraftIdSchema,
    conflictId: z.string().min(1).max(500),
    side: z.enum(["base", "current", "draft"]),
    offset: z.number().int().nonnegative().default(0),
    limitChars: z.number().int().min(1).max(100_000).default(20_000),
  })
  .strict();
export const KnowledgeRevisionConflictContentSchema = z
  .object({
    draftId: DraftIdSchema,
    conflictId: z.string().min(1).max(500),
    side: z.enum(["base", "current", "draft"]),
    content: PragmaContentChunkSchema,
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
  listTargets(
    input: KnowledgeRevisionToolInvocation &
      z.infer<typeof KnowledgeRevisionListTargetsInputSchema>,
  ): Promise<z.infer<typeof KnowledgeRevisionTargetPageSchema>>;
  listDrafts(
    input: KnowledgeRevisionToolInvocation & z.infer<typeof KnowledgeRevisionListDraftsInputSchema>,
  ): Promise<z.infer<typeof KnowledgeRevisionDraftPageSchema>>;
  start(
    input: KnowledgeRevisionToolInvocation & z.infer<typeof KnowledgeRevisionStartInputSchema>,
  ): Promise<unknown>;
  getDraft(
    input: KnowledgeRevisionToolInvocation & z.input<typeof KnowledgeRevisionGetDraftInputSchema>,
  ): Promise<KnowledgeRevisionGetDraftResult>;
  inspectRebase(
    input: KnowledgeRevisionToolInvocation &
      z.infer<typeof KnowledgeRevisionInspectRebaseInputSchema>,
  ): Promise<z.infer<typeof KnowledgeRevisionConflictPageSchema>>;
  getRebaseConflict(
    input: KnowledgeRevisionToolInvocation &
      z.infer<typeof KnowledgeRevisionGetRebaseConflictInputSchema>,
  ): Promise<z.infer<typeof KnowledgeRevisionConflictContentSchema>>;
  rebase(
    input: KnowledgeRevisionToolInvocation & z.infer<typeof KnowledgeRevisionRebaseInputSchema>,
  ): Promise<z.infer<typeof KnowledgeRevisionDraftReceiptSchema>>;
  submitDraft(
    input: KnowledgeRevisionToolInvocation &
      z.infer<typeof KnowledgeRevisionSubmitDraftInputSchema>,
  ): Promise<z.infer<typeof KnowledgeRevisionDraftReceiptSchema>>;
  discardDraft(
    input: KnowledgeRevisionToolInvocation &
      z.infer<typeof KnowledgeRevisionDiscardDraftInputSchema>,
  ): Promise<z.infer<typeof KnowledgeRevisionDiscardDraftResultSchema>>;
}

export interface PragmaManagementToolPorts {
  readonly project?: PragmaAgentDslProjectPort | undefined;
  readonly missions?: PragmaAgentMissionPort | undefined;
  readonly automations?: PragmaAgentAutomationPort | undefined;
  readonly knowledgeRevisions?: KnowledgeRevisionSubmissionPort | undefined;
}

type PragmaManagementTool = ExpertAgentManagedTool<string, ExpertAgentToolCallResult>;

function definition<TSchema extends z.ZodType>(
  name: string,
  description: string,
  schema: TSchema,
  outputSchema: z.ZodType,
  approval: "none" | { readonly reason: string } = "none",
) {
  return {
    name,
    description,
    schema,
    resultSchema: outputSchema,
    inputSchema: z.toJSONSchema(schema),
    outputSchema: z.toJSONSchema(z.union([outputSchema, PragmaManagementErrorSchema])),
    approval:
      approval === "none"
        ? ({ mode: "none" } as const)
        : ({ mode: "required", reason: approval.reason } as const),
  } as const;
}

const PRAGMA_KNOWLEDGE_REVISION_TOOL_DEFINITIONS = [
  definition(
    KNOWLEDGE_REVISION_LIST_TARGETS_TOOL_NAME,
    "List knowledge bases that may be revised, with their exact target refs and current revisions.",
    KnowledgeRevisionListTargetsInputSchema,
    KnowledgeRevisionTargetPageSchema,
  ),
  definition(
    KNOWLEDGE_REVISION_LIST_DRAFTS_TOOL_NAME,
    "List lightweight summaries of sparse knowledge revision drafts, optionally for one exact target ref. A draft claimed by the current Mission includes writableNamespace so it can be recovered after context compaction.",
    KnowledgeRevisionListDraftsInputSchema,
    KnowledgeRevisionDraftPageSchema,
  ),
  definition(
    KNOWLEDGE_REVISION_START_TOOL_NAME,
    "Start a revision in a new named draft or continue an existing draft by draftId, transferring an idle earlier Mission claim when necessary. Returns the writable Context namespace for immediate same-turn editing inside a Store Revision Mission; never changes formal knowledge.",
    KnowledgeRevisionStartInputSchema,
    z.object({
      jobId: z.string().uuid(),
      draftId: DraftIdSchema,
      missionId: z.string().uuid().optional(),
      state: z.string().min(1),
      target: KnowledgeRevisionTargetSchema,
      writableNamespace: WritableNamespaceSchema.optional(),
    }),
    { reason: "Start a managed knowledge revision Mission." },
  ),
  definition(
    KNOWLEDGE_REVISION_GET_DRAFT_TOOL_NAME,
    "Inspect one knowledge draft without loading full overlay content. Omit fileId for hashes and staleness; provide one fileId plus an optional content range to read a bounded chunk of that effective draft file.",
    KnowledgeRevisionGetDraftInputSchema,
    KnowledgeRevisionGetDraftResultSchema,
  ),
  definition(
    KNOWLEDGE_REVISION_INSPECT_REBASE_TOOL_NAME,
    "Compare a stale draft with the latest formal store and list every explicit three-way conflict.",
    KnowledgeRevisionInspectRebaseInputSchema,
    KnowledgeRevisionConflictPageSchema,
  ),
  definition(
    KNOWLEDGE_REVISION_GET_REBASE_CONFLICT_TOOL_NAME,
    "Read one bounded content side for an exact knowledge revision rebase conflict.",
    KnowledgeRevisionGetRebaseConflictInputSchema,
    KnowledgeRevisionConflictContentSchema,
  ),
  definition(
    KNOWLEDGE_REVISION_REBASE_TOOL_NAME,
    "Explicitly rebase a draft onto the latest formal store. Every reported conflict requires a resolution.",
    KnowledgeRevisionRebaseInputSchema,
    KnowledgeRevisionDraftReceiptSchema,
  ),
  definition(
    KNOWLEDGE_REVISION_SUBMIT_DRAFT_TOOL_NAME,
    "Submit a non-empty validated knowledge draft for human review. Submission makes the draft non-editable; it does not merge or publish it.",
    KnowledgeRevisionSubmitDraftInputSchema,
    KnowledgeRevisionDraftReceiptSchema,
  ),
  definition(
    KNOWLEDGE_REVISION_DISCARD_DRAFT_TOOL_NAME,
    "Discard an obsolete unmerged knowledge draft. This also rejects its unfinished revision Mission and detaches it; merged revision history cannot be discarded.",
    KnowledgeRevisionDiscardDraftInputSchema,
    KnowledgeRevisionDiscardDraftResultSchema,
    { reason: "Discard this knowledge draft and reject its unfinished revision Mission." },
  ),
] as const;

export const PRAGMA_MANAGEMENT_TOOL_DEFINITIONS = [
  ...PRAGMA_MANAGEMENT_HOST_TOOL_DEFINITIONS,
  ...PRAGMA_KNOWLEDGE_REVISION_TOOL_DEFINITIONS,
] as const;

export function createPragmaManagementTools(
  ports: PragmaManagementToolPorts,
): readonly PragmaManagementTool[] {
  if (
    (ports.project === undefined) !== (ports.missions === undefined) ||
    (ports.automations !== undefined && ports.project === undefined)
  ) {
    throw new Error("Pragma project and Mission management ports must be provided together.");
  }
  const hostTools =
    ports.project === undefined || ports.missions === undefined
      ? []
      : createPragmaManagementHostTools({
          project: ports.project,
          missions: ports.missions,
          ...(ports.automations === undefined ? {} : { automations: ports.automations }),
        });
  const port = ports.knowledgeRevisions;
  if (port === undefined) return hostTools;
  const [
    listTargets,
    listDrafts,
    start,
    getDraft,
    inspectRebase,
    getRebaseConflict,
    rebase,
    submitDraft,
    discardDraft,
  ] = PRAGMA_KNOWLEDGE_REVISION_TOOL_DEFINITIONS;
  return [
    ...hostTools,
    tool(
      listTargets,
      async (input, context) => await port.listTargets({ ...invocation(context), ...input }),
    ),
    tool(
      listDrafts,
      async (input, context) => await port.listDrafts({ ...invocation(context), ...input }),
    ),
    tool(start, async (input, context) => await port.start({ ...invocation(context), ...input })),
    tool(
      getDraft,
      async (input, context) => await port.getDraft({ ...invocation(context), ...input }),
    ),
    tool(
      inspectRebase,
      async (input, context) => await port.inspectRebase({ ...invocation(context), ...input }),
    ),
    tool(
      getRebaseConflict,
      async (input, context) => await port.getRebaseConflict({ ...invocation(context), ...input }),
    ),
    tool(rebase, async (input, context) => await port.rebase({ ...invocation(context), ...input })),
    tool(
      submitDraft,
      async (input, context) => await port.submitDraft({ ...invocation(context), ...input }),
    ),
    tool(
      discardDraft,
      async (input, context) => await port.discardDraft({ ...invocation(context), ...input }),
    ),
  ];
}

function tool<TSchema extends z.ZodType>(
  toolDefinition: {
    readonly name: string;
    readonly description: string;
    readonly schema: TSchema;
    readonly resultSchema: z.ZodType;
    readonly inputSchema: PragmaManagementTool["inputSchema"];
    readonly outputSchema: NonNullable<PragmaManagementTool["outputSchema"]>;
    readonly approval: NonNullable<PragmaManagementTool["approval"]>;
  },
  call: (
    input: z.infer<TSchema>,
    context: ExpertAgentManagedToolCallContext | undefined,
  ) => Promise<unknown>,
): PragmaManagementTool {
  return {
    name: toolDefinition.name,
    description: toolDefinition.description,
    inputSchema: toolDefinition.inputSchema,
    outputSchema: toolDefinition.outputSchema,
    approval: toolDefinition.approval,
    call: async (args, _signal, context) => {
      try {
        const value = result(
          toolDefinition.resultSchema.parse(await call(toolDefinition.schema.parse(args), context)),
        );
        if (Buffer.byteLength(value.text, "utf8") > 256 * 1024) {
          return managementErrorResult(new Error("response_too_large"), toolDefinition.name);
        }
        return value;
      } catch (error) {
        return managementErrorResult(error, toolDefinition.name);
      }
    },
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
  const text = JSON.stringify(details);
  return { text, details };
}

function managementErrorResult(error: unknown, toolName: string): ExpertAgentToolCallResult {
  const rawMessage = error instanceof Error ? error.message : "Unknown management tool failure.";
  const code =
    error instanceof z.ZodError
      ? "invalid_input"
      : rawMessage === "cursor_invalid" || rawMessage === "cursor_expired"
        ? rawMessage
        : rawMessage === "response_too_large"
          ? "response_too_large"
          : /revision|stale|conflict/iu.test(rawMessage)
            ? "revision_conflict"
            : /not found|missing/iu.test(rawMessage)
              ? "not_found"
              : /permission|denied|not mounted/iu.test(rawMessage)
                ? "permission_denied"
                : /already.*attach/iu.test(rawMessage)
                  ? "already_attached"
                  : /unavailable/iu.test(rawMessage)
                    ? "unavailable"
                    : "internal_error";
  const payload = PragmaManagementErrorSchema.parse({
    schemaVersion: "pragma.management-error/v1",
    code,
    message:
      code === "internal_error"
        ? "The management tool failed unexpectedly."
        : rawMessage.slice(0, 2_000),
    retryable:
      ["revision_conflict", "cursor_expired"].includes(code) ||
      (code === "unavailable" && !rawMessage.includes("execution_context")),
    ...(error instanceof z.ZodError ? { details: { issues: error.issues } } : {}),
    ...(code === "cursor_expired"
      ? { recovery: { tool: toolName, reason: "Run the same listing again without cursor." } }
      : code === "response_too_large"
        ? {
            recovery: {
              tool: toolName,
              reason: "Use a smaller page limit, a narrower filter, or a bounded content range.",
            },
          }
        : {}),
  });
  return { text: JSON.stringify(payload), details: payload, isError: true };
}
