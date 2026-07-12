import type {
  ExecutionCursor,
  ExecutionEvent,
  ExecutionOutputEvent,
  ExecutionRecord,
  Invocation,
  InvocationTree,
} from "@pragma/shared";

import type { ExecutionStore } from "./execution-store.ts";

export interface ExecutionWatchOptions {
  readonly after?: ExecutionCursor | undefined;
}

export interface ExecutionView {
  readonly executionId: string;
  events(): AsyncIterable<ExecutionEvent>;
  getState(): Promise<ExecutionRecord>;
  getTree(): Promise<InvocationTree>;
  watchTree(): AsyncIterable<InvocationTree>;
  getRootOutput(options?: ExecutionWatchOptions): AsyncIterable<ExecutionOutputEvent>;
  getAllOutput(options?: ExecutionWatchOptions): AsyncIterable<ExecutionOutputEvent>;
  getInvocation(invocationId: string): Promise<Invocation | undefined>;
  watchInvocation(invocationId: string): AsyncIterable<ExecutionEvent>;
  watchInvocationOutput(invocationId: string): AsyncIterable<ExecutionOutputEvent>;
}

export interface MutableExecution extends ExecutionView {
  cancel(reason?: string): Promise<void>;
  respondToHumanInteraction(
    interactionId: string,
    response: unknown,
    options: { readonly requestId: string },
  ): Promise<void>;
}

export class StoredExecutionView implements ExecutionView {
  constructor(
    readonly executionId: string,
    protected readonly store: ExecutionStore,
  ) {}

  async getState(): Promise<ExecutionRecord> {
    const state = await this.store.get(this.executionId);
    if (state === undefined) throw new Error(`Execution not found: ${this.executionId}`);
    return state;
  }

  async *events(): AsyncIterable<ExecutionEvent> {
    const state = await this.getState();
    if (isTerminal(state.status)) return;
    yield* this.store.watchEvents(this.executionId, {
      executionId: this.executionId,
      sequence: state.lastAppliedSequence,
    });
  }

  async getTree(): Promise<InvocationTree> {
    const tree = await this.store.getTree(this.executionId);
    if (tree === undefined) throw new Error(`Execution not found: ${this.executionId}`);
    return tree;
  }

  async *watchTree(): AsyncIterable<InvocationTree> {
    const state = await this.getState();
    yield await this.getTree();
    if (isTerminal(state.status)) return;
    for await (const _event of this.store.watchEvents(this.executionId, {
      executionId: this.executionId,
      sequence: state.lastAppliedSequence,
    })) {
      void _event;
      yield await this.getTree();
    }
  }

  getRootOutput(options: ExecutionWatchOptions = {}): AsyncIterable<ExecutionOutputEvent> {
    return filterAsync(this.store.watchOutputs(this.executionId, options.after), async (event) => {
      const execution = await this.getState();
      return event.invocationId === execution.rootInvocationId;
    });
  }

  getAllOutput(options: ExecutionWatchOptions = {}): AsyncIterable<ExecutionOutputEvent> {
    return this.store.watchOutputs(this.executionId, options.after);
  }

  async getInvocation(invocationId: string): Promise<Invocation | undefined> {
    return await this.store.getInvocation(this.executionId, invocationId);
  }

  watchInvocation(invocationId: string): AsyncIterable<ExecutionEvent> {
    return watchFutureInvocationEvents(this.store, this.executionId, invocationId);
  }

  watchInvocationOutput(invocationId: string): AsyncIterable<ExecutionOutputEvent> {
    return watchFutureInvocationOutputs(this.store, this.executionId, invocationId);
  }
}

async function* filterAsync<T>(
  source: AsyncIterable<T>,
  predicate: (value: T) => boolean | Promise<boolean>,
): AsyncIterable<T> {
  for await (const value of source) if (await predicate(value)) yield value;
}

async function* watchFutureInvocationEvents(
  store: ExecutionStore,
  executionId: string,
  invocationId: string,
): AsyncIterable<ExecutionEvent> {
  const state = await requireExecution(store, executionId);
  const initialInvocation = await store.getInvocation(executionId, invocationId);
  if (initialInvocation === undefined) throw new Error(`Invocation not found: ${invocationId}`);
  if (isTerminal(initialInvocation.status) || isTerminal(state.status)) return;
  let cursor: ExecutionCursor = {
    executionId,
    sequence: state.lastAppliedSequence,
  };

  while (true) {
    for (const event of await store.readEvents(executionId, cursor)) {
      cursor = event.cursor;
      if (event.invocationId === invocationId) yield event;
    }
    const invocation = await store.getInvocation(executionId, invocationId);
    const execution = await requireExecution(store, executionId);
    if (invocation === undefined || isTerminal(invocation.status) || isTerminal(execution.status)) {
      return;
    }
    await delay(25);
  }
}

async function* watchFutureInvocationOutputs(
  store: ExecutionStore,
  executionId: string,
  invocationId: string,
): AsyncIterable<ExecutionOutputEvent> {
  const initialInvocation = await store.getInvocation(executionId, invocationId);
  if (initialInvocation === undefined) throw new Error(`Invocation not found: ${invocationId}`);
  if (isTerminal(initialInvocation.status)) return;
  const existing = await store.readOutputs(executionId);
  let cursor = existing.at(-1)?.cursor;

  while (true) {
    for (const event of await store.readOutputs(executionId, cursor)) {
      cursor = event.cursor;
      if (event.invocationId === invocationId) yield event;
    }
    const invocation = await store.getInvocation(executionId, invocationId);
    const execution = await requireExecution(store, executionId);
    if (invocation === undefined || isTerminal(invocation.status) || isTerminal(execution.status)) {
      return;
    }
    await delay(25);
  }
}

async function requireExecution(
  store: ExecutionStore,
  executionId: string,
): Promise<ExecutionRecord> {
  const execution = await store.get(executionId);
  if (execution === undefined) throw new Error(`Execution not found: ${executionId}`);
  return execution;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function isTerminal(status: string): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}
