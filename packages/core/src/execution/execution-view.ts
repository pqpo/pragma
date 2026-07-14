import {
  AgentMessageRecordSchema,
  InvocationMessageAppendedEventSchema,
  InvocationMessageHistorySchema,
  type ExecutionCursor,
  type ExecutionEvent,
  type ExecutionOutputItem,
  type ExecutionRecord,
  type Invocation,
  type InvocationMessageHistory,
  type InvocationTree,
} from "@pragma/shared";

import {
  getExecutionLiveBus,
  type ExecutionEventSubscription,
  type ExecutionOutputSubscription,
} from "./execution-live-bus.ts";
import type { ExecutionStore } from "./execution-store.ts";

export type InvocationScope =
  | { readonly kind: "root" }
  | { readonly kind: "all" }
  | { readonly kind: "executor"; readonly executorId: string }
  | { readonly kind: "invocation"; readonly invocationId: string }
  | { readonly kind: "context"; readonly contextId: string };

export interface ListExecutionEventsOptions {
  readonly scope?: InvocationScope | undefined;
  readonly after?: ExecutionCursor | undefined;
  readonly limit?: number | undefined;
}

export interface ExecutionEventPage {
  readonly items: readonly ExecutionEvent[];
  readonly nextCursor?: ExecutionCursor | undefined;
}

export interface SubscribeOutputOptions {
  readonly scope?: Exclude<InvocationScope, { readonly kind: "context" }> | undefined;
  readonly channels?: readonly ExecutionOutputItem["channel"][] | undefined;
}

export interface GetMessageHistoryOptions {
  readonly scope?: InvocationScope | undefined;
}

export interface ExecutionView {
  readonly executionId: string;
  getState(): Promise<ExecutionRecord>;
  getTree(): Promise<InvocationTree>;
  getInvocation(invocationId: string): Promise<Invocation | undefined>;
  listEvents(options?: ListExecutionEventsOptions): Promise<ExecutionEventPage>;
  subscribeEvents(options?: {
    readonly scope?: InvocationScope;
  }): Promise<ExecutionEventSubscription>;
  subscribeOutput(options?: SubscribeOutputOptions): Promise<ExecutionOutputSubscription>;
  getMessageHistory(
    options?: GetMessageHistoryOptions,
  ): Promise<readonly InvocationMessageHistory[]>;
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
    private readonly sessionId: string = executionId,
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

  async getInvocation(invocationId: string): Promise<Invocation | undefined> {
    return await this.store.getInvocation(this.executionId, invocationId);
  }

