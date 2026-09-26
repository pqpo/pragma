import { MemoryEvidenceEnvelopeSchema } from "@pragma/shared";
import { describe, expect, it } from "vitest";
import { renderEpisodicExtractionPrompt } from "../src/memory-curator.ts";

describe("Memory Curator Evidence prompts", () => {
  it("keeps content and agent stewardship while removing envelope metadata", () => {
    const evidence = [
      MemoryEvidenceEnvelopeSchema.parse({
        schemaVersion: "pragma.memory-evidence/v1",
        messageId: "message-user",
        topic: "execution.message.appended",
        schemaRef: "pragma.memory.execution-message/v2",
        sourceRef: {
          type: "pragma.execution-event",
          id: "source-event-id",
          canonicalEventId: "canonical-event-id",
          cursor: "42",
        },
        subjectRefs: [
          { type: "pragma.execution", id: "execution-id" },
          { type: "pragma.invocation", id: "invocation-id" },
        ],
        correlationId: "execution-id",
        causationId: "canonical-event-id",
        occurredAt: "2026-08-13T06:00:00.000Z",
        visibility: { mode: "host-private" },
        sensitivity: "confidential",
        bindings: [{ consumerRef: { type: "pragma.expert", id: "agent-a" }, access: "allow" }],
        attribution: {
          rootRef: { type: "pragma.expert-team", id: "team-a" },
          producerRefs: [{ type: "pragma.expert", id: "agent-a" }],
        },
        policySnapshot: {
          capture: true,
          recall: true,
          learning: "local-candidates",
          appliedRevisions: [{ scope: "global", revision: 7 }],
        },
        payload: { message: { role: "user", text: "先让我确认方案，再执行依赖树净化。" } },
      }),
      MemoryEvidenceEnvelopeSchema.parse({
        schemaVersion: "pragma.memory-evidence/v1",
        messageId: "tool-failed",
        topic: "execution.tool.failed",
        schemaRef: "pragma.memory.tool-event/v2",
        sourceRef: {
          type: "pragma.execution-event",
          id: "tool-source-event-id",
          canonicalEventId: "tool-canonical-event-id",
        },
        subjectRefs: [{ type: "pragma.execution", id: "execution-id" }],
        occurredAt: "2026-08-13T06:01:00.000Z",
        visibility: { mode: "host-private" },
        sensitivity: "confidential",
        bindings: [],
        attribution: {
          rootRef: { type: "pragma.expert-team", id: "team-a" },
          producerRefs: [{ type: "pragma.expert", id: "agent-a" }],
        },
        policySnapshot: {
          capture: true,
          recall: true,
          learning: "local-candidates",
          appliedRevisions: [],
        },
        payload: { toolCallId: "call-1", toolName: "search_expert_context", phase: "failed" },
      }),
    ];

    const prompt = renderEpisodicExtractionPrompt({
      schemaVersion: "pragma.memory-episodic-extraction-input/v2",
      jobId: "job-id",
      executionId: "execution-id",
      evidence,
      omittedEvidence: { records: 0, bytes: 0, byTopic: {} },
    });

    expect(prompt).toContain('"root":"pragma.expert-team:team-a"');
    expect(prompt).toContain('"producers":["pragma.expert:agent-a"]');
    expect(prompt.match(/"root":"pragma\.expert-team:team-a"/gu)).toHaveLength(1);
    expect(prompt).toContain(
      '"id":"message-user","at":"2026-08-13T06:00:00.000Z","steward":0,"kind":"user","text":"先让我确认方案，再执行依赖树净化。"',
    );
    expect(prompt).toContain(
      '"id":"tool-failed","at":"2026-08-13T06:01:00.000Z","steward":0,"kind":"tool","tool":"search_expert_context","phase":"failed"',
    );
    for (const discardedField of [
      "schemaVersion",
      "source-event-id",
      "canonical-event-id",
      "execution-id",
      "host-private",
      "confidential",
      "policySnapshot",
      "bindings",
      "toolCallId",
    ]) {
      expect(prompt).not.toContain(discardedField);
    }
  });

  it("uses the compact projection when applying the prompt byte budget", () => {
    const template = MemoryEvidenceEnvelopeSchema.parse({
      schemaVersion: "pragma.memory-evidence/v1",
      messageId: "template",
      topic: "execution.message.appended",
      schemaRef: "pragma.memory.execution-message/v2",
      sourceRef: {
        type: "pragma.execution-event",
        id: "source-event-id",
        canonicalEventId: "canonical-event-id",
      },
      subjectRefs: [
        { type: "pragma.execution", id: "execution-id" },
        { type: "pragma.invocation", id: "invocation-id" },
      ],
      correlationId: "execution-id",
      causationId: "canonical-event-id",
      occurredAt: "2026-08-13T06:00:00.000Z",
      visibility: { mode: "host-private" },
      sensitivity: "confidential",
      bindings: [{ consumerRef: { type: "pragma.expert", id: "agent-a" }, access: "allow" }],
      attribution: {
        rootRef: { type: "pragma.expert-team", id: "team-a" },
        producerRefs: [{ type: "pragma.expert", id: "agent-a" }],
      },
      policySnapshot: {
        capture: true,
        recall: true,
        learning: "local-candidates",
        appliedRevisions: Array.from({ length: 24 }, (_, revision) => ({
          scope: "global" as const,
          revision,
        })),
      },
      payload: { message: { role: "user", text: "template" } },
    });
    const evidence = Array.from({ length: 200 }, (_, index) =>
      MemoryEvidenceEnvelopeSchema.parse({
        ...template,
        messageId: `message-${index}`,
        occurredAt: `2026-08-13T06:00:00.${String(index).padStart(3, "0")}Z`,
        payload: { message: { role: "user", text: `useful-${index}` } },
      }),
    );

    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeGreaterThan(78_000);

    const prompt = renderEpisodicExtractionPrompt({
      schemaVersion: "pragma.memory-episodic-extraction-input/v2",
      jobId: "job-id",
      executionId: "execution-id",
      evidence,
      omittedEvidence: { records: 0, bytes: 0, byTopic: {} },
    });

    expect(prompt).toContain('"id":"message-0"');
    expect(prompt).toContain('"id":"message-199"');
  });
});
