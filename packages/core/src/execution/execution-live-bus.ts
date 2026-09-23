import type { ExecutionEvent, ExecutionOutputItem } from "@pragma/shared";

import { AsyncPushQueue } from "../runtime/async-push-queue.ts";
import type { ExecutionStore } from "./execution-store.ts";

export interface ExecutionOutputSubscription extends AsyncIterable<ExecutionOutputItem> {
  close(): Promise<void>;
}

export interface ExecutionEventSubscription extends AsyncIterable<ExecutionEvent> {
  close(): Promise<void>;
}

export const EXECUTION_OUTPUT_HISTORY_MAX_ITEMS = 2_048;
export const EXECUTION_OUTPUT_HISTORY_MAX_CHARACTERS = 1024 * 1_024;

interface ExecutionOutputHistory {
  readonly items: ExecutionOutputItem[];
  characters: number;
}

class ExecutionLiveBus {
  private readonly subscribers = new Map<
    string,
    Set<{
      readonly queue: AsyncPushQueue<ExecutionOutputItem>;
      readonly predicate: (item: ExecutionOutputItem) => boolean;
    }>
  >();
  private readonly eventSubscribers = new Map<string, Set<AsyncPushQueue<ExecutionEvent>>>();
  private readonly outputHistory = new Map<string, ExecutionOutputHistory>();

  subscribe(
    executionId: string,
    predicate: (item: ExecutionOutputItem) => boolean = () => true,
    replayHistory = true,
  ): ExecutionOutputSubscription {
    const queue = new AsyncPushQueue<ExecutionOutputItem>();
    const subscribers = this.subscribers.get(executionId) ?? new Set();
    const subscriber = { queue, predicate };
    subscribers.add(subscriber);
    this.subscribers.set(executionId, subscribers);
    if (replayHistory) {
      for (const item of this.outputHistory.get(executionId)?.items ?? []) {
        if (predicate(item)) queue.push(item);
      }
    }
    let closed = false;
    return {
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      close: async () => {
        if (closed) return;
        closed = true;
        subscribers.delete(subscriber);
        if (subscribers.size === 0) this.subscribers.delete(executionId);
        queue.close();
      },
    };
  }

  subscribeEvents(executionId: string): ExecutionEventSubscription {
    const queue = new AsyncPushQueue<ExecutionEvent>();
    const subscribers = this.eventSubscribers.get(executionId) ?? new Set();
    subscribers.add(queue);
    this.eventSubscribers.set(executionId, subscribers);
    let closed = false;
    return {
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      close: async () => {
        if (closed) return;
        closed = true;
        subscribers.delete(queue);
        if (subscribers.size === 0) this.eventSubscribers.delete(executionId);
        queue.close();
      },
    };
  }

  publish(executionId: string, output: ExecutionOutputItem): void {
    const history = this.outputHistory.get(executionId) ?? { items: [], characters: 0 };
    const characters = outputHistoryCharacters(output);
    if (characters > EXECUTION_OUTPUT_HISTORY_MAX_CHARACTERS) {
      history.items.length = 0;
      history.characters = 0;
    } else {
      history.items.push(output);
      history.characters += characters;
      while (
        history.items.length > EXECUTION_OUTPUT_HISTORY_MAX_ITEMS ||
        history.characters > EXECUTION_OUTPUT_HISTORY_MAX_CHARACTERS
      ) {
        const removed = history.items.shift();
        if (removed !== undefined) history.characters -= outputHistoryCharacters(removed);
      }
    }
    this.outputHistory.set(executionId, history);
    for (const subscriber of this.subscribers.get(executionId) ?? []) {
      if (subscriber.predicate(output)) subscriber.queue.push(output);
    }
  }

  publishEvent(executionId: string, event: ExecutionEvent): void {
    for (const subscriber of this.eventSubscribers.get(executionId) ?? []) {
      subscriber.push(event);
    }
  }

  complete(executionId: string): void {
    this.outputHistory.delete(executionId);
    const subscribers = this.subscribers.get(executionId);
    if (subscribers !== undefined) {
      this.subscribers.delete(executionId);
      for (const subscriber of subscribers) subscriber.queue.close();
    }
    const eventSubscribers = this.eventSubscribers.get(executionId);
    if (eventSubscribers !== undefined) {
      this.eventSubscribers.delete(executionId);
      for (const subscriber of eventSubscribers) subscriber.close();
    }
  }
}

function outputHistoryCharacters(output: ExecutionOutputItem): number {
  let characters = output.delta?.length ?? 0;
  if (typeof output.value === "string") characters += output.value.length;
  else if (output.value !== undefined) {
    try {
      characters += JSON.stringify(output.value)?.length ?? 0;
    } catch {
      // Item count remains a hard bound even for a non-serializable adapter payload.
    }
  }
  return Math.max(1, characters);
}

const buses = new WeakMap<ExecutionStore, ExecutionLiveBus>();

export function getExecutionLiveBus(store: ExecutionStore): ExecutionLiveBus {
  const existing = buses.get(store);
  if (existing !== undefined) return existing;
  const created = new ExecutionLiveBus();
  buses.set(store, created);
  return created;
}
