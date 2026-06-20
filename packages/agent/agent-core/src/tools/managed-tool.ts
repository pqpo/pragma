export interface ExpertAgentToolCallResult {
  readonly text: string;
  readonly isError?: boolean;
  readonly details?: unknown;
}

export interface ExpertAgentManagedTool<TName extends string = string, TResult = unknown> {
  readonly name: TName;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly call: (args: unknown, signal: AbortSignal | undefined) => Promise<TResult>;
}
