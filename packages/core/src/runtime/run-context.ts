export interface ExpertAgentRunSource {
  readonly type: string;
  readonly id?: string | undefined;
  readonly label?: string | undefined;
}

export const TASK_MEMORY_WORKFLOW_RUN_ID_ATTR = "taskMemory.workflowRunId";
export const TASK_MEMORY_TASK_RUN_ID_ATTR = "taskMemory.taskRunId";
export const TASK_MEMORY_RUNTIME_SESSION_ID_ATTR = "taskMemory.runtimeSessionId";

export interface ExpertAgentRunContext {
  readonly source?: ExpertAgentRunSource | undefined;
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
}

export interface TaskMemoryRunScope {
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

export function withTaskMemoryRunScope(
  context: ExpertAgentRunContext | undefined,
  scope: TaskMemoryRunScope,
): ExpertAgentRunContext {
  const base = createExpertAgentRunContext(context);

  return {
    ...base,
    attributes: {
      ...base.attributes,
      ...(scope.workflowRunId === undefined
        ? {}
        : { [TASK_MEMORY_WORKFLOW_RUN_ID_ATTR]: scope.workflowRunId }),
      ...(scope.taskRunId === undefined
        ? {}
        : { [TASK_MEMORY_TASK_RUN_ID_ATTR]: scope.taskRunId }),
      ...(scope.runtimeSessionId === undefined
        ? {}
        : { [TASK_MEMORY_RUNTIME_SESSION_ID_ATTR]: scope.runtimeSessionId }),
    },
  };
}

export function readTaskMemoryRunScope(
  context: ExpertAgentRunContext | undefined,
): TaskMemoryRunScope {
  return {
    workflowRunId: readContextAttribute(context, TASK_MEMORY_WORKFLOW_RUN_ID_ATTR),
    taskRunId: readContextAttribute(context, TASK_MEMORY_TASK_RUN_ID_ATTR),
    runtimeSessionId: readContextAttribute(context, TASK_MEMORY_RUNTIME_SESSION_ID_ATTR),
  };
}

function readContextAttribute(
  context: ExpertAgentRunContext | undefined,
  key: string,
): string | undefined {
  const value = context?.attributes?.[key];

  return typeof value === "string" ? value : undefined;
}
