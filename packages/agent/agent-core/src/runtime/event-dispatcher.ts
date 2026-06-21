import type { RuntimeStreamEvent, RuntimeStreamEventSink } from "./stream-events.ts";

export interface RunEventStore {
  readonly append: (event: RuntimeStreamEvent) => Promise<void>;
  readonly list: (runId: string, afterSequence?: number | undefined) => Promise<readonly RuntimeStreamEvent[]>;
}

export class InMemoryRunEventStore implements RunEventStore {
  private readonly events = new Map<string, RuntimeStreamEvent[]>();

  async append(event: RuntimeStreamEvent): Promise<void> {
    const events = this.events.get(event.runId) ?? [];
    events.push(event);
    this.events.set(event.runId, events);
  }

  async list(
    runId: string,
    afterSequence: number | undefined = undefined,
  ): Promise<readonly RuntimeStreamEvent[]> {
    return (this.events.get(runId) ?? []).filter(
      (event) => afterSequence === undefined || event.sequence > afterSequence,
    );
  }
}

export interface RuntimeEventDispatcher {
  readonly nextSequence: () => number;
  readonly dispatch: (event: Omit<RuntimeStreamEvent, "sequence"> | RuntimeStreamEvent) => void;
  readonly emit: (
    event: Omit<RuntimeStreamEvent, "sequence"> | RuntimeStreamEvent,
  ) => Promise<void>;
  readonly drain: () => Promise<void>;
  readonly errors: () => readonly unknown[];
}

export interface RuntimeEventDispatcherOptions {
  readonly sink?: RuntimeStreamEventSink | undefined;
  readonly store?: RunEventStore | undefined;
}

export function createRuntimeEventDispatcher(
  options: RuntimeEventDispatcherOptions = {},
): RuntimeEventDispatcher {
  let sequence = 0;
  let queue: Promise<void> = Promise.resolve();
  const errors: unknown[] = [];
  const store = options.store ?? new InMemoryRunEventStore();

  const withSequence = (
    event: Omit<RuntimeStreamEvent, "sequence"> | RuntimeStreamEvent,
  ): RuntimeStreamEvent =>
    ({
      ...event,
      sequence: "sequence" in event ? event.sequence : sequence++,
    }) as RuntimeStreamEvent;

  const enqueue = (event: RuntimeStreamEvent): Promise<void> => {
    const delivery = queue.then(async () => {
      try {
        await store.append(event);
        await options.sink?.(event);
      } catch (error) {
        errors.push(error);
      }
    });

    queue = delivery.then(
      () => undefined,
      () => undefined,
    );
    return delivery;
  };

  return {
    nextSequence() {
      return sequence++;
    },
    dispatch(event) {
      void enqueue(withSequence(event));
    },
    async emit(event) {
      await enqueue(withSequence(event));
    },
    async drain() {
      await queue;
    },
    errors() {
      return [...errors];
    },
  };
}
