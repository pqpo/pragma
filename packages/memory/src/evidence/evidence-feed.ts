import { createHash } from "node:crypto";

import type { CanonicalEventCursor, MemoryEvidenceEnvelope } from "@pragma/shared";
import { CanonicalEventEnvelopeSchema, MemoryEvidenceEnvelopeSchema } from "@pragma/shared";
import type { CanonicalEventFeed, CanonicalEventFeedDiagnostic } from "@pragma/core";

export interface MemoryEvidencePage {
  readonly items: readonly MemoryEvidenceEnvelope[];
  readonly unreadable: readonly { readonly sequence: number; readonly eventId?: string }[];
  readonly nextCursor: CanonicalEventCursor;
}

export interface MemoryEvidenceFeed {
  read(input: {
    readonly after?: CanonicalEventCursor | undefined;
    readonly limit: number;
  }): Promise<MemoryEvidencePage>;
  inspect(): Promise<CanonicalEventFeedDiagnostic>;
}

export interface MemoryEvidencePublisher {
  publish(envelopes: readonly MemoryEvidenceEnvelope[]): Promise<void>;
}

export function createMemoryEvidenceFeed(feed: CanonicalEventFeed): MemoryEvidenceFeed {
  return {
    async read(input) {
      const page = await feed.read(input);
      const items: MemoryEvidenceEnvelope[] = [];
      const unreadable: { sequence: number; eventId?: string }[] = [];
      for (const item of page.items) {
        if (item.kind === "unreadable") {
          unreadable.push({
            sequence: item.cursor.sequence,
            ...(item.eventId === undefined ? {} : { eventId: item.eventId }),
          });
          continue;
        }
        if (item.event.topic !== "pragma.memory.evidence.committed") continue;
        const parsed = MemoryEvidenceEnvelopeSchema.safeParse(item.event.payload);
        if (parsed.success) items.push(parsed.data);
        else unreadable.push({ sequence: item.cursor.sequence, eventId: item.event.eventId });
      }
      return { items, unreadable, nextCursor: page.nextCursor };
    },
    async inspect() {
      return await feed.inspect();
    },
  };
}

export function createMemoryEvidencePublisher(feed: CanonicalEventFeed): MemoryEvidencePublisher {
  return {
    async publish(envelopes) {
      await feed.append(
        envelopes.map((input) => {
          const envelope = MemoryEvidenceEnvelopeSchema.parse(input);
          return CanonicalEventEnvelopeSchema.parse({
            schemaVersion: "pragma.canonical-event/v1",
            eventId: createHash("sha256")
              .update(JSON.stringify(["pragma.memory-evidence/v1", envelope.messageId]))
              .digest("hex"),
            topic: "pragma.memory.evidence.committed",
            schemaRef: "pragma.memory-evidence/v1",
            sourceRef: {
              type: "pragma.memory-evidence",
              id: envelope.messageId,
            },
            correlationId: envelope.correlationId,
            causationId: envelope.causationId,
            occurredAt: envelope.occurredAt,
            payload: envelope,
          });
        }),
      );
    },
  };
}
