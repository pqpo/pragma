import type {
  HumanInteractionResponse,
  RunState,
  MailboxMessage,
  TaskRunStatus,
  TaskRunRecord,
  WorkflowRunRecord,
} from "@pragma/shared";
import { LoopStateSchema } from "@pragma/shared";

import type {
  CompiledDirective,
  RunResult,
  LoopStepDefinition,
  LoopStepInputContext,
  LoopStepRef,
  LoopTerminalTarget,
  LoopTransitionTarget,
  StartRunRequest,
  TaskDispatchPayload,
  TaskManager,
  TaskManagerOptions,
  RunHandle,
} from "./types.ts";
import type { RuntimeSessionRef } from "../runtime/runtime-adapter.ts";
import { createId, nowIso, readObjectField } from "./utils.ts";

interface RunContext<TOutput = unknown> {
  readonly resolve: (result: RunResult<TOutput>) => void;
  readonly reject: (error: Error) => void;
}

interface HumanInteractionWaiter {
  readonly taskRunId: string;
  readonly workflowRunId: string;
  readonly resolve: (response: HumanInteractionResponse) => void;
}

const cancellableTaskStatuses = new Set<TaskRunStatus>([
  "pending",
  "dispatched",
  "leased",
  "running",
  "waiting",
]);
const terminalTaskStatuses = new Set<TaskRunStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "dead_letter",
]);
const cancellableWorkflowStatuses = new Set(["running", "waiting"]);

