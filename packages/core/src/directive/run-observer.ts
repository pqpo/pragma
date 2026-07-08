import type { MailboxMessage, TaskRunStatus, WorkflowRunRecord } from "@pragma/shared";

import { AsyncPushQueue } from "../runtime/async-push-queue.ts";
import type {
  ListWorkflowRunsFilter,
  RunObserver,
  RunSummary,
  RunWatchOptions,
  Mailbox,
  StateManager,
} from "./types.ts";

export interface CreateRunObserverOptions {
  readonly stateManager: StateManager;
  readonly mailbox: Mailbox;
}

const terminalWorkflowEventTypes = new Set([
  "workflow.completed",
  "workflow.failed",
  "workflow.cancelled",
]);

const outputEventTypes = [
  "task.progress",
  "task.output.delta",
  "task.completed",
  "workflow.completed",
  "human.requested",
  "human.responded",
] as const;

export function createRunObserver(options: CreateRunObserverOptions): RunObserver {
  return {
    async list(filter?: ListWorkflowRunsFilter) {
      const workflows = await options.stateManager.listWorkflowRuns(filter);
      const summaries = await Promise.all(
        workflows.map((workflow) => buildSummary(options.stateManager, workflow)),
      );
      return summaries.filter(isDefined);
    },

    async get(workflowRunId) {
      return await tryBuildSummary(options.stateManager, workflowRunId);
    },

    async getTree(workflowRunId) {
      const summary = await this.get(workflowRunId);

      if (summary === undefined) {
        return undefined;
      }

      const children = (
        await Promise.all(
          summary.childWorkflowRunIds.map(
            async (childWorkflowRunId) => await this.getTree(childWorkflowRunId),
          ),
        )
      ).filter(isDefined);

      return {
        ...summary,
        children,
      };
    },

    watch(workflowRunId, watchOptions = {}) {
      return watchRun({
        mailbox: options.mailbox,
        stateManager: options.stateManager,
        workflowRunId,
        options: watchOptions,
      });
    },

    watchOutput(workflowRunId, watchOptions = {}) {
      return watchRun({
        mailbox: options.mailbox,
        stateManager: options.stateManager,
        workflowRunId,
        options: {
          ...watchOptions,
          types: outputEventTypes,
        },
      });
    },
  };
}

async function buildSummary(
  stateManager: StateManager,
  workflow: WorkflowRunRecord,
): Promise<RunSummary> {
  const [tasks, children] = await Promise.all([
    stateManager.listTaskRuns(workflow.id),
    stateManager.listWorkflowRuns({
      parentWorkflowRunId: workflow.id,
    }),
  ]);

  const taskStatusCounts: Partial<Record<TaskRunStatus, number>> = {};

  for (const task of tasks) {
    taskStatusCounts[task.status] = (taskStatusCounts[task.status] ?? 0) + 1;
  }

  return {
    workflow,
    tasks,
    taskStatusCounts,
    childWorkflowRunIds: children.map((child) => child.id),
  };
}

async function tryBuildSummary(
  stateManager: StateManager,
  workflowRunId: string,
): Promise<RunSummary | undefined> {
  const workflow = await stateManager.getWorkflowRun(workflowRunId);

  if (workflow === undefined) {
    return undefined;
  }

  return await buildSummary(stateManager, workflow);
}

function isDefined<TValue>(value: TValue | undefined): value is TValue {
  return value !== undefined;
}

function watchRun(request: {
  readonly mailbox: Mailbox;
  readonly stateManager: StateManager;
  readonly workflowRunId: string;
  readonly options: RunWatchOptions;
}): AsyncIterable<MailboxMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const queue = new AsyncPushQueue<MailboxMessage>();
      const workflowRunIds = new Set([request.workflowRunId]);
      const closeOnTerminal = request.options.closeOnTerminal ?? true;
      let subscription: Awaited<ReturnType<Mailbox["subscribe"]>> | undefined;

      const seedDescendants = async () => {
        if (request.options.recursive !== true) {
          return;
        }

        const pending = [request.workflowRunId];

        while (pending.length > 0) {
          const currentWorkflowRunId = pending.shift();

          if (currentWorkflowRunId === undefined) {
            continue;
          }

          const children = await request.stateManager.listWorkflowRuns({
            parentWorkflowRunId: currentWorkflowRunId,
          });

          for (const child of children) {
            if (workflowRunIds.has(child.id)) {
              continue;
            }

            workflowRunIds.add(child.id);
            pending.push(child.id);
          }
        }
      };

      const abort = () => {
        queue.close();
        void subscription?.unsubscribe();
      };

      await seedDescendants();

      if (request.options.signal?.aborted === true) {
        return;
      }

      request.options.signal?.addEventListener("abort", abort, { once: true });

      try {
        subscription = await request.mailbox.subscribe({}, async (message) => {
          if (
            request.options.recursive === true &&
            message.parentWorkflowRunId !== undefined &&
            workflowRunIds.has(message.parentWorkflowRunId)
          ) {
            workflowRunIds.add(message.workflowRunId);
          }

          if (!workflowRunIds.has(message.workflowRunId)) {
            return;
          }

          if (
            request.options.types !== undefined &&
            !request.options.types.includes(message.type)
          ) {
            return;
          }

          queue.push(message);

          if (
            message.workflowRunId === request.workflowRunId &&
            closeOnTerminal &&
            terminalWorkflowEventTypes.has(message.type)
          ) {
            queue.close();
          }
        });

        for await (const message of queue) {
          yield message;
        }
      } finally {
        request.options.signal?.removeEventListener("abort", abort);
        await subscription?.unsubscribe();
        queue.close();
      }
    },
  };
}
