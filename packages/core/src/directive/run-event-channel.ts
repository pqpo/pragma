import type { PragmaRunEvent } from "@pragma/shared";

import { createRunObserver } from "./run-observer.ts";
import type { RunEventCursor, RunEventStore, StateManager } from "./types.ts";

export async function createRunEventChannel(options: {
  readonly eventStore: RunEventStore;
  readonly stateManager: StateManager;
  readonly rootWorkflowRunId: string;
  readonly after?: RunEventCursor | undefined;
}): Promise<AsyncIterable<PragmaRunEvent>> {
  const source = createRunObserver({
    eventStore: options.eventStore,
    stateManager: options.stateManager,
  }).watch(options.rootWorkflowRunId, {
    recursive: true,
    from: options.after === undefined ? "beginning" : { after: options.after },
  });
  const publicLifecycle = new Set([
    "workflow.started",
    "workflow.waiting",
    "workflow.completed",
    "workflow.failed",
    "workflow.cancelled",
    "human.requested",
    "human.responded",
    "task.progress",
    "task.output.delta",
  ]);
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of source) {
        if (publicLifecycle.has(event.sourceType)) yield event;
      }
    },
  };
}

export function createEmptyRunEvents(): AsyncIterable<PragmaRunEvent> {
  return { async *[Symbol.asyncIterator]() {} };
}
