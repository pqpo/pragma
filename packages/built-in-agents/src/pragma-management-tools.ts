import {
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  EXECUTION_CURRENT_TEAM_ID_ATTR,
  readExecutionRunScope,
  type ExpertAgentManagedTool,
  type ExpertAgentManagedToolCallContext,
  type ExpertAgentToolCallResult,
} from "@pragma/core";
import { z } from "zod";

export const LIST_KNOWLEDGE_REVISION_TARGETS_TOOL_NAME = "list_knowledge_revision_targets" as const;
export const SUBMIT_KNOWLEDGE_REVISION_TOOL_NAME = "submit_knowledge_revision" as const;
export const PRAGMA_MANAGEMENT_TOOL_NAMES = [
  LIST_KNOWLEDGE_REVISION_TARGETS_TOOL_NAME,
  SUBMIT_KNOWLEDGE_REVISION_TOOL_NAME,
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

const SubmitKnowledgeRevisionInputSchema = z
  .object({
    targetRef: KnowledgeRevisionTargetSchema.shape.targetRef.describe(
      "Exact targetRef returned by list_knowledge_revision_targets.",
    ),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(50_000)
      .describe("One complete, reviewable revision request for this knowledge base."),
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
  submit(
    input: KnowledgeRevisionToolInvocation & {
      readonly targetRef: string;
      readonly prompt: string;
    },
  ): Promise<{
    readonly jobId: string;
    readonly state: string;
    readonly target: KnowledgeRevisionTarget;
  }>;
}

export interface PragmaManagementToolPorts {
  readonly knowledgeRevisions: KnowledgeRevisionSubmissionPort;
}

type PragmaManagementTool = ExpertAgentManagedTool<string, ExpertAgentToolCallResult>;

export function createPragmaManagementTools(
  ports: PragmaManagementToolPorts,
): readonly PragmaManagementTool[] {
  return createKnowledgeRevisionTools(ports.knowledgeRevisions);
}

function createKnowledgeRevisionTools(
  port: KnowledgeRevisionSubmissionPort,
): readonly PragmaManagementTool[] {
  return [
    {
      name: LIST_KNOWLEDGE_REVISION_TARGETS_TOOL_NAME,
      description:
        "List all knowledge bases, including descriptions, current revisions, and current Expert or ExpertTeam mounts. Only returned targetRef values may be submitted for revision.",
      inputSchema: z.toJSONSchema(z.object({}).strict()),
      approval: { mode: "none" },
      call: async (_args, _signal, context) => result(await port.listTargets(invocation(context))),
    },
    {
      name: SUBMIT_KNOWLEDGE_REVISION_TOOL_NAME,
      description:
        "Submit one reflection-derived revision request for any knowledge base. This creates a review task and never changes knowledge directly.",
      inputSchema: z.toJSONSchema(SubmitKnowledgeRevisionInputSchema),
      approval: {
        mode: "required",
        reason: "Submit a knowledge-base revision request for user review.",
      },
      call: async (args, _signal, context) => {
        const parsed = SubmitKnowledgeRevisionInputSchema.parse(args);
        return result(await port.submit({ ...invocation(context), ...parsed }));
      },
    },
  ];
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
