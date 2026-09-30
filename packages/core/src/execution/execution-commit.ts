import { randomUUID } from "node:crypto";

import type { ExecutionEvent } from "@pragma/shared";

import type { ExecutionStore, NewExecutionEvent } from "./execution-store.ts";
import type { PragmaLogger } from "../logging/logger.ts";

export async function commitExecutionEvent(
  store: ExecutionStore,
  input: Omit<NewExecutionEvent, "eventId"> & {
    readonly executionId: string;
    readonly eventId?: string | undefined;
  },
): Promise<ExecutionEvent> {
  const eventId = input.eventId ?? randomUUID();
  const result = await store.commit({
    commitId: `event:${eventId}`,
    executionId: input.executionId,
    events: [
      {
        eventId,
        invocationId: input.invocationId,
        type: input.type,
        data: input.data,
        ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      },
    ],
  });
  const event = result.events.find((candidate) => candidate.eventId === eventId);
  if (event === undefined) throw new Error(`Execution event was not committed: ${eventId}`);
  return event;
}

/** Keep durable Runtime facts ordered without putting file I/O in the text pump. */
export function createExecutionEventWriter(
  store: ExecutionStore,
  executionId: string,
  logger?: PragmaLogger,
) {
  let pending: NewExecutionEvent[] = [];
  let writing: Promise<void> | undefined;
  let failure: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async (): Promise<void> => {
    if (writing !== undefined) {
      await writing;
      return await flush();
    }
    if (failure !== undefined) throw failure;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const events = pending;
    pending = [];
    if (events.length === 0) return;
    const startedAt = performance.now();
    const operation = store
      .commit({
        commitId: `runtime-events:${randomUUID()}`,
        executionId,
        events,
      })
      .then((result) => {
        logger?.info(
          "execution.runtime_events_committed",
          "Runtime event batch durably committed",
          {
            executionId,
            eventCount: events.length,
            version: result.execution.version,
            durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
          },
        );
      });
    writing = operation;
    try {
      await operation;
    } catch (error) {
      failure ??= error;
      throw error;
    } finally {
      if (writing === operation) writing = undefined;
    }
  };
  return {
    append(event: NewExecutionEvent): Promise<void> | undefined {
      if (failure !== undefined) throw failure;
      pending.push({ ...event, occurredAt: event.occurredAt ?? new Date().toISOString() });
      // Bound outstanding batches as well as the current buffer. At a control
      // boundary or capacity limit the producer waits; text deltas never enter it.
      const runtimeType =
        event.type === "runtime.event" &&
        typeof event.data === "object" &&
        event.data !== null &&
        "type" in event.data
          ? event.data.type
          : undefined;
      if (
        pending.length >= 64 ||
        event.type.startsWith("human.") ||
        (typeof runtimeType === "string" &&
          (runtimeType.startsWith("human.") || runtimeType.startsWith("tool.")))
      )
        return flush();
      if (timer === undefined) {
        timer = setTimeout(() => {
          void flush().catch(() => undefined);
        }, 50);
        timer.unref();
      }
      return undefined;
    },
    flush,
  };
}
