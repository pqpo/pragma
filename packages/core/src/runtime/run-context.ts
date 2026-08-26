import { RuntimeSessionRefSchema, type RuntimeSessionRef } from "@pragma/shared";

export interface ExpertAgentRunSource {
  readonly type: string;
  readonly id?: string | undefined;
  readonly label?: string | undefined;
}

export const EXECUTION_ID_ATTR = "execution.executionId";
export const INVOCATION_ID_ATTR = "execution.invocationId";
export const EXECUTION_RUNTIME_SESSION_ATTR = "execution.runtimeSession";
export const EXECUTION_CURRENT_EXPERT_ID_ATTR = "execution.currentExpertId";
export const EXECUTION_CURRENT_TEAM_ID_ATTR = "execution.currentTeamId";
export const EXECUTION_CONTEXT_ID_ATTR = "execution.contextId";

export interface ExpertAgentRunContext {
  readonly source?: ExpertAgentRunSource | undefined;
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
}

export interface ExecutionRunScope {
  readonly executionId?: string | undefined;
  readonly invocationId?: string | undefined;
  readonly contextId?: string | undefined;
  readonly runtimeSession?: RuntimeSessionRef | undefined;
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
      ...(scope.executionId === undefined ? {} : { [EXECUTION_ID_ATTR]: scope.executionId }),
      ...(scope.invocationId === undefined ? {} : { [INVOCATION_ID_ATTR]: scope.invocationId }),
      ...(scope.contextId === undefined ? {} : { [EXECUTION_CONTEXT_ID_ATTR]: scope.contextId }),
      ...(scope.runtimeSession === undefined
        ? {}
        : {
            [EXECUTION_RUNTIME_SESSION_ATTR]: RuntimeSessionRefSchema.parse(scope.runtimeSession),
          }),
    },
  };
}

export function readExecutionRunScope(
  context: ExpertAgentRunContext | undefined,
): ExecutionRunScope {
  return {
    executionId: readContextAttribute(context, EXECUTION_ID_ATTR),
    invocationId: readContextAttribute(context, INVOCATION_ID_ATTR),
    contextId: readContextAttribute(context, EXECUTION_CONTEXT_ID_ATTR),
    runtimeSession: readRuntimeSessionAttribute(context),
  };
}

function readRuntimeSessionAttribute(
  context: ExpertAgentRunContext | undefined,
): RuntimeSessionRef | undefined {
  const value = context?.attributes?.[EXECUTION_RUNTIME_SESSION_ATTR];
  const parsed = RuntimeSessionRefSchema.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

function readContextAttribute(
  context: ExpertAgentRunContext | undefined,
  key: string,
): string | undefined {
  const value = context?.attributes?.[key];

  return typeof value === "string" ? value : undefined;
}
