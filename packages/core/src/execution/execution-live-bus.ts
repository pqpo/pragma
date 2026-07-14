import type { ExecutionEvent, ExecutionOutputItem } from "@pragma/shared";

import { AsyncPushQueue } from "../runtime/async-push-queue.ts";
import type { ExecutionStore } from "./execution-store.ts";

export interface ExecutionOutputSubscription extends AsyncIterable<ExecutionOutputItem> {
  close(): Promise<void>;
}

export interface ExecutionEventSubscription extends AsyncIterable<ExecutionEvent> {
  close(): Promise<void>;
}

class ExecutionLiveBus {
  private readonly subscribers = new Map<string, Set<AsyncPushQueue<ExecutionOutputItem>>>();
  private readonly eventSubscribers = new Map<string, Set<AsyncPushQueue<ExecutionEvent>>>();

  subscribe(executionId: string): ExecutionOutputSubscription {
    const queue = new AsyncPushQueue<ExecutionOutputItem>();
    const subscribers = this.subscribers.get(executionId) ?? new Set();
    subscribers.add(queue);
    this.subscribers.set(executionId, subscribers);
    let closed = false;
    return {
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      close: async () => {
        if (closed) return;
        closed = true;
        subscribers.delete(queue);
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
    for (const subscriber of this.subscribers.get(executionId) ?? []) {
      subscriber.push(output);
    }
  }

  publishEvent(executionId: string, event: ExecutionEvent): void {
    for (const subscriber of this.eventSubscribers.get(executionId) ?? []) {
      subscriber.push(event);
    }
  }

  complete(executionId: string): void {
    const subscribers = this.subscribers.get(executionId);
    if (subscribers !== undefined) {
      this.subscribers.delete(executionId);
      for (const subscriber of subscribers) subscriber.close();
    }
    const eventSubscribers = this.eventSubscribers.get(executionId);
    if (eventSubscribers !== undefined) {
      this.eventSubscribers.delete(executionId);
      for (const subscriber of eventSubscribers) subscriber.close();
    }
  }
}

const buses = new WeakMap<ExecutionStore, ExecutionLiveBus>();

export function getExecutionLiveBus(store: ExecutionStore): ExecutionLiveBus {
  const existing = buses.get(store);
  if (existing !== undefined) return existing;
  const created = new ExecutionLiveBus();
  buses.set(store, created);
  return created;
}
