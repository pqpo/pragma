export interface ExpertAgentRunSource {
  readonly type: string;
  readonly id?: string | undefined;
  readonly label?: string | undefined;
}

export const EXECUTION_WORKFLOW_RUN_ID_ATTR = "execution.workflowRunId";
export const EXECUTION_TASK_RUN_ID_ATTR = "execution.taskRunId";
export const EXECUTION_RUNTIME_SESSION_ID_ATTR = "execution.runtimeSessionId";

export interface ExpertAgentRunContext {
  readonly source?: ExpertAgentRunSource | undefined;
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
}

export interface ExecutionRunScope {
  readonly workflowRunId?: string | undefined;
  readonly taskRunId?: string | undefined;
  readonly runtimeSessionId?: string | undefined;
}

export function createExpertAgentRunContext(
  context: ExpertAgentRunContext | undefined = undefined,
): ExpertAgentRunContext {
  return {
    source: {
      type: "system",
      ...(context?.source ?? {}),
    },
    attributes: {
      ...(context?.attributes ?? {}),
    },
  };
}

export function withExecutionRunScope(
  context: ExpertAgentRunContext | undefined,
  scope: ExecutionRunScope,
): ExpertAgentRunContext {
  const base = createExpertAgentRunContext(context);

  return {
    ...base,
    attributes: {
      ...base.attributes,
      ...(scope.workflowRunId === undefined
        ? {}
        : { [EXECUTION_WORKFLOW_RUN_ID_ATTR]: scope.workflowRunId }),
      ...(scope.taskRunId === undefined
        ? {}
        : { [EXECUTION_TASK_RUN_ID_ATTR]: scope.taskRunId }),
      ...(scope.runtimeSessionId === undefined
        ? {}
        : { [EXECUTION_RUNTIME_SESSION_ID_ATTR]: scope.runtimeSessionId }),
    },
  };
}

export function readExecutionRunScope(
  context: ExpertAgentRunContext | undefined,
): ExecutionRunScope {
  return {
    workflowRunId: readContextAttribute(context, EXECUTION_WORKFLOW_RUN_ID_ATTR),
    taskRunId: readContextAttribute(context, EXECUTION_TASK_RUN_ID_ATTR),
    runtimeSessionId: readContextAttribute(context, EXECUTION_RUNTIME_SESSION_ID_ATTR),
  };
}

function readContextAttribute(
  context: ExpertAgentRunContext | undefined,
  key: string,
): string | undefined {
  const value = context?.attributes?.[key];

  return typeof value === "string" ? value : undefined;
}
