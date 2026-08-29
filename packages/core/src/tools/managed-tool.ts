import type { HumanInteractionRequest } from "@pragma/shared";
import { HumanInteractionRequestSchema } from "@pragma/shared";
import type { ExpertAgentRunContext } from "../runtime/run-context.ts";
import { z } from "zod";

export interface ExpertAgentToolCallResult {
  readonly text: string;
  readonly isError?: boolean;
  readonly details?: unknown;
}

export interface ExpertToolExecutionContext {
  readonly executionId: string;
  readonly invocationId: string;
  readonly depth: number;
  readonly invokeResource?:
    | ((request: {
        readonly target: unknown;
        readonly input: unknown;
        readonly signal?: AbortSignal | undefined;
      }) => Promise<unknown>)
    | undefined;
  readonly spawnExpert?:
    | ((request: { readonly expertId: string; readonly task: string }) => Promise<unknown>)
    | undefined;
  readonly continueExpert?:
    | ((request: { readonly contextId: string; readonly task: string }) => Promise<unknown>)
    | undefined;
  readonly waitExperts?:
    | ((request: {
        readonly invocationIds: readonly string[];
        readonly returnWhen?: "all" | "any" | undefined;
        readonly timeoutMs?: number | undefined;
        readonly signal?: AbortSignal | undefined;
      }) => Promise<unknown>)
    | undefined;
  readonly listAgents?:
    | ((request: {
        readonly expertId?: string;
        readonly status?: "running" | "waiting" | "queued" | "idle" | "resumable" | undefined;
        readonly cursor?: string;
        readonly limit?: number;
      }) => Promise<unknown>)
    | undefined;
  readonly steerExpert?:
    | ((request: {
        readonly invocationId: string;
        readonly instruction: string;
        readonly delivery: "next_boundary" | "after_current";
      }) => Promise<unknown>)
    | undefined;
  readonly interruptExpert?:
    | ((request: {
        readonly invocationId: string;
        readonly reason?: string | undefined;
      }) => Promise<unknown>)
    | undefined;
}

export type ExpertAgentToolApprovalMode = "none" | "ask" | "required";

export type ExpertAgentToolApprovalRequirement = "none" | "ask" | "required";

export interface ExpertAgentToolApprovalRequest {
  readonly kind: "tool_approval";
  readonly toolName: string;
  readonly toolCallId?: string | undefined;
  readonly reason?: string | undefined;
  readonly input: unknown;
}

export interface ExpertAgentToolApprovalResponse {
  readonly kind: "tool_approval";
  readonly approved: boolean;
  readonly reason?: string | undefined;
  readonly updatedInput?: unknown;
}

export interface ExpertAgentUserQuestion {
  readonly question: string;
  readonly header: string;
  readonly kind: "single_choice" | "multiple_choice" | "text";
  readonly options: readonly {
    readonly label: string;
    readonly description: string;
    readonly value?: string | undefined;
  }[];
}

export interface ExpertAgentUserQuestionRequest {
  readonly kind: "user_question";
  readonly toolName: "askUserQuestion";
  readonly toolCallId?: string | undefined;
  readonly questions: readonly ExpertAgentUserQuestion[];
  readonly semantics?: { readonly kind: "approval"; readonly approveOption: string } | undefined;
  /** Original Host presentation, retained for Flow/Host round-trips. */
  readonly presentation?: HumanInteractionRequest | undefined;
}

export interface ExpertAgentUserQuestionResponse {
  readonly kind: "user_question";
  readonly answered: boolean;
  readonly reason?: string | undefined;
  readonly answers?: unknown;
  readonly notes?: string | undefined;
}

export type ExpertAgentHumanRequest =
  ExpertAgentToolApprovalRequest | ExpertAgentUserQuestionRequest;

export type ExpertAgentHumanResponse =
  ExpertAgentToolApprovalResponse | ExpertAgentUserQuestionResponse;

export const ExpertAgentToolApprovalRequestSchema = z.object({
  kind: z.literal("tool_approval"),
  toolName: z.string().min(1),
  toolCallId: z.string().min(1).optional(),
  reason: z.string().optional(),
  input: z.unknown(),
}) satisfies z.ZodType<ExpertAgentToolApprovalRequest>;

export const ExpertAgentUserQuestionSchema = z.object({
  question: z.string(),
  header: z.string(),
  kind: z.enum(["single_choice", "multiple_choice", "text"]),
  options: z.array(
    z.object({
      label: z.string(),
      description: z.string(),
      value: z.string().min(1).optional(),
    }),
  ),
}) satisfies z.ZodType<ExpertAgentUserQuestion>;

export const ExpertAgentUserQuestionRequestSchema = z.object({
  kind: z.literal("user_question"),
  toolName: z.literal("askUserQuestion"),
  toolCallId: z.string().min(1).optional(),
  questions: z.array(ExpertAgentUserQuestionSchema),
  semantics: z.object({ kind: z.literal("approval"), approveOption: z.string().min(1) }).optional(),
  presentation: HumanInteractionRequestSchema.optional(),
}) satisfies z.ZodType<ExpertAgentUserQuestionRequest>;

