import type { PragmaRunEvent, TaskRunStatus, WorkflowRunRecord } from "@pragma/shared";

import type {
  ListWorkflowRunsFilter,
  RunEventStore,
  RunObserver,
  RunSummary,
  RunWatchOptions,
  StateManager,
} from "./types.ts";

export interface CreateRunObserverOptions {
  readonly stateManager: StateManager;
  readonly eventStore: RunEventStore;
}

const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);
const terminalEventTypes = new Set([
  "workflow.completed",
  "workflow.failed",
  "workflow.cancelled",
]);
const outputSourceTypes = new Set([
  "task.progress",
  "task.output.delta",
  "task.completed",
  "workflow.completed",
  "human.requested",
  "human.responded",
]);

export function createRunObserver(options: CreateRunObserverOptions): RunObserver {
  const observer: RunObserver = {
    async list(filter?: ListWorkflowRunsFilter) {
      return await Promise.all(
        (await options.stateManager.listWorkflowRuns(filter)).map((workflow) =>
          buildSummary(options.stateManager, workflow),
        ),
      );
    },
    async get(workflowRunId) {
      const workflow = await options.stateManager.getWorkflowRun(workflowRunId);
      return workflow === undefined
        ? undefined
        : await buildSummary(options.stateManager, workflow);
    },
    async getTree(workflowRunId) {
      const summary = await observer.get(workflowRunId);
      if (summary === undefined) return undefined;
      const children = (
        await Promise.all(summary.childWorkflowRunIds.map((id) => observer.getTree(id)))
      ).filter((value): value is NonNullable<typeof value> => value !== undefined);
      return { ...summary, children };
    },
    watch(workflowRunId, watchOptions = {}) {
      return watchRun(options, workflowRunId, watchOptions);
    },
    watchOutput(workflowRunId, watchOptions = {}) {
      return filterEvents(watchRun(options, workflowRunId, watchOptions), (event) =>
        outputSourceTypes.has(event.sourceType),
      );
    },
    async result(workflowRunId, outputSchema) {
      const workflow = await options.stateManager.getWorkflowRun(workflowRunId);
      if (workflow === undefined) throw new Error(`Workflow run is not found: ${workflowRunId}`);
      if (workflow.result?.status === "failed") {
        throw new Error(readErrorMessage(workflow.result.error, "Workflow failed."));
      }
      if (workflow.result?.status === "cancelled") {
        throw new Error(readErrorMessage(workflow.result.error, "Workflow was cancelled."));
      }
      if (workflow.result?.status !== "succeeded") {
        throw new Error(
          `Workflow result is not available: ${workflowRunId} is ${workflow.status}.`,
        );
      }
      const tasks = await options.stateManager.listTaskRuns(workflowRunId);
      const sessionTask = [...tasks].reverse().find((task) => task.runtimeSession !== undefined);
      return {
        workflowRunId,
        output: outputSchema.parse(workflow.result.output),
        state: workflow.state,
        systemSessionId: sessionTask?.systemSessionId,
        runtimeSession: sessionTask?.runtimeSession,
      };
    },
  };
  return observer;
}

async function buildSummary(
  stateManager: StateManager,
  workflow: WorkflowRunRecord,
): Promise<RunSummary> {
  const [tasks, children] = await Promise.all([
    stateManager.listTaskRuns(workflow.id),
    stateManager.listWorkflowRuns({ parentWorkflowRunId: workflow.id }),
  ]);
  const taskStatusCounts: Partial<Record<TaskRunStatus, number>> = {};
  for (const task of tasks)
    taskStatusCounts[task.status] = (taskStatusCounts[task.status] ?? 0) + 1;
  return {
    workflow,
    tasks,
    taskStatusCounts,
    childWorkflowRunIds: children.map((child) => child.id),
  };
}

function watchRun(
  services: CreateRunObserverOptions,
  workflowRunId: string,
  watchOptions: RunWatchOptions,
): AsyncIterable<PragmaRunEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      const workflow = await services.stateManager.getWorkflowRun(workflowRunId);
      if (workflow === undefined) throw new Error(`Workflow run is not found: ${workflowRunId}`);
      const rootWorkflowRunId = workflow.rootWorkflowRunId;
      let cursor = await resolveCursor(services.eventStore, rootWorkflowRunId, watchOptions);
      let observedTerminalEvent = (
        await services.eventStore.readAfter({ rootWorkflowRunId, sequence: 0 })
      ).some(
        (event) =>
          event.cursor.sequence <= cursor.sequence &&
          event.workflowRunId === workflowRunId &&
          terminalEventTypes.has(event.sourceType),
      );
      while (watchOptions.signal?.aborted !== true) {
        const events = await services.eventStore.readAfter(cursor);
        for (const event of events) {
          cursor = event.cursor;
          if (
            event.workflowRunId === workflowRunId &&
            terminalEventTypes.has(event.sourceType)
          ) {
            observedTerminalEvent = true;
          }
          if (
            !(await includesWorkflow(
              services.stateManager,
              workflowRunId,
              event.workflowRunId,
              watchOptions.recursive === true,
            ))
          )
            continue;
          if (
            watchOptions.types !== undefined &&
            !watchOptions.types.includes(event.sourceType as never)
          )
            continue;
          yield event;
        }
        const latestWorkflow = await services.stateManager.getWorkflowRun(workflowRunId);
        const latestCursor = await services.eventStore.latest(rootWorkflowRunId);
        if (
          (watchOptions.closeOnTerminal ?? true) &&
          latestWorkflow !== undefined &&
          terminalStatuses.has(latestWorkflow.status) &&
          observedTerminalEvent &&
          cursor.sequence >= latestCursor.sequence
        )
          return;
        await delay(20, watchOptions.signal);
      }
    },
  };
}

async function resolveCursor(
  eventStore: RunEventStore,
  rootWorkflowRunId: string,
  options: RunWatchOptions,
) {
  const from = options.from ?? "latest";
  if (from === "beginning") return { rootWorkflowRunId, sequence: 0 };
  if (from === "latest") return await eventStore.latest(rootWorkflowRunId);
  if (from.after.rootWorkflowRunId !== rootWorkflowRunId)
    throw new Error("Run event cursor belongs to another Root Workflow.");
  return from.after;
}

async function includesWorkflow(
  stateManager: StateManager,
  observedId: string,
  eventId: string,
  recursive: boolean,
) {
  if (eventId === observedId) return true;
  if (!recursive) return false;
  let current = await stateManager.getWorkflowRun(eventId);
  while (current?.parentWorkflowRunId !== undefined) {
    if (current.parentWorkflowRunId === observedId) return true;
    current = await stateManager.getWorkflowRun(current.parentWorkflowRunId);
  }
  return false;
}

function filterEvents(
  source: AsyncIterable<PragmaRunEvent>,
  predicate: (event: PragmaRunEvent) => boolean,
): AsyncIterable<PragmaRunEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of source) if (predicate(event)) yield event;
    },
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function readErrorMessage(error: unknown, fallback: string): string {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : fallback;
}