export function createLocalTaskManager(options: TaskManagerOptions): TaskManager {
  const workerId = options.workerId ?? createId("worker");
  const leaseTtlMs = options.leaseTtlMs ?? 60_000;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(leaseTtlMs / 3));
  const runContexts = new Map<string, RunContext>();
  const humanInteractionWaiters = new Map<string, HumanInteractionWaiter>();
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
      throw new Error(`Directive run context is not found: ${workflowRunId}`);
    }

    return context;
  };

  const getLoopDefinition = async (workflowRunId: string) => {
    const definition = await options.loopStore.get(workflowRunId);

    if (definition === undefined) {
      throw new Error(`Directive definition is not found: ${workflowRunId}`);
    }

    return definition;
  };

  const findLoopDefinition = async (workflowRunId: string) => {
    return await options.loopStore.get(workflowRunId);
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
      loop: CompiledDirective<TInput, TOutput>,
      request: StartRunRequest<TInput>,
    ): Promise<RunHandle<TOutput>> {
      await manager.start();
      const input = loop.inputSchema?.parse(request.input) ?? request.input;
      const state = LoopStateSchema.parse({
        input,
      });
      const workflowRunId = createId("workflow");
      const inheritedSandboxRequest =
        request.execution === undefined
          ? undefined
          : {
              strategy: {
                mode: "attach" as const,
                sandboxId: request.execution.sandbox.id,
              },
              workspace:
                request.execution.sandbox.workspaceRoot === undefined
                  ? undefined
                  : {
                      root: request.execution.sandbox.workspaceRoot,
                    },
            };
      const workflowSandbox = await options.sandboxManager.createWorkflowSandbox({
        workflowRunId,
        loopId: loop.id,
        input,
        request: inheritedSandboxRequest,
      });
      const workflow = await options.stateManager.createWorkflowRun({
        id: workflowRunId,
        loopId: loop.id,
        parentWorkflowRunId: request.execution?.workflow.id,
        parentTaskRunId: request.execution?.task.id,
        input,
        state,
        startStepId: loop.startStepId,
        defaultSandbox: workflowSandbox.ref,
      });
      await options.loopStore.save({
        workflowRunId: workflow.id,
        loop,
        request,
      });

      const result = new Promise<RunResult<TOutput>>((resolve, reject) => {
        runContexts.set(workflow.id, {
          resolve: (runResult) => {
            resolve(runResult as RunResult<TOutput>);
          },
          reject,
        });
      });

      await publish({
        kind: "event",
        type: "sandbox.created",
        workflowRunId: workflow.id,
        parentWorkflowRunId: workflow.parentWorkflowRunId,
        parentTaskRunId: workflow.parentTaskRunId,
        payload: workflowSandbox.ref,
      });
      await publish({
        kind: "event",
        type: "workflow.started",
        workflowRunId: workflow.id,
        parentWorkflowRunId: workflow.parentWorkflowRunId,
        parentTaskRunId: workflow.parentTaskRunId,
        payload: {
          loopId: loop.id,
          parentWorkflowRunId: workflow.parentWorkflowRunId,
          parentTaskRunId: workflow.parentTaskRunId,
        },
      });

      void manager.dispatchReadyTasks(workflow.id).catch((error) => {
        void failWorkflow(workflow.id, toError(error), {
          message: error instanceof Error ? error.message : String(error),
        });
      });

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
      const definition = await getLoopDefinition(workflowRunId);
      const workflow = await options.stateManager.getWorkflowRun(workflowRunId);

      if (workflow === undefined || workflow.status !== "running") {
        return;
      }

      for (const stepId of workflow.currentStepIds) {
        const step = definition.loop.steps.get(stepId);

        if (step === undefined) {
          throw new Error(`Directive ${definition.loop.id} references unknown step: ${stepId}`);
        }

        const existingTasks = await options.stateManager.listTaskRuns(workflowRunId);
        const activeTask = existingTasks.find(
          (task) =>
            task.stepId === stepId &&
            ["pending", "dispatched", "leased", "running", "waiting"].includes(task.status),
        );

        if (activeTask !== undefined) {
          continue;
        }

        const visit = existingTasks.filter((task) => task.stepId === stepId).length + 1;
        const limit = definition.loop.limits.get(stepId);

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
        const runtimeId = resolveRuntimeId(
          step,
          definition.request,
          options.runtimes.defaultRuntime,
        );
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
            loopId: definition.loop.id,
            stepId,
            visit,
            input,
            runtime: {
              requestedId: step.runtime ?? definition.request.runtime,
              resolvedId: runtimeId,
            },
            sandbox: step.sandbox ?? {
              strategy: {
                mode: "reuse-workflow",
              },
            },
            policy: {},
          },
        });
      }
    },

    async cancelRun(workflowRunId, reason) {
      await cancelWorkflowTree(workflowRunId, reason);
    },

    async respondToHumanInteraction(request) {
      const result = await options.stateManager.resolveHumanInteraction(request);
      const interaction = result.interaction;

      if (result.duplicate) {
        return interaction;
      }

      await publish({
        kind: "event",
        type: "human.responded",
        workflowRunId: interaction.workflowRunId,
        ...(interaction.taskRunId === undefined ? {} : { taskRunId: interaction.taskRunId }),
        ...(interaction.stepId === undefined ? {} : { stepId: interaction.stepId }),
        payload: {
          interaction,
        },
      });

      if (interaction.taskRunId !== undefined) {
        await options.stateManager.markTaskResumed(interaction.taskRunId);
        await publish({
          kind: "event",
          type: "task.resumed",
          workflowRunId: interaction.workflowRunId,
          taskRunId: interaction.taskRunId,
          ...(interaction.stepId === undefined ? {} : { stepId: interaction.stepId }),
          payload: {
            interactionId: interaction.id,
          },
        });
      }

      const workflow = await options.stateManager.markWorkflowRunning(interaction.workflowRunId);
      await publish({
        kind: "event",
        type: "workflow.resumed",
        workflowRunId: interaction.workflowRunId,
        parentWorkflowRunId: workflow.parentWorkflowRunId,
        parentTaskRunId: workflow.parentTaskRunId,
        payload: {
          interactionId: interaction.id,
        },
      });

      humanInteractionWaiters.get(interaction.id)?.resolve(interaction.response ?? {});
      humanInteractionWaiters.delete(interaction.id);
      return interaction;
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

      const leasedTask = await options.stateManager.markTaskLeased(task.id, workerId, leaseTtlMs);
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
      const definition = await getLoopDefinition(lease.workflow.id);
      const step = definition.loop.steps.get(lease.task.stepId);

      if (step === undefined) {
        throw new Error(`Directive ${definition.loop.id} references unknown step: ${lease.task.stepId}`);
      }

      let sandboxLease:
        | Awaited<ReturnType<typeof options.sandboxManager.resolveTaskSandbox>>
        | undefined;
      let stopHeartbeat: (() => void) | undefined;

      try {
        sandboxLease = await options.sandboxManager.resolveTaskSandbox({
          workflow: lease.workflow,
          task: lease.task,
          request: lease.message.payload.sandbox,
        });
        await options.stateManager.markTaskRunning(lease.task.id, sandboxLease.ref);
        const sandboxEventType =
          lease.message.payload.sandbox.strategy?.mode === "reuse-workflow" ||
          lease.message.payload.sandbox.strategy?.mode === "reuse-step"
            ? "sandbox.reused"
            : "sandbox.attached";
        await publish({
          kind: "event",
          type: sandboxEventType,
          workflowRunId: lease.workflow.id,
          taskRunId: lease.task.id,
          stepId: lease.task.stepId,
          causationId: lease.message.id,
          payload: sandboxLease.ref,
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
        stopHeartbeat = startTaskHeartbeat(lease.task.id, lease.workflow.id, lease.task.stepId);
        await sendTaskHeartbeat(lease.task.id, lease.workflow.id, lease.task.stepId);

        const latestWorkflow = await options.stateManager.getWorkflowRun(lease.workflow.id);

        if (latestWorkflow === undefined) {
          throw new Error(`Workflow run is not found: ${lease.workflow.id}`);
        }

        const stepResult = await executeStep(step, {
          task: lease.task,
          workflow: latestWorkflow,
          state: latestWorkflow.state,
          sandboxLease,
          runtimeId: lease.message.payload.runtime.resolvedId,
          subloopRequest: definition.request,
        });
        const latestTask = await options.stateManager.getTaskRun(lease.task.id);
        const workflowAfterStep = await options.stateManager.getWorkflowRun(lease.workflow.id);

        if (latestTask?.status === "cancelled" || workflowAfterStep?.status === "cancelled") {
          stopHeartbeat();
          stopHeartbeat = undefined;
          await options.sandboxManager.releaseTaskSandbox(sandboxLease, { status: "cancelled" });
          return;
        }

        const parsedOutput =
          (step.output ?? step.loop.outputSchema)?.parse(stepResult.output) ?? stepResult.output;
        await options.stateManager.markTaskSucceeded(lease.task.id, parsedOutput, {
          runtimeSession: stepResult.runtimeSession,
        });
        stopHeartbeat();
        stopHeartbeat = undefined;
        await publish({
          kind: "event",
          type: "task.completed",
          workflowRunId: lease.workflow.id,
          taskRunId: lease.task.id,
          stepId: lease.task.stepId,
          causationId: lease.message.id,
          payload: {
            output: parsedOutput,
            sandbox: sandboxLease.ref,
          },
        });
        await options.sandboxManager.releaseTaskSandbox(sandboxLease, { status: "succeeded" });
      } catch (error) {
        stopHeartbeat?.();
        const latestTask = await options.stateManager.getTaskRun(lease.task.id);

        if (latestTask !== undefined && terminalTaskStatuses.has(latestTask.status)) {
          if (sandboxLease !== undefined) {
            await options.sandboxManager.releaseTaskSandbox(sandboxLease, {
              status: latestTask.status === "cancelled" ? "cancelled" : "failed",
            });
          }
          return;
        }

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
            sandbox: sandboxLease?.ref,
          },
        });

        if (sandboxLease !== undefined) {
          await options.sandboxManager.releaseTaskSandbox(sandboxLease, { status: "failed" });
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

    async recoverExpiredLeases(now) {
      const recovered = await options.stateManager.recoverExpiredLeases(now);

      for (const task of recovered) {
        const definition = await findLoopDefinition(task.workflowRunId);

        if (definition === undefined) {
          continue;
        }

        const step = definition.loop.steps.get(task.stepId);

        if (step === undefined) {
          continue;
        }

        await publish<TaskDispatchPayload>({
          kind: "command",
          type: "task.dispatch",
          workflowRunId: task.workflowRunId,
          taskRunId: task.id,
          stepId: task.stepId,
          payload: {
            taskRunId: task.id,
            workflowRunId: task.workflowRunId,
            loopId: definition.loop.id,
            stepId: task.stepId,
            visit: task.visit,
            input: task.input,
            runtime: {
              requestedId: step.runtime ?? definition.request.runtime,
              resolvedId: task.runtimeId,
            },
            sandbox: step.sandbox ?? {
              strategy: {
                mode: "reuse-workflow",
              },
            },
            policy: {},
          },
        });
      }

      return recovered;
    },
  };

  function startTaskHeartbeat(
    taskRunId: string,
    workflowRunId: string,
    stepId: string,
  ): () => void {
    const interval = setInterval(() => {
      void sendTaskHeartbeat(taskRunId, workflowRunId, stepId).catch(() => undefined);
    }, heartbeatIntervalMs);

    return () => {
      clearInterval(interval);
    };
  }

  async function cancelWorkflowTree(workflowRunId: string, reason?: string | undefined): Promise<void> {
    const latestWorkflow = await options.stateManager.getWorkflowRun(workflowRunId);

    if (latestWorkflow === undefined) {
      throw new Error(`Workflow run is not found: ${workflowRunId}`);
    }

    if (!cancellableWorkflowStatuses.has(latestWorkflow.status)) {
      return;
    }

    const tasks = await options.stateManager.listTaskRuns(workflowRunId);

    for (const task of tasks) {
      if (cancellableTaskStatuses.has(task.status)) {
        await cancelTaskRun(task, reason);
      }
    }

    const children = await options.stateManager.listWorkflowRuns({
      parentWorkflowRunId: workflowRunId,
    });

    for (const child of children) {
      await cancelWorkflowTree(child.id, reason);
    }

    const cancelledWorkflow = await options.stateManager.completeWorkflowRun(
      workflowRunId,
      "cancelled",
    );
    await publish({
      kind: "event",
      type: "workflow.cancelled",
      workflowRunId,
      parentWorkflowRunId: cancelledWorkflow.parentWorkflowRunId,
      parentTaskRunId: cancelledWorkflow.parentTaskRunId,
      payload: {
        reason,
      },
    });
    const context = runContexts.get(workflowRunId);
    context?.reject(new Error(reason ?? "Directive run was cancelled."));
    runContexts.delete(workflowRunId);
    await options.loopStore.delete(workflowRunId);
    await options.sandboxManager.cleanupWorkflowSandboxes(workflowRunId);
  }

  async function cancelTaskRun(
    task: TaskRunRecord,
    reason?: string | undefined,
  ): Promise<void> {
    const latestTask = await options.stateManager.getTaskRun(task.id);

    if (latestTask === undefined || !cancellableTaskStatuses.has(latestTask.status)) {
      return;
    }

    let cancelledTask: TaskRunRecord;

    try {
      cancelledTask = await options.stateManager.markTaskCancelled(task.id, reason);
    } catch (error) {
      const taskAfterError = await options.stateManager.getTaskRun(task.id);

      if (taskAfterError !== undefined && terminalTaskStatuses.has(taskAfterError.status)) {
        return;
      }

      throw error;
    }

    await publish({
      kind: "event",
      type: "task.cancelled",
      workflowRunId: cancelledTask.workflowRunId,
      taskRunId: cancelledTask.id,
      stepId: cancelledTask.stepId,
      payload: {
        reason,
      },
    });
  }

  async function sendTaskHeartbeat(
    taskRunId: string,
    workflowRunId: string,
    stepId: string,
  ): Promise<void> {
    const task = await options.stateManager.renewTaskLease(taskRunId, workerId, leaseTtlMs);
    await publish({
      kind: "event",
      type: "task.heartbeat",
      workflowRunId,
      taskRunId,
      stepId,
      payload: {
        workerId,
        leaseExpiresAt: task.leaseExpiresAt,
      },
    });
  }

  async function executeStep(
    step: LoopStepDefinition,
    context: {
      readonly task: TaskRunRecord;
      readonly workflow: WorkflowRunRecord | undefined;
      readonly state: RunState;
      readonly sandboxLease: Awaited<ReturnType<typeof options.sandboxManager.resolveTaskSandbox>>;
      readonly runtimeId: string;
      readonly subloopRequest: StartRunRequest;
    },
  ): Promise<{
    readonly output: unknown;
    readonly runtimeSession?: RuntimeSessionRef | undefined;
  }> {
    if (context.workflow === undefined) {
      throw new Error("Workflow run is not available for task execution.");
    }

    const result = await step.loop.run({
      input: context.task.input,
      modelName: context.subloopRequest.modelName,
      output: step.output ?? step.loop.outputSchema,
      runtime: context.runtimeId,
      runtimeSession: context.subloopRequest.runtimeSession,
      runtimes: context.subloopRequest.runtimes,
      execution: {
        task: context.task,
        workflow: context.workflow,
        state: context.state,
        workspace: context.sandboxLease.workspace,
        sandbox: context.sandboxLease.ref,
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
        requestHumanInteraction: async ({ request }) => {
          const interaction = await options.stateManager.createHumanInteraction({
            workflowRunId: context.task.workflowRunId,
            taskRunId: context.task.id,
            stepId: context.task.stepId,
            request,
          });
          const responsePromise = new Promise<HumanInteractionResponse>((resolve) => {
            humanInteractionWaiters.set(interaction.id, {
              taskRunId: context.task.id,
              workflowRunId: context.task.workflowRunId,
              resolve,
            });
          });
          await options.stateManager.markTaskWaiting(context.task.id);
          const workflow = await options.stateManager.markWorkflowWaiting(
            context.task.workflowRunId,
          );
          await publish({
            kind: "event",
            type: "task.waiting",
            workflowRunId: context.task.workflowRunId,
            taskRunId: context.task.id,
            stepId: context.task.stepId,
            payload: {
              interactionId: interaction.id,
            },
          });
          await publish({
            kind: "event",
            type: "workflow.waiting",
            workflowRunId: context.task.workflowRunId,
            parentWorkflowRunId: workflow.parentWorkflowRunId,
            parentTaskRunId: workflow.parentTaskRunId,
            payload: {
              interactionId: interaction.id,
            },
          });
          await publish({
            kind: "event",
            type: "human.requested",
            workflowRunId: context.task.workflowRunId,
            taskRunId: context.task.id,
            stepId: context.task.stepId,
            payload: {
              interaction,
            },
          });

          return await responsePromise;
        },
        runLoop:
          options.runLoop ??
          (async () => {
            throw new Error("No loop runner is configured for nested loop execution.");
          }),
      },
    });
    return {
      output: result.output,
      runtimeSession: result.runtimeSession,
    };
  }

  async function handleTaskCompleted(message: MailboxMessage): Promise<void> {
    const transition = await options.stateManager.applyTaskEvent(message);

    if (transition.duplicate || transition.task === undefined) {
      return;
    }

    const definition = await getLoopDefinition(message.workflowRunId);
    const step = definition.loop.steps.get(transition.task.stepId);

    if (step === undefined) {
      throw new Error(
        `Directive ${definition.loop.id} references unknown step: ${transition.task.stepId}`,
      );
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
      definition.loop,
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
    await failWorkflow(
      message.workflowRunId,
      error,
      errorPayload ?? {
        message: error.message,
      },
      message.id,
    );
  }

  async function failWorkflowFromEvent(message: MailboxMessage, error: Error): Promise<void> {
    await failWorkflow(
      message.workflowRunId,
      error,
      {
        message: error.message,
      },
      message.id,
    );
  }

  async function failWorkflow(
    workflowRunId: string,
    error: Error,
    payload: unknown,
    causationId?: string | undefined,
  ): Promise<void> {
    const workflow = await options.stateManager.completeWorkflowRun(workflowRunId, "failed");
    await publish({
      kind: "event",
      type: "workflow.failed",
      workflowRunId,
      parentWorkflowRunId: workflow.parentWorkflowRunId,
      parentTaskRunId: workflow.parentTaskRunId,
      causationId,
      payload,
    });
    const context = runContexts.get(workflowRunId);
    context?.reject(error);
    runContexts.delete(workflowRunId);
    await options.loopStore.delete(workflowRunId);
    await options.sandboxManager.cleanupWorkflowSandboxes(workflowRunId);
  }

  async function completeWithTerminal(
    workflowRunId: string,
    target: LoopTerminalTarget,
    state?: RunState,
  ): Promise<void> {
    if (target.type === "fail") {
      const workflow = await options.stateManager.completeWorkflowRun(workflowRunId, "failed");
      const error = new Error(target.reason ?? "Directive run failed.");
      await publish({
        kind: "event",
        type: "workflow.failed",
        workflowRunId,
        parentWorkflowRunId: workflow.parentWorkflowRunId,
        parentTaskRunId: workflow.parentTaskRunId,
        payload: {
          message: error.message,
        },
      });
      const context = runContexts.get(workflowRunId);
      context?.reject(error);
      runContexts.delete(workflowRunId);
      await options.loopStore.delete(workflowRunId);
      await options.sandboxManager.cleanupWorkflowSandboxes(workflowRunId);
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
    state: RunState,
  ): Promise<void> {
    const context = getRunContext(workflowRunId) as RunContext<TOutput>;
    const definition = await getLoopDefinition(workflowRunId);
    const workflow = await options.stateManager.completeWorkflowRun(workflowRunId, status);
    const output = resolveLoopOutput(definition.loop as CompiledDirective<unknown, TOutput>, state);
    await publish({
      kind: "event",
      type: "workflow.completed",
      workflowRunId,
      parentWorkflowRunId: workflow.parentWorkflowRunId,
      parentTaskRunId: workflow.parentTaskRunId,
      payload: {
        output,
      },
    });
    context.resolve({
      workflowRunId,
      output,
      state,
      runtimeSession: await readLatestRuntimeSession(workflowRunId),
    });
    runContexts.delete(workflowRunId);
    await options.loopStore.delete(workflowRunId);
    await options.sandboxManager.cleanupWorkflowSandboxes(workflowRunId);
  }

  async function readLatestRuntimeSession(
    workflowRunId: string,
  ): Promise<RuntimeSessionRef | undefined> {
    const tasks = await options.stateManager.listTaskRuns(workflowRunId);

    for (let index = tasks.length - 1; index >= 0; index -= 1) {
      const runtimeSession = tasks[index]?.runtimeSession;

      if (runtimeSession !== undefined) {
        return runtimeSession;
      }
    }

    return undefined;
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
  request: StartRunRequest,
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
  loop: CompiledDirective,
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
  loop: CompiledDirective<unknown, TOutput>,
  state: RunState,
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
