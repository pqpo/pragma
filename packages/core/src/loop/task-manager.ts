import type {
  LoopState,
  MailboxMessage,
  TaskRunRecord,
  WorkflowRunRecord,
} from "@expertmesh/shared";
import { LoopStateSchema } from "@expertmesh/shared";

import type {
  CompiledLoop,
  LoopRunResult,
  LoopStepDefinition,
  LoopStepInputContext,
  LoopStepRef,
  LoopTerminalTarget,
  LoopTransitionTarget,
  StartLoopRunRequest,
  TaskDispatchPayload,
  TaskManager,
  TaskManagerOptions,
  WorkflowRunHandle,
} from "./types.ts";
import { createId, nowIso, readObjectField } from "./utils.ts";

interface RunContext<TInput = unknown, TOutput = unknown> {
  readonly loop: CompiledLoop<TInput, TOutput>;
  readonly request: StartLoopRunRequest<TInput>;
  readonly resolve: (result: LoopRunResult<TOutput>) => void;
  readonly reject: (error: Error) => void;
}

export function createLocalTaskManager(options: TaskManagerOptions): TaskManager {
  const workerId = options.workerId ?? createId("worker");
  const runContexts = new Map<string, RunContext>();
  let startPromise: Promise<void> | undefined;

  const publish = async <TPayload>(
    message: Omit<MailboxMessage<TPayload>, "id" | "occurredAt" | "producer">,
  ): Promise<void> => {
    await options.mailbox.publish({
      ...message,
      id: createId("message"),
      occurredAt: nowIso(),
      producer: {
        id: workerId,
        kind: "task-manager",
      },
    });
  };

  const getRunContext = (workflowRunId: string): RunContext => {
    const context = runContexts.get(workflowRunId);

    if (context === undefined) {
      throw new Error(`Loop run context is not found: ${workflowRunId}`);
    }

    return context;
  };

  const manager: TaskManager = {
    async start() {
      if (startPromise !== undefined) {
        return await startPromise;
      }

      startPromise = options.mailbox
        .subscribe(
          {
            types: ["task.dispatch", "task.completed", "task.failed", "task.cancelled"],
          },
          async (message) => {
            await manager.handleEvent(message);
          },
        )
        .then(() => undefined);
      await startPromise;
    },

    async startRun<TInput, TOutput>(
      loop: CompiledLoop<TInput, TOutput>,
      request: StartLoopRunRequest<TInput>,
    ): Promise<WorkflowRunHandle<TOutput>> {
      await manager.start();
      const input = loop.inputSchema?.parse(request.input) ?? request.input;
      const state = LoopStateSchema.parse({
        input,
      });
      const workflow = await options.stateManager.createWorkflowRun({
        loopId: loop.id,
        input,
        state,
        startStepId: loop.startStepId,
      });

      const result = new Promise<LoopRunResult<TOutput>>((resolve, reject) => {
        runContexts.set(workflow.id, {
          loop,
          request,
          resolve: (runResult) => {
            resolve(runResult as LoopRunResult<TOutput>);
          },
          reject,
        });
      });

      await publish({
        kind: "event",
        type: "workflow.started",
        workflowRunId: workflow.id,
        payload: {
          loopId: loop.id,
        },
      });

      await manager.dispatchReadyTasks(workflow.id);

      return {
        workflowRunId: workflow.id,
        result,
        async cancel(reason) {
          await manager.cancelRun(workflow.id, reason);
        },
      };
    },

    async handleEvent(message) {
      if (message.type === "task.dispatch") {
        const lease = await manager.leaseTask(message as MailboxMessage<TaskDispatchPayload>);

        if (lease !== undefined) {
          await manager.executeTask(lease);
        }

        return;
      }

      if (message.type === "task.completed") {
        try {
          await handleTaskCompleted(message);
        } catch (error) {
          await failWorkflowFromEvent(message, toError(error));
        }

        return;
      }

      if (message.type === "task.failed") {
        await handleTaskFailed(message);
      }
    },

    async dispatchReadyTasks(workflowRunId) {
      const context = getRunContext(workflowRunId);
      const workflow = await options.stateManager.getWorkflowRun(workflowRunId);

      if (workflow === undefined || workflow.status !== "running") {
        return;
      }

      for (const stepId of workflow.currentStepIds) {
        const step = context.loop.steps.get(stepId);

        if (step === undefined) {
          throw new Error(`Loop ${context.loop.id} references unknown step: ${stepId}`);
        }

        const existingTasks = await options.stateManager.listTaskRuns(workflowRunId);
        const activeTask = existingTasks.find(
          (task) =>
            task.stepId === stepId &&
            ["pending", "dispatched", "leased", "running"].includes(task.status),
        );

        if (activeTask !== undefined) {
          continue;
        }

        const visit = existingTasks.filter((task) => task.stepId === stepId).length + 1;
        const limit = context.loop.limits.get(stepId);

        if (limit?.maxVisits !== undefined && visit > limit.maxVisits) {
          await completeWithTerminal(workflowRunId, limit.onExceeded ?? { type: "fail" });
          continue;
        }

        const latestWorkflow = await options.stateManager.getWorkflowRun(workflowRunId);

        if (latestWorkflow === undefined) {
          throw new Error(`Workflow run is not found: ${workflowRunId}`);
        }

        const input = await resolveStepInput(step, {
          task: createSyntheticTask(workflowRunId, stepId, visit),
          workflow: latestWorkflow,
          state: latestWorkflow.state,
        });
        const runtimeId = resolveRuntimeId(step, context.request, options.runtimes.defaultRuntime);
        let task: TaskRunRecord;

        try {
          task = await options.stateManager.createTaskRun({
            workflowRunId,
            stepId,
            visit,
            runtimeId,
            input,
          });
        } catch (error) {
          if (isActiveTaskRunConflict(error)) {
            continue;
          }

          throw error;
        }

        await options.stateManager.markTaskDispatched(task.id);
        await publish<TaskDispatchPayload>({
          kind: "command",
          type: "task.dispatch",
          workflowRunId,
          taskRunId: task.id,
          stepId,
          payload: {
            taskRunId: task.id,
            workflowRunId,
            loopId: context.loop.id,
            stepId,
            visit,
            input,
            runtime: {
              requestedId: step.runtime ?? context.request.runtime,
              resolvedId: runtimeId,
            },
            environment: step.environment ?? {
              strategy: {
                mode: "local-workspace",
              },
            },
            policy: {},
          },
        });
      }
    },

    async cancelRun(workflowRunId, reason) {
      await options.stateManager.completeWorkflowRun(workflowRunId, "cancelled");
      await publish({
        kind: "event",
        type: "workflow.cancelled",
        workflowRunId,
        payload: {
          reason,
        },
      });
      const context = runContexts.get(workflowRunId);
      context?.reject(new Error(reason ?? "Loop run was cancelled."));
      runContexts.delete(workflowRunId);
    },

    async leaseTask(message) {
      const task = await options.stateManager.getTaskRun(message.payload.taskRunId);
      const workflow = await options.stateManager.getWorkflowRun(message.payload.workflowRunId);

      if (task === undefined || workflow === undefined) {
        return undefined;
      }

      if (!["pending", "dispatched"].includes(task.status)) {
        return undefined;
      }

      const leasedTask = await options.stateManager.markTaskLeased(task.id, workerId);
      await publish({
        kind: "event",
        type: "task.leased",
        workflowRunId: workflow.id,
        taskRunId: task.id,
        stepId: task.stepId,
        causationId: message.id,
        payload: {
          workerId,
        },
      });

      return {
        task: leasedTask,
        workflow,
        message,
        workerId,
      };
    },

    async executeTask(lease) {
      const context = getRunContext(lease.workflow.id);
      const step = context.loop.steps.get(lease.task.stepId);

      if (step === undefined) {
        throw new Error(`Loop ${context.loop.id} references unknown step: ${lease.task.stepId}`);
      }

      let environmentLease: Awaited<ReturnType<typeof options.environment.resolve>> | undefined;

      try {
        environmentLease = await options.environment.resolve({
          workflow: lease.workflow,
          task: lease.task,
          request: lease.message.payload.environment,
        });
        await options.stateManager.markTaskRunning(lease.task.id, environmentLease.ref);
        await publish({
          kind: "event",
          type: "environment.attached",
          workflowRunId: lease.workflow.id,
          taskRunId: lease.task.id,
          stepId: lease.task.stepId,
          causationId: lease.message.id,
          payload: environmentLease.ref,
        });
        await publish({
          kind: "event",
          type: "task.started",
          workflowRunId: lease.workflow.id,
          taskRunId: lease.task.id,
          stepId: lease.task.stepId,
          causationId: lease.message.id,
          payload: {},
        });

        const latestWorkflow = await options.stateManager.getWorkflowRun(lease.workflow.id);

        if (latestWorkflow === undefined) {
          throw new Error(`Workflow run is not found: ${lease.workflow.id}`);
        }

        const output = await executeStep(step, {
          task: lease.task,
          workflow: latestWorkflow,
          state: latestWorkflow.state,
          environmentLease,
          runtimeId: lease.message.payload.runtime.resolvedId,
          subloopRequest: context.request,
        });
        const parsedOutput = (step.output ?? step.loop.outputSchema)?.parse(output) ?? output;
        await options.stateManager.markTaskSucceeded(lease.task.id, parsedOutput);
        await publish({
          kind: "event",
          type: "task.completed",
          workflowRunId: lease.workflow.id,
          taskRunId: lease.task.id,
          stepId: lease.task.stepId,
          causationId: lease.message.id,
          payload: {
            output: parsedOutput,
            environment: environmentLease.ref,
          },
        });
        await options.environment.release(environmentLease, { status: "succeeded" });
      } catch (error) {
        const normalizedError = toErrorPayload(error);
        await options.stateManager.markTaskFailed(lease.task.id, normalizedError);
        await publish({
          kind: "event",
          type: "task.failed",
          workflowRunId: lease.workflow.id,
          taskRunId: lease.task.id,
          stepId: lease.task.stepId,
          causationId: lease.message.id,
          payload: {
            error: normalizedError,
            environment: environmentLease?.ref,
          },
        });

        if (environmentLease !== undefined) {
          await options.environment.release(environmentLease, { status: "failed" });
        }
      }
    },

    async cancelTask(taskRunId, reason) {
      const task = await options.stateManager.markTaskCancelled(taskRunId, reason);
      await publish({
        kind: "event",
        type: "task.cancelled",
        workflowRunId: task.workflowRunId,
        taskRunId,
        stepId: task.stepId,
        payload: {
          reason,
        },
      });
    },

    async recoverExpiredLeases() {
      return [];
    },
  };

  async function executeStep(
    step: LoopStepDefinition,
    context: {
      readonly task: TaskRunRecord;
      readonly workflow: WorkflowRunRecord | undefined;
      readonly state: LoopState;
      readonly environmentLease: Awaited<ReturnType<typeof options.environment.resolve>>;
      readonly runtimeId: string;
      readonly subloopRequest: StartLoopRunRequest;
    },
  ): Promise<unknown> {
    if (context.workflow === undefined) {
      throw new Error("Workflow run is not available for task execution.");
    }

    const result = await step.loop.run({
      input: context.task.input,
      output: step.output ?? step.loop.outputSchema,
      runtime: context.runtimeId,
      runtimes: context.subloopRequest.runtimes,
      execution: {
        task: context.task,
        workflow: context.workflow,
        state: context.state,
        workspace: context.environmentLease.workspace,
        environment: context.environmentLease.ref,
        runtimeId: context.runtimeId,
        runtimeRegistry: options.runtimes,
        emitProgress: async (event) => {
          await publish({
            kind: "event",
            type: "task.progress",
            workflowRunId: context.task.workflowRunId,
            taskRunId: context.task.id,
            stepId: context.task.stepId,
            payload: event,
          });
        },
        runLoop:
          options.runLoop ??
          (async () => {
            throw new Error("No loop runner is configured for nested loop execution.");
          }),
      },
    });
    return result.output;
  }

  async function handleTaskCompleted(message: MailboxMessage): Promise<void> {
    const transition = await options.stateManager.applyTaskEvent(message);

    if (transition.duplicate || transition.task === undefined) {
      return;
    }

    const context = getRunContext(message.workflowRunId);
    const step = context.loop.steps.get(transition.task.stepId);

    if (step === undefined) {
      throw new Error(`Loop ${context.loop.id} references unknown step: ${transition.task.stepId}`);
    }

    const workflow = await options.stateManager.getWorkflowRun(message.workflowRunId);

    if (workflow === undefined) {
      throw new Error(`Workflow run is not found: ${message.workflowRunId}`);
    }

    const nextState = await options.stateManager.applyStepReduction({
      workflowRunId: message.workflowRunId,
      taskRunId: transition.task.id,
      stepId: transition.task.stepId,
      output: transition.task.output,
      expectedRevision: workflow.revision,
      reduce: step.reduce,
    });
    const targets = resolveNextTargets(
      context.loop,
      transition.task.stepId,
      transition.task.output,
    );

    if (targets.length === 0) {
      await completeRun(message.workflowRunId, "succeeded", nextState);
      return;
    }

    const terminal = targets.find(isTerminalTarget);

    if (terminal !== undefined) {
      await completeWithTerminal(message.workflowRunId, terminal, nextState);
      return;
    }

    const stepTargets = targets.filter(isStepRef);
    await options.stateManager.setCurrentStepIds(
      message.workflowRunId,
      stepTargets.map((target) => target.id),
    );
    await manager.dispatchReadyTasks(message.workflowRunId);
  }

  async function handleTaskFailed(message: MailboxMessage): Promise<void> {
    const transition = await options.stateManager.applyTaskEvent(message);

    if (transition.duplicate) {
      return;
    }

    const errorPayload = readObjectField(message.payload, "error");
    const error = toError(errorPayload);
    await options.stateManager.completeWorkflowRun(message.workflowRunId, "failed");
    await publish({
      kind: "event",
      type: "workflow.failed",
      workflowRunId: message.workflowRunId,
      causationId: message.id,
      payload: errorPayload ?? {
        message: error.message,
      },
    });
    const context = runContexts.get(message.workflowRunId);
    context?.reject(error);
    runContexts.delete(message.workflowRunId);
  }

  async function failWorkflowFromEvent(message: MailboxMessage, error: Error): Promise<void> {
    await options.stateManager.completeWorkflowRun(message.workflowRunId, "failed");
    await publish({
      kind: "event",
      type: "workflow.failed",
      workflowRunId: message.workflowRunId,
      causationId: message.id,
      payload: {
        message: error.message,
      },
    });
    const context = runContexts.get(message.workflowRunId);
    context?.reject(error);
    runContexts.delete(message.workflowRunId);
  }

  async function completeWithTerminal(
    workflowRunId: string,
    target: LoopTerminalTarget,
    state?: LoopState,
  ): Promise<void> {
    if (target.type === "fail") {
      await options.stateManager.completeWorkflowRun(workflowRunId, "failed");
      const error = new Error(target.reason ?? "Loop run failed.");
      await publish({
        kind: "event",
        type: "workflow.failed",
        workflowRunId,
        payload: {
          message: error.message,
        },
      });
      const context = runContexts.get(workflowRunId);
      context?.reject(error);
      runContexts.delete(workflowRunId);
      return;
    }

    const workflow = await options.stateManager.getWorkflowRun(workflowRunId);

    if (workflow === undefined) {
      throw new Error(`Workflow run is not found: ${workflowRunId}`);
    }

    await completeRun(workflowRunId, "succeeded", state ?? workflow.state);
  }

  async function completeRun<TOutput>(
    workflowRunId: string,
    status: "succeeded",
    state: LoopState,
  ): Promise<void> {
    const context = getRunContext(workflowRunId) as RunContext<unknown, TOutput>;
    await options.stateManager.completeWorkflowRun(workflowRunId, status);
    const output = resolveLoopOutput(context.loop, state);
    await publish({
      kind: "event",
      type: "workflow.completed",
      workflowRunId,
      payload: {
        output,
      },
    });
    context.resolve({
      workflowRunId,
      output,
      state,
    });
    runContexts.delete(workflowRunId);
  }

  return manager;
}

