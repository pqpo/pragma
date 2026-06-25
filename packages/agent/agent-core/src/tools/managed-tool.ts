export interface ExpertAgentToolCallResult {
  readonly text: string;
  readonly isError?: boolean;
  readonly details?: unknown;
}

export type ExpertAgentToolApprovalMode = "none" | "ask" | "required";

export interface ExpertAgentToolApprovalRequest {
  readonly toolName: string;
  readonly toolCallId?: string | undefined;
  readonly reason?: string | undefined;
  readonly input: unknown;
}

export interface ExpertAgentToolApprovalResponse {
  readonly approved: boolean;
  readonly reason?: string | undefined;
  readonly updatedInput?: unknown;
}

export type ExpertAgentToolApprovalHandler = (
  request: ExpertAgentToolApprovalRequest,
) => Promise<ExpertAgentToolApprovalResponse>;

export interface ExpertAgentToolApproval {
  readonly mode: ExpertAgentToolApprovalMode;
  readonly reason?: string | undefined;
}

export interface ExpertAgentManagedToolCallContext {
  readonly toolCallId?: string | undefined;
  readonly approval?: ExpertAgentToolApprovalHandler | undefined;
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
