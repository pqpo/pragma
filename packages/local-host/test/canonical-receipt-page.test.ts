import { describe, expect, it } from "vitest";
import type { CanonicalEventPage } from "@pragma/core";
import { canonicalReceiptPage } from "../src/canonical-receipt-page.ts";

describe("Canonical receipt projection", () => {
  it("does not send large conversation bodies or terminal outputs to accounting custody", () => {
    const body = "x".repeat(33 * 1024 * 1024);
    const items: CanonicalEventPage["items"] = [
      "invocation.message.appended",
      "execution.succeeded",
    ].map((type, index) => ({
      kind: "event",
      cursor: { sequence: index + 1 },
      event: {
        schemaVersion: "pragma.canonical-event/v1",
        eventId: `event-${index}`,
        topic: "pragma.execution.event.committed",
        schemaRef: "pragma.execution-event/v5",
        sourceRef: { type: "pragma.execution-event", id: `event-${index}` },
        relatedRefs: [],
        occurredAt: "2026-10-02T00:00:00.000Z",
        payload: {
          schemaVersion: "pragma.execution-event/v5",
          eventId: `event-${index}`,
          cursor: { executionId: "execution", sequence: index + 1 },
          executionId: "execution",
          invocationId: "root",
          type,
          data: { output: body },
          occurredAt: "2026-10-02T00:00:00.000Z",
        },
      },
    }));
    const page = { items, nextCursor: { sequence: 2 } };
    expect(canonicalReceiptPage(page, false)).toEqual({ items: [], nextCursor: page.nextCursor });
    const terminal = canonicalReceiptPage(page, true);
    expect(terminal.items).toHaveLength(1);
    expect(JSON.stringify(terminal).length).toBeLessThan(1024);
    expect(
      (items[1] as Extract<CanonicalEventPage["items"][number], { kind: "event" }>).event.payload,
    ).toMatchObject({ data: { output: body } });
  });
  it("keeps invalid source facts for durable quarantine", () => {
    const item = {
      kind: "unreadable" as const,
      cursor: { sequence: 1 },
      errorCode: "invalid_envelope" as const,
    };
    expect(canonicalReceiptPage({ items: [item], nextCursor: item.cursor }, false).items).toEqual([
      item,
    ]);
  });
});