async function resolveStepInput(
  step: LoopStepDefinition,
  context: LoopStepInputContext,
): Promise<unknown> {
  if (typeof step.input === "function") {
    return await step.input(context);
  }

  if (step.input !== undefined) {
    return step.input;
  }

  return context.state.input;
}

function resolveRuntimeId(
  step: LoopStepDefinition,
  request: StartLoopRunRequest,
  defaultRuntime: string,
): string {
  return request.runtimes?.[step.id] ?? step.runtime ?? request.runtime ?? defaultRuntime;
}

function createSyntheticTask(workflowRunId: string, stepId: string, visit: number): TaskRunRecord {
  const timestamp = nowIso();
  return {
    id: "pending",
    workflowRunId,
    stepId,
    visit,
    status: "pending",
    runtimeId: "pending",
    input: undefined,
    attempt: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function resolveNextTargets(
  loop: CompiledLoop,
  stepId: string,
  output: unknown,
): LoopTransitionTarget[] {
  const transitions = loop.transitions.filter((transition) => transition.from === stepId);

  if (transitions.length === 0) {
    return [];
  }

  const targets: LoopTransitionTarget[] = [];

  for (const transition of transitions) {
    if (transition.type === "next") {
      targets.push(transition.to);
      continue;
    }

    const routeValue = readObjectField(output, transition.field);
    const target = routeValue === undefined ? undefined : transition.cases.get(String(routeValue));

    if (target === undefined) {
      if (transition.fallback === undefined) {
        if (routeValue === undefined) {
          throw new Error(
            `Route ${stepId}.${transition.field} did not match because output field is missing.`,
          );
        }

        throw new Error(
          `Route ${stepId}.${transition.field} did not match output value: ${String(routeValue)}`,
        );
      }

      targets.push(transition.fallback);
    } else {
      targets.push(target);
    }
  }

  return targets;
}

function isTerminalTarget(target: LoopTransitionTarget): target is LoopTerminalTarget {
  return "type" in target && (target.type === "end" || target.type === "fail");
}

function isStepRef(target: LoopTransitionTarget): target is LoopStepRef {
  return !isTerminalTarget(target);
}

function isActiveTaskRunConflict(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Active task run already exists ");
}

function resolveLoopOutput<TOutput>(
  loop: CompiledLoop<unknown, TOutput>,
  state: LoopState,
): TOutput {
  const candidate =
    loop.resolveOutput?.({ state }) ??
    (state.results["final"] !== undefined
      ? state.results["final"]
      : Object.keys(state.results).length > 0
        ? state.results
        : state);

  return loop.outputSchema?.parse(candidate) ?? (candidate as TOutput);
}

function toErrorPayload(error: unknown): { code: string; message: string; retryable: boolean } {
  return {
    code: "task_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function toError(payload: unknown): Error {
  const message = readObjectField(payload, "message");
  return new Error(typeof message === "string" ? message : "Task failed.");
}
