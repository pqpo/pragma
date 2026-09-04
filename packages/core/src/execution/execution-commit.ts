import { randomUUID } from "node:crypto";

import type { ExecutionEvent } from "@pragma/shared";

import type { ExecutionStore, NewExecutionEvent } from "./execution-store.ts";

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
