import { randomUUID } from "node:crypto";

import type { ExecutionEvent, ExecutionRecord, Invocation } from "@pragma/shared";

import { commitExecutionEvent } from "../src/execution/execution-commit.ts";
import type { ExecutionStore } from "../src/index.ts";

export async function appendExecutionEvent(
  store: ExecutionStore,
  executionId: string,
  invocationId: string,
  type: string,
  data: unknown,
  eventId?: string,
): Promise<ExecutionEvent> {
  return await commitExecutionEvent(store, {
    executionId,
    invocationId,
    type,
    data,
    ...(eventId === undefined ? {} : { eventId }),
  });
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
