import type {
  HumanInteractionResponse,
  RunState,
  MailboxMessage,
  TaskRunStatus,
  TaskRunRecord,
  WorkflowRunRecord,
} from "@pragma/shared";
import { RunStateSchema } from "@pragma/shared";

import type {
  CompiledDirective,
  RunResult,
  StepDefinition,
  StepInputContext,
  StepRef,
  TerminalTarget,
  TransitionTarget,
  StartRunRequest,
  TaskDispatchPayload,
  TaskManager,
  TaskManagerOptions,
  TaskManagerStartRunOptions,
  RunHandle,
} from "./types.ts";
import type { RuntimeSessionRef } from "../runtime/runtime-adapter.ts";
import { createEmptyRunEvents, createRunEventChannel } from "./run-event-channel.ts";
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

interface PreparedTaskDispatch {
  readonly task: TaskRunRecord;
  readonly payload: TaskDispatchPayload;
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
    const workflow = await options.stateManager.getWorkflowRun(message.workflowRunId);
    if (workflow === undefined) {
      throw new Error(`Workflow run is not found: ${message.workflowRunId}`);
    }
    const fullMessage = {
      ...message,
      parentWorkflowRunId: message.parentWorkflowRunId ?? workflow.parentWorkflowRunId,
      parentTaskRunId: message.parentTaskRunId ?? workflow.parentTaskRunId,
      id: createId("message"),
      occurredAt: nowIso(),
      producer: {
        id: workerId,
        kind: "task-manager",
      },
    } as MailboxMessage<TPayload>;
    await options.eventStore.append(fullMessage, workflow.rootWorkflowRunId);
    await options.mailbox.publish(fullMessage);
  };

  const getRunContext = (workflowRunId: string): RunContext => {
    const context = runContexts.get(workflowRunId);

    if (context === undefined) {
      throw new Error(`Directive run context is not found: ${workflowRunId}`);
    }

    return context;
  };

  const getDirectiveDefinition = async (workflowRunId: string) => {
    const definition = await options.directiveStore.get(workflowRunId);

    if (definition === undefined) {
      throw new Error(`Directive definition is not found: ${workflowRunId}`);
    }

    return definition;
  };

  const findDirectiveDefinition = async (workflowRunId: string) => {
    return await options.directiveStore.get(workflowRunId);
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
      directive: CompiledDirective<TInput, TOutput>,
      request: StartRunRequest<TInput>,
      startOptions: TaskManagerStartRunOptions = {},
    ): Promise<RunHandle<TOutput>> {
      await manager.start();
      const input = directive.inputSchema?.parse(request.input) ?? request.input;
      const state = RunStateSchema.parse({
        input,
        execution: {
          runtime: request.runtime,
          modelName: request.modelName,
          thinkingLevel: request.thinkingLevel,
          runtimes: request.runtimes,
        },
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
        directiveId: directive.id,
        input,
        request: inheritedSandboxRequest,
      });
      const workflow = await options.stateManager.createWorkflowRun({
        id: workflowRunId,
        directiveId: directive.id,
        directiveVersion: directive.version,
        parentWorkflowRunId: request.execution?.workflow.id,
        parentTaskRunId: request.execution?.task.id,
        continuationKey: request.continuationKey,
        input,
        state,
        startStepId: directive.startStepId,
        defaultSandbox: workflowSandbox.ref,
      });
      await options.directiveStore.save({
        workflowRunId: workflow.id,
        directive,
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
      void result.catch(() => undefined);

      const initialDispatches = await prepareReadyTaskDispatches(workflow.id);
      const events =
        startOptions.events === "none"
          ? createEmptyRunEvents()
          : await createRunEventChannel({
              eventStore: options.eventStore,
              stateManager: options.stateManager,
              rootWorkflowRunId: workflow.id,
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
          directiveId: directive.id,
          parentWorkflowRunId: workflow.parentWorkflowRunId,
          parentTaskRunId: workflow.parentTaskRunId,
        },
      });

      void dispatchPreparedTasks(initialDispatches).catch((error) => {
        void failWorkflow(workflow.id, toError(error), {
          message: error instanceof Error ? error.message : String(error),
        });
      });

      return {
        workflowRunId: workflow.id,
        events,
        result,
        async cancel(reason) {
          await manager.cancelRun(workflow.id, reason);
        },
      };
    },

    async resumeRun<TOutput>(
      directive: CompiledDirective<unknown, TOutput>,
      workflowRunId: string,
      startOptions: TaskManagerStartRunOptions = {},
    ): Promise<RunHandle<TOutput>> {
      await manager.start();
      const workflow = await options.stateManager.getWorkflowRun(workflowRunId);
      if (workflow === undefined) throw new Error(`Workflow run is not found: ${workflowRunId}`);
      if (
        workflow.directiveId !== directive.id ||
        workflow.directiveVersion !== directive.version
      ) {
        throw new Error(
          `Workflow definition mismatch for ${workflowRunId}: persisted ${workflow.directiveId}@${workflow.directiveVersion}, received ${directive.id}@${directive.version}.`,
        );
      }
      await options.directiveStore.save({
        workflowRunId,
        directive,
        request: { input: workflow.input, ...workflow.execution },
      });
      const cursor = await options.eventStore.latest(workflow.rootWorkflowRunId);
      let resolveResult!: (value: RunResult<TOutput>) => void;
      let rejectResult!: (error: Error) => void;
      const result = new Promise<RunResult<TOutput>>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      void result.catch(() => undefined);
      runContexts.set(workflowRunId, {
        resolve: (value) => resolveResult(value as RunResult<TOutput>),
        reject: rejectResult,
      });
      if (workflow.result?.status === "succeeded") {
        const output =
          directive.outputSchema?.parse(workflow.result.output) ?? workflow.result.output;
        resolveResult({ workflowRunId, output: output as TOutput, state: workflow.state });
        runContexts.delete(workflowRunId);
      } else if (workflow.result?.status === "failed" || workflow.result?.status === "cancelled") {
        rejectResult(new Error(readResultError(workflow.result.error)));
        runContexts.delete(workflowRunId);
      } else {
        for (const task of await options.stateManager.listTaskRuns(workflowRunId)) {
          if (task.status === "succeeded" && !task.transitionApplied) {
            await publish({
              kind: "event",
              type: "task.completed",
              workflowRunId,
              taskRunId: task.id,
              stepId: task.stepId,
              payload: { output: task.output, recovered: true },
            });
          }
        }
        const reconciledWorkflow = await options.stateManager.getWorkflowRun(workflowRunId);
        if (
          reconciledWorkflow !== undefined &&
          !["succeeded", "failed", "cancelled"].includes(reconciledWorkflow.status)
        ) {
          await manager.recoverExpiredLeases(new Date(8640000000000000), workflowRunId);
          await manager.dispatchReadyTasks(workflowRunId);
        }
      }
      const events =
        startOptions.events === "none"
          ? createEmptyRunEvents()
          : await createRunEventChannel({
              eventStore: options.eventStore,
              stateManager: options.stateManager,
              rootWorkflowRunId: workflow.rootWorkflowRunId,
              after: cursor,
            });
      return {
        workflowRunId,
        events,
        result,
        cancel: async (reason) => manager.cancelRun(workflowRunId, reason),
      };
    },

    async continueRun<TInput, TOutput>(
      directive: CompiledDirective<TInput, TOutput>,
      workflowRunId: string,
      request: StartRunRequest<TInput>,
      startOptions: TaskManagerStartRunOptions = {},
    ): Promise<RunHandle<TOutput>> {
      await manager.start();
      const input = directive.inputSchema?.parse(request.input) ?? request.input;
      const previousSession = await readLatestRuntimeSession(workflowRunId);
      const workflow = await options.stateManager.continueWorkflowRun(
        workflowRunId,
        input,
        directive.startStepId,
      );
      await options.directiveStore.save({
        workflowRunId,
        directive,
        request: {
          ...request,
          input,
          systemSessionId: previousSession?.systemSessionId,
          runtimeSession: previousSession?.runtimeSession,
          runtimeSessionOwnerTaskRunId: previousSession?.taskRunId,
        },
      });
      const cursor = await options.eventStore.latest(workflow.rootWorkflowRunId);
      const result = new Promise<RunResult<TOutput>>((resolve, reject) => {
        runContexts.set(workflowRunId, {
          resolve: (value) => resolve(value as RunResult<TOutput>),
          reject,
        });
      });
      void result.catch(() => undefined);
      const events =
        startOptions.events === "none"
          ? createEmptyRunEvents()
          : await createRunEventChannel({
              eventStore: options.eventStore,
              stateManager: options.stateManager,
              rootWorkflowRunId: workflow.rootWorkflowRunId,
              after: cursor,
            });
      await publish({
        kind: "event",
        type: "workflow.resumed",
        workflowRunId,
        parentWorkflowRunId: workflow.parentWorkflowRunId,
        parentTaskRunId: workflow.parentTaskRunId,
        payload: { continuation: true },
      });
      void manager.dispatchReadyTasks(workflowRunId).catch((error) => {
        void failWorkflow(workflowRunId, toError(error), { message: String(error) });
      });
      return {
        workflowRunId,
        events,
        result,
        cancel: async (reason) => manager.cancelRun(workflowRunId, reason),
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
      await dispatchPreparedTasks(await prepareReadyTaskDispatches(workflowRunId));
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

      const waiter = humanInteractionWaiters.get(interaction.id);
      waiter?.resolve(interaction.response ?? {});
      humanInteractionWaiters.delete(interaction.id);
      if (waiter === undefined) {
        await manager.recoverExpiredLeases(new Date(), interaction.workflowRunId);
      }
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

      let leasedTask: TaskRunRecord;
      try {
        leasedTask = await options.stateManager.markTaskLeased(task.id, workerId, leaseTtlMs);
      } catch (error) {
        const latestTask = await options.stateManager.getTaskRun(task.id);
        if (
          latestTask === undefined ||
          !["pending", "dispatched"].includes(latestTask.status)
        ) {
          return undefined;
        }
        throw error;
      }
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
      const definition = await getDirectiveDefinition(lease.workflow.id);
      const step = definition.directive.steps.get(lease.task.stepId);

      if (step === undefined) {
        throw new Error(
          `Directive ${definition.directive.id} references unknown step: ${lease.task.stepId}`,
        );
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
          runRequest: definition.request,
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
          (step.output ?? step.directive.outputSchema)?.parse(stepResult.output) ??
          stepResult.output;
        await options.stateManager.markTaskSucceeded(lease.task.id, parsedOutput, {
          systemSessionId: stepResult.systemSessionId,
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

    async recoverExpiredLeases(now, workflowRunId) {
      const recovered = await options.stateManager.recoverExpiredLeases(now, workflowRunId);

      for (const task of recovered) {
        const definition = await findDirectiveDefinition(task.workflowRunId);

        if (definition === undefined) {
          continue;
        }

        const step = definition.directive.steps.get(task.stepId);

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
            directiveId: definition.directive.id,
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

  async function prepareReadyTaskDispatches(
    workflowRunId: string,
  ): Promise<readonly PreparedTaskDispatch[]> {
    const workflow = await options.stateManager.getWorkflowRun(workflowRunId);

    if (workflow === undefined || workflow.status !== "running") {
      return [];
    }
    const definition = await getDirectiveDefinition(workflowRunId);

    const prepared: PreparedTaskDispatch[] = [];
    for (const stepId of workflow.currentStepIds) {
      const step = definition.directive.steps.get(stepId);

      if (step === undefined) {
        throw new Error(`Directive ${definition.directive.id} references unknown step: ${stepId}`);
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
      const limit = definition.directive.limits.get(stepId);

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
      const runtimeId = resolveRuntimeId(step, definition.request, options.runtimes.defaultRuntime);
      let task: TaskRunRecord;

      try {
        task = await options.stateManager.createTaskRun({
          workflowRunId,
          stepId,
          definition: {
            id: step.directive.id,
            version: step.directive.version,
            kind: readDefinitionKind(step.directive),
          },
          visit,
          runtimeId,
          input,
          systemSessionId: definition.request.systemSessionId,
          runtimeSession: definition.request.runtimeSession,
          runtimeSessionOwnerTaskRunId: definition.request.runtimeSessionOwnerTaskRunId,
        });
      } catch (error) {
        if (isActiveTaskRunConflict(error)) {
          continue;
        }
        throw error;
      }

      prepared.push({
        task,
        payload: {
          taskRunId: task.id,
          workflowRunId,
          directiveId: definition.directive.id,
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

    return prepared;
  }

  async function dispatchPreparedTasks(prepared: readonly PreparedTaskDispatch[]): Promise<void> {
    for (const item of prepared) {
      await options.stateManager.markTaskDispatched(item.task.id);
      await publish<TaskDispatchPayload>({
        kind: "command",
        type: "task.dispatch",
        workflowRunId: item.task.workflowRunId,
        taskRunId: item.task.id,
        stepId: item.task.stepId,
        payload: item.payload,
      });
    }
  }

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

  async function cancelWorkflowTree(
    workflowRunId: string,
    reason?: string | undefined,
  ): Promise<void> {
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
    await options.stateManager.setWorkflowResult(workflowRunId, {
      status: "cancelled",
      error: { message: reason ?? "Directive run was cancelled." },
    });
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
    await options.directiveStore.delete(workflowRunId);
    await options.sandboxManager.cleanupWorkflowSandboxes(workflowRunId);
  }

  async function cancelTaskRun(task: TaskRunRecord, reason?: string | undefined): Promise<void> {
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
    step: StepDefinition,
    context: {
      readonly task: TaskRunRecord;
      readonly workflow: WorkflowRunRecord | undefined;
      readonly state: RunState;
      readonly sandboxLease: Awaited<ReturnType<typeof options.sandboxManager.resolveTaskSandbox>>;
      readonly runtimeId: string;
      readonly runRequest: StartRunRequest;
    },
  ): Promise<{
    readonly output: unknown;
    readonly systemSessionId?: string | undefined;
    readonly runtimeSession?: RuntimeSessionRef | undefined;
  }> {
    if (context.workflow === undefined) {
      throw new Error("Workflow run is not available for task execution.");
    }

    const result = await step.directive.run({
      input: context.task.input,
      modelName: context.runRequest.modelName,
      thinkingLevel: context.runRequest.thinkingLevel,
      output: step.output ?? step.directive.outputSchema,
      runtime: context.runtimeId,
      systemSessionId: context.task.systemSessionId ?? context.runRequest.systemSessionId,
      runtimeSession: context.task.runtimeSession ?? context.runRequest.runtimeSession,
      runtimes: context.runRequest.runtimes,
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
          if (interaction.status === "responded") {
            return interaction.response ?? {};
          }
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
        checkpointRuntimeSession: async (checkpoint) => {
          await options.stateManager.checkpointRuntimeSession(context.task.id, checkpoint);
        },
        runDirective:
          options.runDirective ??
          (async () => {
            throw new Error("No directive runner is configured for nested directive execution.");
          }),
      },
    });
    return {
      output: result.output,
      systemSessionId: result.systemSessionId,
      runtimeSession: result.runtimeSession,
    };
  }

  async function handleTaskCompleted(message: MailboxMessage): Promise<void> {
    const transition = await options.stateManager.applyTaskEvent(message);

    if (transition.duplicate || transition.task === undefined) {
      return;
    }

    const definition = await getDirectiveDefinition(message.workflowRunId);
    const step = definition.directive.steps.get(transition.task.stepId);

    if (step === undefined) {
      throw new Error(
        `Directive ${definition.directive.id} references unknown step: ${transition.task.stepId}`,
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
      definition.directive,
      transition.task.stepId,
      transition.task.output,
    );

    if (targets.length === 0) {
      await completeRun(message.workflowRunId, "succeeded", nextState);
      await options.stateManager.markTaskTransitionApplied(transition.task.id);
      return;
    }

    const terminal = targets.find(isTerminalTarget);

    if (terminal !== undefined) {
      await completeWithTerminal(message.workflowRunId, terminal, nextState);
      await options.stateManager.markTaskTransitionApplied(transition.task.id);
      return;
    }

    const stepTargets = targets.filter(isStepRef);
    await options.stateManager.setCurrentStepIds(
      message.workflowRunId,
      stepTargets.map((target) => target.id),
    );
    await options.stateManager.markTaskTransitionApplied(transition.task.id);
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
    await options.stateManager.setWorkflowResult(workflowRunId, {
      status: "failed",
      error: payload,
    });
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
    await options.directiveStore.delete(workflowRunId);
    await options.sandboxManager.cleanupWorkflowSandboxes(workflowRunId);
  }

  async function completeWithTerminal(
    workflowRunId: string,
    target: TerminalTarget,
    state?: RunState,
  ): Promise<void> {
    if (target.type === "fail") {
      const workflow = await options.stateManager.completeWorkflowRun(workflowRunId, "failed");
      const error = new Error(target.reason ?? "Directive run failed.");
      await options.stateManager.setWorkflowResult(workflowRunId, {
        status: "failed",
        error: { message: error.message },
      });
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
      await options.directiveStore.delete(workflowRunId);
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
    const definition = await getDirectiveDefinition(workflowRunId);
    const workflow = await options.stateManager.completeWorkflowRun(workflowRunId, status);
    const output = resolveDirectiveOutput(
      definition.directive as CompiledDirective<unknown, TOutput>,
      state,
    );
    await options.stateManager.setWorkflowResult(workflowRunId, { status: "succeeded", output });
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
    const latestRuntimeSession = await readLatestRuntimeSession(workflowRunId);
    context.resolve({
      workflowRunId,
      output,
      state,
      systemSessionId: latestRuntimeSession?.systemSessionId,
      runtimeSession: latestRuntimeSession?.runtimeSession,
    });
    runContexts.delete(workflowRunId);
    await options.directiveStore.delete(workflowRunId);
    await options.sandboxManager.cleanupWorkflowSandboxes(workflowRunId);
  }

  async function readLatestRuntimeSession(workflowRunId: string): Promise<
    | {
        readonly taskRunId: string;
        readonly systemSessionId?: string | undefined;
        readonly runtimeSession: RuntimeSessionRef;
      }
    | undefined
  > {
    const tasks = await options.stateManager.listTaskRuns(workflowRunId);

    for (let index = tasks.length - 1; index >= 0; index -= 1) {
      const task = tasks[index];
      const runtimeSession = task?.runtimeSession;

      if (task !== undefined && runtimeSession !== undefined) {
        return {
          taskRunId: task.id,
          systemSessionId: task.systemSessionId,
          runtimeSession,
        };
      }
    }

    return undefined;
  }

  return manager;
}

async function resolveStepInput(step: StepDefinition, context: StepInputContext): Promise<unknown> {
  if (typeof step.input === "function") {
    return await step.input(context);
  }

  if (step.input !== undefined) {
    return step.input;
  }

  return context.state.input;
}

function resolveRuntimeId(
  step: StepDefinition,
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
    definition: { id: "pending", version: "pending", kind: "task" },
    visit,
    status: "pending",
    runtimeId: "pending",
    input: undefined,
    attempt: 1,
    runtimeSessionState: "not_started",
    completionApplied: false,
    transitionApplied: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function resolveNextTargets(
  directive: CompiledDirective,
  stepId: string,
  output: unknown,
): TransitionTarget[] {
  const transitions = directive.transitions.filter((transition) => transition.from === stepId);

  if (transitions.length === 0) {
    return [];
  }

  const targets: TransitionTarget[] = [];

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

function isTerminalTarget(target: TransitionTarget): target is TerminalTarget {
  return "type" in target && (target.type === "end" || target.type === "fail");
}

function isStepRef(target: TransitionTarget): target is StepRef {
  return !isTerminalTarget(target);
}

function isActiveTaskRunConflict(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Active task run already exists ");
}

function resolveDirectiveOutput<TOutput>(
  directive: CompiledDirective<unknown, TOutput>,
  state: RunState,
): TOutput {
  const candidate =
    directive.resolveOutput?.({ state }) ??
    (state.results["final"] !== undefined
      ? state.results["final"]
      : Object.keys(state.results).length > 0
        ? state.results
        : state);

  return directive.outputSchema?.parse(candidate) ?? (candidate as TOutput);
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

function readDefinitionKind(
  directive: StepDefinition["directive"],
): "flow" | "task" | "human" | "expert" | "directive" {
  if (directive.constructor.name === "ExpertAgent") return "expert";
  if (directive.constructor?.name === "FlowSpec" || "steps" in directive) return "flow";
  return "directive";
}

function readResultError(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : "Workflow did not succeed.";
}
