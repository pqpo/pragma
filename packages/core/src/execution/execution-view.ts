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
  getState(): Promise<ExecutionRecord>;
  getTree(): Promise<InvocationTree>;
  watchTree(options?: ExecutionWatchOptions): AsyncIterable<InvocationTree>;
  getRootOutput(options?: ExecutionWatchOptions): AsyncIterable<ExecutionOutputEvent>;
  getAllOutput(options?: ExecutionWatchOptions): AsyncIterable<ExecutionOutputEvent>;
  getInvocation(invocationId: string): Promise<Invocation | undefined>;
  watchInvocation(
    invocationId: string,
    options?: ExecutionWatchOptions,
  ): AsyncIterable<ExecutionEvent>;
  watchInvocationOutput(
    invocationId: string,
    options?: ExecutionWatchOptions,
  ): AsyncIterable<ExecutionOutputEvent>;
  replayEvents(options?: ExecutionWatchOptions): AsyncIterable<ExecutionEvent>;
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

  async getTree(): Promise<InvocationTree> {
    const tree = await this.store.getTree(this.executionId);
    if (tree === undefined) throw new Error(`Execution not found: ${this.executionId}`);
    return tree;
  }

  async *watchTree(options: ExecutionWatchOptions = {}): AsyncIterable<InvocationTree> {
    yield await this.getTree();
    for await (const _event of this.store.watchEvents(this.executionId, options.after)) {
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

  watchInvocation(
    invocationId: string,
    options: ExecutionWatchOptions = {},
  ): AsyncIterable<ExecutionEvent> {
    return filterAsync(
      this.store.watchEvents(this.executionId, options.after),
      (event) => event.invocationId === invocationId,
    );
  }

  watchInvocationOutput(
    invocationId: string,
    options: ExecutionWatchOptions = {},
  ): AsyncIterable<ExecutionOutputEvent> {
    return filterAsync(
      this.store.watchOutputs(this.executionId, options.after),
      (event) => event.invocationId === invocationId,
    );
  }

  replayEvents(options: ExecutionWatchOptions = {}): AsyncIterable<ExecutionEvent> {
    return fromArray(this.store.readEvents(this.executionId, options.after));
  }
}

async function* filterAsync<T>(
  source: AsyncIterable<T>,
  predicate: (value: T) => boolean | Promise<boolean>,
): AsyncIterable<T> {
  for await (const value of source) if (await predicate(value)) yield value;
}

async function* fromArray<T>(values: Promise<readonly T[]>): AsyncIterable<T> {
  yield* await values;
}
