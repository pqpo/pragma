import type { ExpertAgentRunContext } from "../runtime/run-context.ts";

export interface ExpertAgentToolCallResult {
  readonly text: string;
  readonly isError?: boolean;
  readonly details?: unknown;
}

export type ExpertAgentToolApprovalMode = "none" | "ask" | "required";

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
  }[];
}

export interface ExpertAgentUserQuestionRequest {
  readonly kind: "user_question";
  readonly toolName: "askUserQuestion";
  readonly toolCallId?: string | undefined;
  readonly questions: readonly ExpertAgentUserQuestion[];
}

export interface ExpertAgentUserQuestionResponse {
  readonly kind: "user_question";
  readonly answered: boolean;
  readonly reason?: string | undefined;
  readonly answers?: unknown;
}

export type ExpertAgentHumanRequest =
  | ExpertAgentToolApprovalRequest
  | ExpertAgentUserQuestionRequest;

export type ExpertAgentHumanResponse =
  | ExpertAgentToolApprovalResponse
  | ExpertAgentUserQuestionResponse;

export type ExpertAgentHumanInteractionHandler = (
  request: ExpertAgentHumanRequest,
) => Promise<ExpertAgentHumanResponse>;

export type ExpertAgentToolApprovalCondition = (
  request: ExpertAgentToolApprovalRequest,
) => boolean | Promise<boolean>;

export interface ExpertAgentToolApproval {
  readonly mode: ExpertAgentToolApprovalMode;
  readonly reason?: string | undefined;
  readonly when?: ExpertAgentToolApprovalCondition | undefined;
}

export interface ExpertAgentManagedToolCallContext {
  readonly toolCallId?: string | undefined;
  readonly humanInteraction?: ExpertAgentHumanInteractionHandler | undefined;
  readonly runContext?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentManagedTool<TName extends string = string, TResult = unknown> {
  readonly name: TName;
  readonly description: string;
  readonly inputSchema: unknown;
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
  if (left === undefined) {
    return right === undefined ? {} : { when: right };
  }

  if (right === undefined || right === left) {
    return { when: left };
  }

  return {
    when: async (request) => (await left(request)) || (await right(request)),
  };
}
