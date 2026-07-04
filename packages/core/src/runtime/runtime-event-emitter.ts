import { randomUUID } from "node:crypto";

import type { RuntimeStreamEvent } from "./stream-events.ts";

export type RuntimeStreamEventInput = Omit<
  RuntimeStreamEvent,
  "schemaVersion" | "eventId" | "emittedAt" | "sequence"
>;

export interface RuntimeEventEmitter {
  readonly emit: (event: RuntimeStreamEventInput | RuntimeStreamEvent) => void;
  readonly complete: () => void;
}

export function createRuntimeEventEmitter(queue: {
  readonly push: (event: RuntimeStreamEvent) => void;
  readonly close: () => void;
}): RuntimeEventEmitter {
  let sequence = 0;

  return {
    emit(event) {
      queue.push(addRuntimeEventMetadata(event, sequence++));
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
