import type { ExpertAgent } from "../agent/expert-agent.ts";
import type { DirectiveExecutionContext } from "../directive/types.ts";
import { readExecutionRunScope } from "./run-context.ts";
import type {
  RuntimeAdapter,
  RuntimeAgentSession,
  RuntimeDriverSessionRequest,
  RuntimeSessionOwner,
} from "./runtime-adapter.ts";

export interface OpenRuntimeSessionRequest
  extends Omit<RuntimeDriverSessionRequest, "agent" | "workflowExecution"> {
  readonly agent: ExpertAgent;
  readonly execution: DirectiveExecutionContext;
}

export interface OwnedRuntimeSessionRequest extends RuntimeDriverSessionRequest {
  readonly owner: RuntimeSessionOwner;
}

type RuntimeSessionFactory = (
  request: OwnedRuntimeSessionRequest,
) => Promise<RuntimeAgentSession>;

const runtimeSessionFactories = new WeakMap<RuntimeAdapter, RuntimeSessionFactory>();

export function registerRuntimeSessionFactory(
  runtime: RuntimeAdapter,
  factory: RuntimeSessionFactory,
): void {
  runtimeSessionFactories.set(runtime, factory);
}

export async function openRuntimeSession(
  runtime: RuntimeAdapter,
  request: OpenRuntimeSessionRequest,
): Promise<RuntimeAgentSession> {
  const execution = request.execution;

  if (execution.task.workflowRunId !== execution.workflow.id) {
    throw new Error(
      `Runtime session execution mismatch: task ${execution.task.id} belongs to Workflow ${execution.task.workflowRunId}, not ${execution.workflow.id}.`,
    );
  }

  const scope = readExecutionRunScope(request.context);
  if (scope.workflowRunId !== execution.workflow.id || scope.taskRunId !== execution.task.id) {
    throw new Error(
      `Runtime session execution scope must match Workflow ${execution.workflow.id} and task ${execution.task.id}.`,
    );
  }

  const factory = runtimeSessionFactories.get(runtime);
  if (factory === undefined) {
    throw new Error(
      `Runtime adapter ${runtime.descriptor.id} has no internal Session factory. Create it with defineRuntimeDriver().`,
    );
  }

  return await factory({
    ...request,
    workflowExecution: execution,
    owner: {
      workflowRunId: execution.workflow.id,
      taskRunId: execution.task.id,
    },
  });
}
