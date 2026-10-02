import { randomUUID } from "node:crypto";

import type { ExecutionEvent, ExecutionRecord, Invocation } from "@pragma/shared";

import type { ExecutionStore } from "@pragma/core";

export async function appendExecutionEvent(
  store: ExecutionStore,
  executionId: string,
  invocationId: string,
  type: string,
  data: unknown,
  eventId?: string,
): Promise<ExecutionEvent> {
  const identity = eventId ?? randomUUID();
  return (
    await store.commit({
      executionId,
      commitId: `event:${identity}`,
      events: [{ invocationId, type, data, eventId: identity }],
    })
  ).events[0]!;
}

export async function putExecutionInvocation(
  store: ExecutionStore,
  executionId: string,
  invocation: Invocation,
): Promise<void> {
  await store.commit({ commitId: randomUUID(), executionId, invocationPuts: [invocation] });
}

export async function updateExecution(
  store: ExecutionStore,
  executionId: string,
  patch: Partial<ExecutionRecord>,
): Promise<ExecutionRecord> {
  return (await store.commit({ commitId: randomUUID(), executionId, executionPatch: patch }))
    .execution;
}
