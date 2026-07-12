import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  ExpertAgentStreamEventSchema,
  PragmaRunEventSchema,
  type MailboxMessage,
  type PragmaRunEvent,
} from "@pragma/shared";

import { PragmaPaths } from "../storage/pragma-paths.ts";
import { withFileLock } from "../storage/file-lock.ts";
import type { RunEventStore } from "./types.ts";

export function createInMemoryRunEventStore(): RunEventStore {
  const events = new Map<string, PragmaRunEvent[]>();
  return {
    async append(message, rootWorkflowRunId) {
      const list = events.get(rootWorkflowRunId) ?? [];
      const event = projectEvent(message, rootWorkflowRunId, list.length + 1);
      list.push(event);
      events.set(rootWorkflowRunId, list);
      return event;
    },
    async latest(rootWorkflowRunId) {
      return { rootWorkflowRunId, sequence: events.get(rootWorkflowRunId)?.length ?? 0 };
    },
    async readAfter(cursor) {
      return (events.get(cursor.rootWorkflowRunId) ?? []).filter(
        (event) => event.cursor.sequence > cursor.sequence,
      );
    },
  };
}

export function createFileRunEventStore(
  options: {
    readonly pragmaHome?: string | undefined;
    readonly paths?: PragmaPaths | undefined;
  } = {},
): RunEventStore {
  const paths = options.paths ?? new PragmaPaths({ pragmaHome: options.pragmaHome });
  const queues = new Map<string, Promise<unknown>>();
  const store: RunEventStore = {
    async append(message, rootWorkflowRunId) {
      let resolveEvent!: (event: PragmaRunEvent) => void;
      let rejectEvent!: (error: unknown) => void;
      const result = new Promise<PragmaRunEvent>((resolve, reject) => {
        resolveEvent = resolve;
        rejectEvent = reject;
      });
      const queued = (queues.get(rootWorkflowRunId) ?? Promise.resolve()).then(async () => {
        try {
          await withFileLock(paths.workflowEventsLock(rootWorkflowRunId), async () => {
            const latest = await store.latest(rootWorkflowRunId);
            const event = projectEvent(message, rootWorkflowRunId, latest.sequence + 1);
            const file = paths.workflowEvents(rootWorkflowRunId);
            await mkdir(dirname(file), { recursive: true });
            await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
            resolveEvent(event);
          });
        } catch (error) {
          rejectEvent(error);
        }
      });
      queues.set(rootWorkflowRunId, queued);
      await queued;
      return await result;
    },
    async latest(rootWorkflowRunId) {
      const events = await readEvents(paths, rootWorkflowRunId);
      return { rootWorkflowRunId, sequence: events.at(-1)?.cursor.sequence ?? 0 };
    },
    async readAfter(cursor) {
      return (await readEvents(paths, cursor.rootWorkflowRunId)).filter(
        (event) => event.cursor.sequence > cursor.sequence,
      );
    },
  };
  return store;
}

async function readEvents(
  paths: PragmaPaths,
  rootWorkflowRunId: string,
): Promise<readonly PragmaRunEvent[]> {
  let content: string;
  try {
    content = await readFile(paths.workflowEvents(rootWorkflowRunId), "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => PragmaRunEventSchema.parse(JSON.parse(line)));
}

function projectEvent(
  message: MailboxMessage,
  rootWorkflowRunId: string,
  sequence: number,
): PragmaRunEvent {
  let type: string = message.type;
  let payload = message.payload;
  if (message.type === "task.progress" || message.type === "task.output.delta") {
    const runtimeEvent = ExpertAgentStreamEventSchema.parse(message.payload);
    type = runtimeEvent.type;
    payload = runtimeEvent.payload;
  }
  return PragmaRunEventSchema.parse({
    id: message.id,
    cursor: { rootWorkflowRunId, sequence },
    rootWorkflowRunId,
    workflowRunId: message.workflowRunId,
    ...(message.parentWorkflowRunId === undefined
      ? {}
      : { parentWorkflowRunId: message.parentWorkflowRunId }),
    ...(message.parentTaskRunId === undefined ? {} : { parentTaskRunId: message.parentTaskRunId }),
    ...(message.taskRunId === undefined ? {} : { taskRunId: message.taskRunId }),
    ...(message.stepId === undefined ? {} : { stepId: message.stepId }),
    type,
    sourceType: message.type,
    payload,
    occurredAt: message.occurredAt,
  });
}
