import type {
  LoopState,
  MailboxMessage,
  TaskEnvironmentRef,
  TaskRunRecord,
  WorkflowRunRecord,
} from "@expertmesh/shared";
import { LoopStateSchema } from "@expertmesh/shared";

import type {
  ApplyStepReductionRequest,
  CreateTaskRunRequest,
  CreateWorkflowRunRequest,
  ReadyTransition,
  StateManager,
  StateTransitionResult,
} from "./types.ts";
import { cloneJson, createId, nowIso } from "./utils.ts";

const activeTaskStatuses = new Set(["pending", "dispatched", "leased", "running"]);
const terminalTaskStatuses = new Set(["succeeded", "failed", "cancelled", "dead_letter"]);
const completableWorkflowStatuses = new Set(["running", "waiting"]);

export function createInMemoryStateManager(): StateManager {
  const workflows = new Map<string, WorkflowRunRecord>();
  const tasks = new Map<string, TaskRunRecord>();
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
        id: createId("workflow"),
        loopId: request.loopId,
        status: "running",
        input: cloneJson(request.input),
        state: LoopStateSchema.parse(cloneJson(request.state)),
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

    async markTaskLeased(taskRunId, leaseOwner) {
      return cloneJson(
        updateTask(taskRunId, (task) => {
          assertTaskStatus(task, ["pending", "dispatched"], "leased");
          return {
            ...task,
            status: "leased",
            leaseOwner,
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            updatedAt: nowIso(),
          };
        }),
      );
    },

    async markTaskRunning(taskRunId, environment: TaskEnvironmentRef) {
      return cloneJson(
        updateTask(taskRunId, (task) => {
          assertTaskStatus(task, ["leased"], "running");
          return {
            ...task,
            status: "running",
            environment,
            updatedAt: nowIso(),
          };
        }),
      );
    },

    async markTaskSucceeded(taskRunId, output) {
      return cloneJson(
        updateTask(taskRunId, (task) => {
          assertTaskStatus(task, ["running"], "succeeded");
          return {
            ...task,
            status: "succeeded",
            output: cloneJson(output),
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

      const draft = LoopStateSchema.parse(cloneJson(workflow.state));
      await request.reduce?.({
        state: draft,
        output: request.output,
      });
      const nextState: LoopState = LoopStateSchema.parse(draft);
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
  };
}
