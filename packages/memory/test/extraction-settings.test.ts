import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryEvidenceEnvelopeSchema, type MemoryEvidenceEnvelope } from "@pragma/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFileMemoryExtractionSettingsStore,
  selectMemoryExtractionEvidence,
} from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Memory extraction settings", () => {
  it("defaults tool-assisted Episodic and Semantic extraction to off and persists independently", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-memory-extraction-settings-"));
    roots.push(root);
    const store = createFileMemoryExtractionSettingsStore({
      pragmaHome: root,
      now: () => new Date("2026-08-05T00:00:00.000Z"),
    });

    await expect(store.get()).resolves.toMatchObject({
      revision: 0,
      allowToolAssisted: { episodic: false, semantic: false },
    });
    await expect(
      store.update({
        expectedRevision: 0,
        allowToolAssisted: { episodic: true, semantic: false },
      }),
    ).resolves.toMatchObject({
      revision: 1,
      allowToolAssisted: { episodic: true, semantic: false },
    });
    await expect(
      store.update({
        expectedRevision: 0,
        allowToolAssisted: { episodic: false, semantic: true },
      }),
    ).rejects.toThrow("memory_extraction_settings_revision_conflict");
    await expect(
      createFileMemoryExtractionSettingsStore({ pragmaHome: root }).get(),
    ).resolves.toMatchObject({
      revision: 1,
      allowToolAssisted: { episodic: true, semantic: false },
    });
  });

  it("preserves tool-call structure while hiding tool input and result content", () => {
    const evidence = [
      envelope("user", "execution.message.appended", {
        message: {
          role: "user",
          text: "Remember this preference",
          providerDiagnostics: "private diagnostic",
        },
      }),
      envelope("tool-started", "execution.tool.started", {
        toolCallId: "call-1",
        toolName: "search",
        phase: "started",
        inputPreview: { query: "private query" },
        providerDiagnostics: "private diagnostic",
      }),
      envelope("tool-result", "execution.message.appended", {
        message: {
          role: "tool",
          toolCallId: "call-1",
          toolName: "search",
          status: "succeeded",
          content: "private result",
          details: "private diagnostic",
        },
      }),
      envelope("assistant", "execution.message.appended", {
        message: {
          role: "assistant",
          text: "Saved",
          stopReason: "stop",
          reasoning: "private reasoning",
        },
      }),
    ];

    const filtered = selectMemoryExtractionEvidence(evidence, false);
    expect(filtered.retained.map((item) => item.messageId)).toEqual([
      "user",
      "tool-started",
      "tool-result",
      "assistant",
    ]);
    expect(filtered.retained[1]?.payload).toEqual({
      toolCallId: "call-1",
      toolName: "search",
      phase: "started",
    });
    expect(filtered.retained[2]?.payload).toEqual({
      message: {
        role: "tool",
        toolCallId: "call-1",
        toolName: "search",
        status: "succeeded",
      },
    });
    expect(filtered.retained[0]?.payload).toEqual({
      message: { role: "user", text: "Remember this preference" },
    });
    expect(filtered.retained[3]?.payload).toEqual({
      message: { role: "assistant", text: "Saved", stopReason: "stop" },
    });
    expect(filtered.omittedStats.records).toBe(0);

    const enabled = selectMemoryExtractionEvidence(evidence, true);
    expect(enabled.retained[1]?.payload).toEqual({
      toolCallId: "call-1",
      toolName: "search",
      phase: "started",
      inputPreview: { query: "private query" },
    });
    expect(enabled.retained[2]?.payload).toEqual({
      message: {
        role: "tool",
        toolCallId: "call-1",
        toolName: "search",
        status: "succeeded",
        content: "private result",
      },
    });
    expect(enabled.retained[0]?.payload).toEqual(filtered.retained[0]?.payload);
    expect(enabled.retained[3]?.payload).toEqual(filtered.retained[3]?.payload);
  });

  it("omits malformed safe-projection payloads instead of leaking their content", () => {
    const malformed = [
      envelope("malformed-tool", "execution.tool.completed", {
        output: "private result without structural fields",
      }),
      envelope("malformed-assistant", "execution.message.appended", {
        message: { role: "assistant", reasoning: "private reasoning without safe text" },
      }),
    ];

    const selected = selectMemoryExtractionEvidence(malformed, true);

    expect(selected.retained).toEqual([]);
    expect(selected.omittedStats).toMatchObject({
      records: 2,
      byTopic: { "execution.tool.completed": 1, "execution.message.appended": 1 },
    });
  });
});

function envelope(messageId: string, topic: string, payload: unknown): MemoryEvidenceEnvelope {
  return MemoryEvidenceEnvelopeSchema.parse({
    schemaVersion: "pragma.memory-evidence/v1",
    messageId,
    topic,
    schemaRef:
      topic === "execution.message.appended"
        ? "pragma.memory.execution-message/v2"
        : "pragma.memory.tool-event/v2",
    sourceRef: {
      type: "pragma.execution-event",
      id: messageId,
      canonicalEventId: `canonical-${messageId}`,
    },
    subjectRefs: [{ type: "pragma.execution", id: "execution" }],
    correlationId: "execution",
    occurredAt: "2026-08-05T00:00:00.000Z",
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
