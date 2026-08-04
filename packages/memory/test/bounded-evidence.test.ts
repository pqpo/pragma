import { MemoryEvidenceEnvelopeSchema, type MemoryEvidenceEnvelope } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import { selectBoundedMemoryEvidence } from "../src/index.ts";

describe("bounded Memory Evidence", () => {
  it("keeps the root goal and terminal result ahead of low-value tool events", () => {
    const evidence = [
      message("goal", "user", "Implement storage governance", 0),
      tool("started", "execution.tool.started", "started", 1),
      tool("completed", "execution.tool.completed", "completed", 2),
      message("assistant", "assistant", "Done", 3),
      terminal(4),
    ];
    const selection = selectBoundedMemoryEvidence(evidence, {
      maxRecords: 2,
      maxBytes: 1_000_000,
    });

    expect(selection.retained.map((item) => item.messageId)).toEqual(["goal", "terminal"]);
    expect(selection.omittedStats).toMatchObject({ records: 3 });
    expect(JSON.stringify(selection.omittedStats)).not.toContain("Implement storage governance");
  });

  it("deduplicates tool start when a terminal tool phase exists", () => {
    const selection = selectBoundedMemoryEvidence(
      [
        tool("started", "execution.tool.started", "started", 1),
        tool("failed", "execution.tool.failed", "failed", 2),
      ],
      { maxRecords: 10, maxBytes: 1_000_000 },
    );
    expect(selection.retained.map((item) => item.messageId)).toEqual(["failed"]);
    expect(selection.omittedStats.byTopic["execution.tool.started"]).toBe(1);
  });
});

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  second: number,
): MemoryEvidenceEnvelope {
  return envelope(
    id,
    "execution.message.appended",
    role === "user" ? { message: { role, text } } : { message: { role, text, stopReason: "stop" } },
    second,
  );
}

function tool(
  id: string,
  topic: string,
  phase: "started" | "completed" | "failed",
  second: number,
): MemoryEvidenceEnvelope {
  return envelope(id, topic, { toolCallId: "tool-1", toolName: "shell", phase }, second);
}

function terminal(second: number): MemoryEvidenceEnvelope {
  return envelope("terminal", "execution.execution.terminal", { outcome: "succeeded" }, second);
}

function envelope(
  messageId: string,
  topic: string,
  payload: unknown,
  second: number,
): MemoryEvidenceEnvelope {
  return MemoryEvidenceEnvelopeSchema.parse({
    schemaVersion: "pragma.memory-evidence/v1",
    messageId,
    topic,
    schemaRef:
      topic === "execution.message.appended"
        ? "pragma.memory.execution-message/v2"
        : topic === "execution.execution.terminal"
          ? "pragma.memory.execution-terminal/v2"
          : "pragma.memory.tool-event/v2",
    sourceRef: {
      type: "pragma.execution-event",
      id: messageId,
      canonicalEventId: `canonical-${messageId}`,
    },
    subjectRefs: [{ type: "pragma.execution", id: "execution" }],
    correlationId: "execution",
    occurredAt: `2026-08-01T00:00:0${second}.000Z`,
    visibility: { mode: "host-private" },
    sensitivity: "internal",
    bindings: [],
    policySnapshot: {
      capture: true,
      recall: true,
      learning: "local-candidates",
      appliedRevisions: [],
    },
    payload,
  });
}
