import { ExpertAgentStreamEventSchema, type MailboxMessage } from "@pragma/shared";

import { AsyncPushQueue } from "../runtime/async-push-queue.ts";
import type { Mailbox, MailboxSubscription, PragmaRunEvent } from "./types.ts";

const publicLifecycleEventTypes = new Set([
  "workflow.started",
  "workflow.waiting",
  "workflow.completed",
  "workflow.failed",
  "workflow.cancelled",
  "human.requested",
  "human.responded",
]);

const rootTerminalEventTypes = new Set([
  "workflow.completed",
  "workflow.failed",
  "workflow.cancelled",
]);

interface WorkflowParent {
  readonly parentWorkflowRunId?: string | undefined;
  readonly parentTaskRunId?: string | undefined;
}

export async function createRunEventChannel(options: {
  readonly mailbox: Mailbox;
  readonly rootWorkflowRunId: string;
}): Promise<AsyncIterable<PragmaRunEvent>> {
  const queue = new AsyncPushQueue<PragmaRunEvent>();
  const workflowRunIds = new Set([options.rootWorkflowRunId]);
  const parents = new Map<string, WorkflowParent>();
  let consumed = false;
  let terminal = false;

  const subscription: MailboxSubscription = await options.mailbox.subscribe({}, async (message) => {
    const parentTracked =
      message.parentWorkflowRunId !== undefined &&
      workflowRunIds.has(message.parentWorkflowRunId);

    if (parentTracked) {
      workflowRunIds.add(message.workflowRunId);
      parents.set(message.workflowRunId, {
        parentWorkflowRunId: message.parentWorkflowRunId,
        parentTaskRunId: message.parentTaskRunId,
      });
    }

    if (!workflowRunIds.has(message.workflowRunId)) {
      return;
    }

    const event = projectRunEvent(options.rootWorkflowRunId, message, parents);
    if (event !== undefined) {
      queue.push(event);
    }

    if (
      message.workflowRunId === options.rootWorkflowRunId &&
      rootTerminalEventTypes.has(message.type)
    ) {
      terminal = true;
      queue.close();
      await subscription?.unsubscribe();
    }
  });

  return {
    async *[Symbol.asyncIterator]() {
      if (consumed) {
        throw new Error("RunHandle.events supports a single consumer.");
      }
      consumed = true;

      try {
        for await (const event of queue) {
          yield event;
        }
      } finally {
        if (!terminal) {
          queue.close();
          await subscription?.unsubscribe();
        }
      }
    },
  };
}

export function createEmptyRunEvents(): AsyncIterable<PragmaRunEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ value: undefined, done: true }) as const,
      };
    },
  };
}

function projectRunEvent(
  rootWorkflowRunId: string,
  message: MailboxMessage,
  parents: ReadonlyMap<string, WorkflowParent>,
): PragmaRunEvent | undefined {
  let type: string = message.type;
  let payload = message.payload;

  if (message.type === "task.progress" || message.type === "task.output.delta") {
    const runtimeEvent = ExpertAgentStreamEventSchema.parse(message.payload);
    type = runtimeEvent.type;
    payload = runtimeEvent.payload;
  } else if (!publicLifecycleEventTypes.has(message.type)) {
    return undefined;
  }

  const parent = parents.get(message.workflowRunId);
  const parentWorkflowRunId = message.parentWorkflowRunId ?? parent?.parentWorkflowRunId;
  const parentTaskRunId = message.parentTaskRunId ?? parent?.parentTaskRunId;

  return {
    rootWorkflowRunId,
    workflowRunId: message.workflowRunId,
    ...(parentWorkflowRunId === undefined ? {} : { parentWorkflowRunId }),
    ...(parentTaskRunId === undefined ? {} : { parentTaskRunId }),
    ...(message.taskRunId === undefined ? {} : { taskRunId: message.taskRunId }),
    ...(message.stepId === undefined ? {} : { stepId: message.stepId }),
    type,
    payload,
  };
}
