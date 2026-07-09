import { randomUUID } from "node:crypto";

import type { RuntimeStreamEvent } from "./stream-events.ts";

export type RuntimeStreamEventInput = Omit<
  RuntimeStreamEvent,
  "schemaVersion" | "eventId" | "emittedAt" | "sequence"
>;

export interface RuntimeEventEmitter {
  readonly emit: (event: RuntimeStreamEventInput | RuntimeStreamEvent) => RuntimeStreamEvent | void;
  readonly complete: () => void;
}

export interface RuntimeQueueEventEmitter extends RuntimeEventEmitter {
  readonly emit: (event: RuntimeStreamEventInput | RuntimeStreamEvent) => RuntimeStreamEvent;
}

export function createRuntimeEventEmitter(queue: {
  readonly push: (event: RuntimeStreamEvent) => void;
  readonly close: () => void;
}): RuntimeQueueEventEmitter {
  let sequence = 0;

  return {
    emit(event) {
      const completeEvent = addRuntimeEventMetadata(event, sequence++);
      queue.push(completeEvent);
      return completeEvent;
    },
    complete() {
      queue.close();
    },
  };
}

function addRuntimeEventMetadata(
  event: RuntimeStreamEventInput | RuntimeStreamEvent,
  sequence: number,
): RuntimeStreamEvent {
  if ("schemaVersion" in event && "eventId" in event && "emittedAt" in event) {
    return {
      ...event,
      sequence: "sequence" in event ? event.sequence : sequence,
    } as RuntimeStreamEvent;
  }

  return {
    schemaVersion: "pragma.stream/v1",
    eventId: randomUUID(),
    emittedAt: new Date().toISOString(),
    sequence,
    ...event,
  } as RuntimeStreamEvent;
}
