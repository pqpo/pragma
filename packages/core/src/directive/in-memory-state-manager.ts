import type {
  HumanInteractionRecord,
  RunState,
  MailboxMessage,
  SandboxRef,
  TaskRunRecord,
  WorkflowRunRecord,
} from "@pragma/shared";
import { HumanInteractionRecordSchema, RunStateSchema } from "@pragma/shared";

import type {
  ApplyStepReductionRequest,
  CreateTaskRunRequest,
  CreateWorkflowRunRequest,
  ReadyTransition,
  StateManager,
  StateTransitionResult,
} from "./types.ts";
import { cloneJson, createId, nowIso } from "./utils.ts";

const activeTaskStatuses = new Set(["pending", "dispatched", "leased", "running", "waiting"]);
const terminalTaskStatuses = new Set(["succeeded", "failed", "cancelled", "dead_letter"]);
const completableWorkflowStatuses = new Set(["running", "waiting"]);

export function createInMemoryStateManager(): StateManager {
  const workflows = new Map<string, WorkflowRunRecord>();
  const tasks = new Map<string, TaskRunRecord>();
  const humanInteractions = new Map<string, HumanInteractionRecord>();
  const humanInteractionIdsByWorkflowId = new Map<string, string[]>();
  const taskIdsByWorkflowId = new Map<string, string[]>();
  const appliedMessageIds = new Set<string>();

  const getRequiredWorkflow = (workflowRunId: string): WorkflowRunRecord => {
    const workflow = workflows.get(workflowRunId);

    if (workflow === undefined) {
      throw new Error(`Workflow run is not found: ${workflowRunId}`);
    }

    return workflow;
  };

  const getRequiredTask = (taskRunId: string): TaskRunRecord => {
    const task = tasks.get(taskRunId);

    if (task === undefined) {
      throw new Error(`Task run is not found: ${taskRunId}`);
    }

    return task;
  };

  const saveWorkflow = (workflow: WorkflowRunRecord): WorkflowRunRecord => {
    workflows.set(workflow.id, workflow);
    return workflow;
  };

  const saveTask = (task: TaskRunRecord): TaskRunRecord => {
    tasks.set(task.id, task);
    return task;
  };

  const saveHumanInteraction = (
    interaction: HumanInteractionRecord,
  ): HumanInteractionRecord => {
    humanInteractions.set(interaction.id, interaction);
    return interaction;
  };

  const updateWorkflow = (
    workflowRunId: string,
    update: (workflow: WorkflowRunRecord) => WorkflowRunRecord,
  ): WorkflowRunRecord => saveWorkflow(update(getRequiredWorkflow(workflowRunId)));

  const updateTask = (
    taskRunId: string,
    update: (task: TaskRunRecord) => TaskRunRecord,
  ): TaskRunRecord => saveTask(update(getRequiredTask(taskRunId)));

  const assertTaskStatus = (
    task: TaskRunRecord,
    allowedStatuses: readonly string[],
    nextStatus: string,
  ): void => {
    if (!allowedStatuses.includes(task.status)) {
      throw new Error(
        `Cannot mark task ${task.id} as ${nextStatus} from status ${task.status}.`,
      );
    }
  };

  return {
    async createWorkflowRun(request: CreateWorkflowRunRequest) {
      const createdAt = nowIso();
      const workflow: WorkflowRunRecord = {
        id: request.id,
        directiveId: request.directiveId,
        parentWorkflowRunId: request.parentWorkflowRunId,
        parentTaskRunId: request.parentTaskRunId,
        status: "running",
        input: cloneJson(request.input),
        state: RunStateSchema.parse(cloneJson(request.state)),
        defaultSandbox: cloneJson(request.defaultSandbox),
        currentStepIds: [request.startStepId],
        completedStepIds: [],
        revision: 0,
        createdAt,
        updatedAt: createdAt,
      };

      return saveWorkflow(workflow);
    },

    async getWorkflowRun(workflowRunId) {
      const workflow = workflows.get(workflowRunId);
      return workflow === undefined ? undefined : cloneJson(workflow);
    },

    async listWorkflowRuns(filter = {}) {
      const statuses = filter.status === undefined
        ? undefined
        : Array.isArray(filter.status)
          ? filter.status
          : [filter.status];

      return [...workflows.values()]
        .filter((workflow) => {
          if (filter.directiveId !== undefined && workflow.directiveId !== filter.directiveId) {
            return false;
          }

          if (statuses !== undefined && !statuses.includes(workflow.status)) {
            return false;
          }

          if (filter.parentWorkflowRunId === null && workflow.parentWorkflowRunId !== undefined) {
            return false;
          }

          if (
            filter.parentWorkflowRunId !== undefined &&
            filter.parentWorkflowRunId !== null &&
            workflow.parentWorkflowRunId !== filter.parentWorkflowRunId
          ) {
            return false;
          }

          return true;
        })
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((workflow) => cloneJson(workflow));
    },

    async createTaskRun(request: CreateTaskRunRequest) {
      const existingActiveTask = (taskIdsByWorkflowId.get(request.workflowRunId) ?? [])
        .map((taskId) => getRequiredTask(taskId))
        .find(
          (task) =>
            task.stepId === request.stepId &&
            activeTaskStatuses.has(task.status),
        );

      if (existingActiveTask !== undefined) {
        throw new Error(
          `Active task run already exists for workflow ${request.workflowRunId} and step ${request.stepId}: ${existingActiveTask.id}`,
        );
      }

      const createdAt = nowIso();
      const task: TaskRunRecord = {
        id: createId("task"),
        workflowRunId: request.workflowRunId,
        stepId: request.stepId,
        visit: request.visit,
        status: "pending",
        runtimeId: request.runtimeId,
        input: cloneJson(request.input),
        attempt: 1,
        createdAt,
        updatedAt: createdAt,
      };

      saveTask(task);
      const taskIds = taskIdsByWorkflowId.get(task.workflowRunId) ?? [];
      taskIds.push(task.id);
      taskIdsByWorkflowId.set(task.workflowRunId, taskIds);
      return cloneJson(task);
    },

    async getTaskRun(taskRunId) {
      const task = tasks.get(taskRunId);
      return task === undefined ? undefined : cloneJson(task);
    },

    async listTaskRuns(workflowRunId) {
      return (taskIdsByWorkflowId.get(workflowRunId) ?? []).map((taskId) =>
        cloneJson(getRequiredTask(taskId)),
      );
    },

    async markTaskDispatched(taskRunId) {
      return cloneJson(
        updateTask(taskRunId, (task) => {
          assertTaskStatus(task, ["pending"], "dispatched");
          return {
            ...task,
            status: "dispatched",
            updatedAt: nowIso(),
          };
        }),
      );
    },

    async markTaskLeased(taskRunId, leaseOwner, ttlMs) {
      return cloneJson(
        updateTask(taskRunId, (task) => {
          assertTaskStatus(task, ["pending", "dispatched"], "leased");
          return {
            ...task,
            status: "leased",
            leaseOwner,
            leaseExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
            updatedAt: nowIso(),
          };
        }),
      );
    },

    async renewTaskLease(taskRunId, leaseOwner, ttlMs) {
      return cloneJson(
        updateTask(taskRunId, (task) => {
          if (task.leaseOwner !== leaseOwner) {
            throw new Error(`Cannot renew task ${task.id} lease owned by another worker.`);
          }

          if (!["leased", "running"].includes(task.status)) {
            throw new Error(`Cannot renew task ${task.id} lease from status ${task.status}.`);
          }

          return {
            ...task,
            leaseExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
            updatedAt: nowIso(),
          };
        }),
      );
    },

    async markTaskRunning(taskRunId, sandbox: SandboxRef) {
      return cloneJson(
        updateTask(taskRunId, (task) => {
          assertTaskStatus(task, ["leased"], "running");
          return {
            ...task,
            status: "running",
            sandbox,
            updatedAt: nowIso(),
          };
        }),
      );
    },

    async markTaskWaiting(taskRunId) {
      return cloneJson(
        updateTask(taskRunId, (task) => {
          assertTaskStatus(task, ["running"], "waiting");
          return {
            ...task,
            status: "waiting",
            leaseOwner: undefined,
            leaseExpiresAt: undefined,
            updatedAt: nowIso(),
          };
        }),
      );
    },

    async markTaskResumed(taskRunId) {
      return cloneJson(
        updateTask(taskRunId, (task) => {
          assertTaskStatus(task, ["waiting"], "running");
          return {
            ...task,
            status: "running",
            updatedAt: nowIso(),
          };
        }),
      );
    },

    async markTaskSucceeded(taskRunId, output, metadata) {
      return cloneJson(
        updateTask(taskRunId, (task) => {
          assertTaskStatus(task, ["running"], "succeeded");
          return {
            ...task,
            status: "succeeded",
            output: cloneJson(output),
            ...(metadata?.runtimeSession === undefined
              ? {}
              : { runtimeSession: metadata.runtimeSession }),
            updatedAt: nowIso(),
          };
        }),
      );
    },

    async markTaskFailed(taskRunId, error) {
      return cloneJson(
        updateTask(taskRunId, (task) => {
          if (terminalTaskStatuses.has(task.status)) {
            throw new Error(`Cannot mark terminal task ${task.id} as failed from status ${task.status}.`);
          }

          return {
            ...task,
            status: "failed",
            error: cloneJson(error),
            updatedAt: nowIso(),
          };
        }),
      );
    },

    async markTaskCancelled(taskRunId, reason) {
      return cloneJson(
        updateTask(taskRunId, (task) => {
          if (terminalTaskStatuses.has(task.status)) {
            throw new Error(
              `Cannot mark terminal task ${task.id} as cancelled from status ${task.status}.`,
            );
          }

          return {
            ...task,
            status: "cancelled",
            error: {
              code: "task_cancelled",
              message: reason ?? "Task was cancelled.",
              retryable: false,
            },
            updatedAt: nowIso(),
          };
        }),
      );
    },

    async applyTaskEvent(message: MailboxMessage): Promise<StateTransitionResult> {
      if (appliedMessageIds.has(message.id)) {
        return {
          workflow: cloneJson(getRequiredWorkflow(message.workflowRunId)),
          task: message.taskRunId === undefined ? undefined : cloneJson(getRequiredTask(message.taskRunId)),
          duplicate: true,
        };
      }

      appliedMessageIds.add(message.id);

      return {
        workflow: cloneJson(getRequiredWorkflow(message.workflowRunId)),
        task: message.taskRunId === undefined ? undefined : cloneJson(getRequiredTask(message.taskRunId)),
        duplicate: false,
      };
    },

    async applyWorkflowEvent(message: MailboxMessage): Promise<StateTransitionResult> {
      if (appliedMessageIds.has(message.id)) {
        return {
          workflow: cloneJson(getRequiredWorkflow(message.workflowRunId)),
          task:
            message.taskRunId === undefined ? undefined : cloneJson(getRequiredTask(message.taskRunId)),
          duplicate: true,
        };
      }

      appliedMessageIds.add(message.id);

      return {
        workflow: cloneJson(getRequiredWorkflow(message.workflowRunId)),
        task:
          message.taskRunId === undefined ? undefined : cloneJson(getRequiredTask(message.taskRunId)),
        duplicate: false,
      };
    },

    async applyStepReduction<TOutput>(request: ApplyStepReductionRequest<TOutput>) {
      const workflow = getRequiredWorkflow(request.workflowRunId);

      if (workflow.revision !== request.expectedRevision) {
        throw new Error(
          `Workflow state revision mismatch for ${request.workflowRunId}: expected ${request.expectedRevision}, got ${workflow.revision}`,
        );
      }

      const draft = RunStateSchema.parse(cloneJson(workflow.state));
      await request.reduce?.({
        state: draft,
        output: request.output,
      });
      const nextState: RunState = RunStateSchema.parse(draft);
      const updatedWorkflow = updateWorkflow(request.workflowRunId, (current) => ({
        ...current,
        state: nextState,
        completedStepIds: current.completedStepIds.includes(request.stepId)
          ? current.completedStepIds
          : [...current.completedStepIds, request.stepId],
        revision: current.revision + 1,
        updatedAt: nowIso(),
      }));

      return cloneJson(updatedWorkflow.state);
    },

    async createHumanInteraction(request) {
      const createdAt = nowIso();
      const interaction = HumanInteractionRecordSchema.parse({
        id: createId("human"),
        workflowRunId: request.workflowRunId,
        ...(request.taskRunId === undefined ? {} : { taskRunId: request.taskRunId }),
        ...(request.stepId === undefined ? {} : { stepId: request.stepId }),
        kind: request.request.kind,
        status: "pending",
        request: cloneJson(request.request),
        createdAt,
        updatedAt: createdAt,
      });

      saveHumanInteraction(interaction);
      const interactionIds = humanInteractionIdsByWorkflowId.get(interaction.workflowRunId) ?? [];
      humanInteractionIdsByWorkflowId.set(interaction.workflowRunId, [
        ...interactionIds,
        interaction.id,
      ]);
      return cloneJson(interaction);
    },

    async getHumanInteraction(interactionId) {
      const interaction = humanInteractions.get(interactionId);
      return interaction === undefined ? undefined : cloneJson(interaction);
    },

    async listHumanInteractions(workflowRunId) {
      return (humanInteractionIdsByWorkflowId.get(workflowRunId) ?? [])
        .map((interactionId) => humanInteractions.get(interactionId))
        .filter((interaction): interaction is HumanInteractionRecord => interaction !== undefined)
        .map((interaction) => cloneJson(interaction));
    },

    async resolveHumanInteraction(request) {
      const interaction = humanInteractions.get(request.interactionId);

      if (interaction === undefined) {
        throw new Error(`Human interaction is not found: ${request.interactionId}`);
      }

      if (interaction.status !== "pending") {
        return {
          interaction: cloneJson(interaction),
          duplicate: true,
        };
      }

      const resolvedAt = nowIso();
      const nextInteraction = HumanInteractionRecordSchema.parse({
        ...interaction,
        status: "responded",
        response: cloneJson(request.response),
        ...(request.operator === undefined ? {} : { operator: cloneJson(request.operator) }),
        resolvedAt,
        updatedAt: resolvedAt,
      });

      saveHumanInteraction(nextInteraction);
      return {
        interaction: cloneJson(nextInteraction),
        duplicate: false,
      };
    },

    async markWorkflowWaiting(workflowRunId) {
      return cloneJson(
        updateWorkflow(workflowRunId, (workflow) => {
          if (workflow.status !== "running") {
            return workflow;
          }

          return {
            ...workflow,
            status: "waiting",
            revision: workflow.revision + 1,
            updatedAt: nowIso(),
          };
        }),
      );
    },

    async markWorkflowRunning(workflowRunId) {
      return cloneJson(
        updateWorkflow(workflowRunId, (workflow) => {
          if (workflow.status !== "waiting") {
            return workflow;
          }

          return {
            ...workflow,
            status: "running",
            revision: workflow.revision + 1,
            updatedAt: nowIso(),
          };
        }),
      );
    },

    async completeWorkflowRun(workflowRunId, status) {
      return cloneJson(
        updateWorkflow(workflowRunId, (workflow) => {
          if (!completableWorkflowStatuses.has(workflow.status)) {
            throw new Error(
              `Cannot complete workflow ${workflow.id} as ${status} from status ${workflow.status}.`,
            );
          }

          return {
            ...workflow,
            status,
            currentStepIds: [],
            revision: workflow.revision + 1,
            updatedAt: nowIso(),
          };
        }),
      );
    },

    async setCurrentStepIds(workflowRunId, stepIds) {
      return cloneJson(
        updateWorkflow(workflowRunId, (workflow) => ({
          ...workflow,
          currentStepIds: [...stepIds],
          updatedAt: nowIso(),
        })),
      );
    },

    async listReadyTransitions(workflowRunId) {
      const workflow = getRequiredWorkflow(workflowRunId);
      return workflow.currentStepIds.map((stepId): ReadyTransition => ({ stepId }));
    },

    async recoverExpiredLeases(now) {
      const recovered: TaskRunRecord[] = [];

      for (const task of tasks.values()) {
        if (!["leased", "running"].includes(task.status) || task.leaseExpiresAt === undefined) {
          continue;
        }

        if (new Date(task.leaseExpiresAt).getTime() > now.getTime()) {
          continue;
        }

        const nextTask: TaskRunRecord = {
          ...task,
          status: "dispatched",
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          updatedAt: nowIso(),
        };
        saveTask(nextTask);
        recovered.push(cloneJson(nextTask));
      }

      return recovered;
    },
  };
}