export const ExpertAgentHumanRequestSchema = z.discriminatedUnion("kind", [
  ExpertAgentToolApprovalRequestSchema,
  ExpertAgentUserQuestionRequestSchema,
]) satisfies z.ZodType<ExpertAgentHumanRequest>;

export const ExpertAgentToolApprovalResponseSchema = z.object({
  kind: z.literal("tool_approval"),
  approved: z.boolean(),
  reason: z.string().optional(),
  updatedInput: z.unknown().optional(),
}) satisfies z.ZodType<ExpertAgentToolApprovalResponse>;

export const ExpertAgentUserQuestionResponseSchema = z.object({
  kind: z.literal("user_question"),
  answered: z.boolean(),
  reason: z.string().optional(),
  answers: z.unknown().optional(),
  notes: z.string().optional(),
}) satisfies z.ZodType<ExpertAgentUserQuestionResponse>;

export const ExpertAgentHumanResponseSchema = z.discriminatedUnion("kind", [
  ExpertAgentToolApprovalResponseSchema,
  ExpertAgentUserQuestionResponseSchema,
]) satisfies z.ZodType<ExpertAgentHumanResponse>;

export type ExpertAgentHumanInteractionHandler = (
  request: ExpertAgentHumanRequest,
) => Promise<ExpertAgentHumanResponse>;

/**
 * Resolves host-approved interactions without putting an execution into a
 * durable waiting state. Returning `undefined` delegates the request to the
 * normal human interaction flow.
 */
export type ExpertAgentAutomaticHumanInteractionHandler = (
  request: ExpertAgentHumanRequest,
) => ExpertAgentHumanResponse | undefined | Promise<ExpertAgentHumanResponse | undefined>;

export type ExpertAgentToolApprovalCondition = (
  request: ExpertAgentToolApprovalRequest,
) => boolean | Promise<boolean>;

export interface ExpertAgentToolApproval {
  /**
   * `ask` is best-effort human confirmation: if the policy applies and an
   * interaction handler exists, the runtime asks before execution. `required`
   * is fail-closed: if the policy applies, execution requires an explicit
   * approval response.
   */
  readonly mode: ExpertAgentToolApprovalMode;
  readonly reason?: string | undefined;
  /**
   * Gates whether this approval policy applies to a specific tool call. When
   * omitted, non-`none` policies apply to every call.
   */
  readonly when?: ExpertAgentToolApprovalCondition | undefined;
}

export interface ExpertAgentManagedToolCallContext {
  readonly toolCallId?: string | undefined;
  readonly humanInteraction?: ExpertAgentHumanInteractionHandler | undefined;
  readonly runContext?: ExpertAgentRunContext | undefined;
  readonly execution?: ExpertToolExecutionContext | undefined;
}

export interface ExpertAgentManagedTool<TName extends string = string, TResult = unknown> {
  readonly name: TName;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly approval?: ExpertAgentToolApproval | undefined;
  readonly call: (
    args: unknown,
    signal: AbortSignal | undefined,
    context?: ExpertAgentManagedToolCallContext,
  ) => Promise<TResult>;
}

export function mergeExpertAgentToolApprovals(
  left: ExpertAgentToolApproval | undefined,
  right: ExpertAgentToolApproval | undefined,
): ExpertAgentToolApproval | undefined {
  if (left === undefined) {
    return right;
  }

  if (right === undefined) {
    return left;
  }

  return {
    mode: maxApprovalMode(left.mode, right.mode),
    ...mergeApprovalReason(left.reason, right.reason),
    ...mergeApprovalCondition(left.when, right.when),
  };
}

export async function resolveExpertAgentToolApprovalRequirement(
  approval: ExpertAgentToolApproval | undefined,
  request: ExpertAgentToolApprovalRequest,
): Promise<ExpertAgentToolApprovalRequirement> {
  if (approval === undefined || approval.mode === "none") {
    return "none";
  }

  if (approval.when !== undefined && !(await approval.when(request))) {
    return "none";
  }

  return approval.mode;
}

function maxApprovalMode(
  left: ExpertAgentToolApprovalMode,
  right: ExpertAgentToolApprovalMode,
): ExpertAgentToolApprovalMode {
  const rank: Record<ExpertAgentToolApprovalMode, number> = {
    none: 0,
    ask: 1,
    required: 2,
  };

  return rank[left] >= rank[right] ? left : right;
}

function mergeApprovalReason(
  left: string | undefined,
  right: string | undefined,
): Pick<ExpertAgentToolApproval, "reason"> | Record<string, never> {
  if (left === undefined) {
    return right === undefined ? {} : { reason: right };
  }

  if (right === undefined || right === left) {
    return { reason: left };
  }

  return { reason: `${left}\n${right}` };
}

function mergeApprovalCondition(
  left: ExpertAgentToolApprovalCondition | undefined,
  right: ExpertAgentToolApprovalCondition | undefined,
): Pick<ExpertAgentToolApproval, "when"> | Record<string, never> {
  // An unconditioned policy applies to every call. Keeping only the other condition would
  // accidentally disable the merged approval outside that condition.
  if (left === undefined || right === undefined) return {};

  if (right === left) {
    return { when: left };
  }

  return {
    when: async (request) => (await left(request)) || (await right(request)),
  };
}