  async listEvents(options: ListExecutionEventsOptions = {}): Promise<ExecutionEventPage> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Execution event limit must be an integer between 1 and 1000.");
    }
    const invocations = await this.store.listInvocations(this.executionId);
    const selected = selectInvocations(
      invocations,
      (await this.getState()).rootInvocationId,
      options.scope,
    );
    const matching = (await this.store.readEvents(this.executionId, options.after)).filter(
      (event) => selected.has(event.invocationId),
    );
    const items = matching.slice(0, limit);
    return {
      items,
      ...(matching.length > items.length && items.length > 0
        ? { nextCursor: items.at(-1)!.cursor }
        : {}),
    };
  }

  async subscribeOutput(
    options: SubscribeOutputOptions = {},
  ): Promise<ExecutionOutputSubscription> {
    const source = getExecutionLiveBus(this.store).subscribe(this.executionId);
    const state = await this.getState();
    if (isTerminal(state.status)) await source.close();
    const rootInvocationId = state.rootInvocationId;
    const channels = options.channels === undefined ? undefined : new Set(options.channels);
    return filterSubscription(
      source,
      (item) =>
        matchesOutputScope(item, rootInvocationId, options.scope) &&
        (channels?.has(item.channel) ?? true),
    );
  }

  async subscribeEvents(
    options: { readonly scope?: InvocationScope } = {},
  ): Promise<ExecutionEventSubscription> {
    const source = getExecutionLiveBus(this.store).subscribeEvents(this.executionId);
    const state = await this.getState();
    if (isTerminal(state.status)) await source.close();
    const invocations = await this.store.listInvocations(this.executionId);
    const matchesByInvocationId = new Map(
      invocations.map((invocation) => [
        invocation.invocationId,
        matchesInvocationScope(invocation, state.rootInvocationId, options.scope),
      ]),
    );
    return filterEventSubscription(source, async (event) => {
      const cached = matchesByInvocationId.get(event.invocationId);
      if (cached !== undefined) return cached;
      if (options.scope?.kind === "all") return true;
      if (options.scope?.kind === "root") return event.invocationId === state.rootInvocationId;
      if (options.scope?.kind === "invocation") {
        return event.invocationId === options.scope.invocationId;
      }
      const invocation = await this.store.getInvocation(this.executionId, event.invocationId);
      const matches =
        invocation !== undefined &&
        matchesInvocationScope(invocation, state.rootInvocationId, options.scope);
      matchesByInvocationId.set(event.invocationId, matches);
      return matches;
    });
  }

  async getMessageHistory(
    options: GetMessageHistoryOptions = {},
  ): Promise<readonly InvocationMessageHistory[]> {
    const state = await this.getState();
    const invocations = await this.store.listInvocations(this.executionId);
    const selected = selectInvocations(invocations, state.rootInvocationId, options.scope);
    const byId = new Map(invocations.map((invocation) => [invocation.invocationId, invocation]));
    const records = (await this.store.readEvents(this.executionId))
      .filter((event) => event.type === "invocation.message.appended")
      .map((event) => InvocationMessageAppendedEventSchema.parse(event))
      .filter((event) => selected.has(event.invocationId));

    return [...selected]
      .map((invocationId) => {
        const invocation = byId.get(invocationId);
        if (invocation === undefined) return undefined;
        const messages = records
          .filter((event) => event.invocationId === invocationId)
          .map((event) =>
            AgentMessageRecordSchema.parse({
              sequence: event.cursor.sequence,
              sessionId: this.sessionId,
              executionId: this.executionId,
              invocationId,
              parentInvocationId: invocation.parentInvocationId,
              executorId: invocation.executorId,
              contextId: invocation.contextId,
              message: event.data.message,
            }),
          );
        return InvocationMessageHistorySchema.parse({
          sessionId: this.sessionId,
          executionId: this.executionId,
          invocationId,
          parentInvocationId: invocation.parentInvocationId,
          executorId: invocation.executorId,
          contextId: invocation.contextId,
          messages,
        });
      })
      .filter((history): history is InvocationMessageHistory => history !== undefined);
  }
}

function isTerminal(status: ExecutionRecord["status"]): boolean {
  return ["succeeded", "failed", "cancelled", "interrupted"].includes(status);
}

function matchesOutputScope(
  item: ExecutionOutputItem,
  rootInvocationId: string,
  scope: SubscribeOutputOptions["scope"] = { kind: "root" },
): boolean {
  switch (scope.kind) {
    case "root":
      return item.invocationId === rootInvocationId;
    case "all":
      return true;
    case "executor":
      return item.executorId === scope.executorId;
    case "invocation":
      return item.invocationId === scope.invocationId;
  }
}

function selectInvocations(
  invocations: readonly Invocation[],
  rootInvocationId: string,
  scope: InvocationScope = { kind: "root" },
): Set<string> {
  switch (scope.kind) {
    case "root":
      return new Set([rootInvocationId]);
    case "all":
      return new Set(invocations.map((invocation) => invocation.invocationId));
    case "executor":
      return new Set(
        invocations
          .filter((invocation) => invocation.executorId === scope.executorId)
          .map((invocation) => invocation.invocationId),
      );
    case "invocation":
      return new Set([scope.invocationId]);
    case "context":
      return new Set(
        invocations
          .filter((invocation) => invocation.contextId === scope.contextId)
          .map((invocation) => invocation.invocationId),
      );
  }
}

function matchesInvocationScope(
  invocation: Invocation,
  rootInvocationId: string,
  scope: InvocationScope = { kind: "root" },
): boolean {
  switch (scope.kind) {
    case "root":
      return invocation.invocationId === rootInvocationId;
    case "all":
      return true;
    case "executor":
      return invocation.executorId === scope.executorId;
    case "invocation":
      return invocation.invocationId === scope.invocationId;
    case "context":
      return invocation.contextId === scope.contextId;
  }
}

function filterSubscription(
  source: ExecutionOutputSubscription,
  predicate: (item: ExecutionOutputItem) => boolean,
): ExecutionOutputSubscription {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const item of source) if (predicate(item)) yield item;
    },
    close: async () => await source.close(),
  };
}

function filterEventSubscription(
  source: ExecutionEventSubscription,
  predicate: (item: ExecutionEvent) => boolean | Promise<boolean>,
): ExecutionEventSubscription {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const item of source) if (await predicate(item)) yield item;
    },
    close: async () => await source.close(),
  };
}
