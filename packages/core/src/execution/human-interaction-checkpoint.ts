/**
 * Signals a deliberate non-terminal checkpoint while an invocation is waiting
 * for a durable human response. Callers must not turn this error into a failed
 * execution or delegated Agent task; the waiting state has already been committed.
 */
export class HumanInteractionCheckpointError extends Error {
  constructor(readonly executionId: string) {
    super(`Execution checkpointed while waiting for human input: ${executionId}`);
    this.name = "HumanInteractionCheckpointError";
  }
}

export function isHumanInteractionCheckpointError(
  error: unknown,
): error is HumanInteractionCheckpointError {
  return error instanceof HumanInteractionCheckpointError;
}
