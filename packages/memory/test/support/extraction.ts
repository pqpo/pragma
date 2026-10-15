import { MemoryEvidenceEnvelopeSchema } from "@pragma/shared";
import { MEMORY_CURATOR_REF } from "../../src/curator.ts";
import type { SemanticExtractionInput } from "../../src/semantic/schema.ts";

export const provenance = {
  curatorRef: MEMORY_CURATOR_REF,
  promptVersion: "test/v1",
  profileRevision: 0,
  runtimeId: "fake",
  providerId: "fake",
  modelId: "fake",
  extractedAt: "2026-10-15T00:00:00.000Z",
};
export function extractionInput(
  text = "用户长期偏好简体中文回答。",
  jobId = "job",
): SemanticExtractionInput {
  return {
    schemaVersion: "pragma.memory-semantic-extraction-input/v3",
    jobId,
    executionId: "execution",
    allowedSubjectRefs: [{ type: "pragma.user", id: "local-user" }],
    currentFacts: [],
    omittedEvidence: { records: 0, bytes: 0, byTopic: {} },
    evidence: [
      MemoryEvidenceEnvelopeSchema.parse({
        schemaVersion: "pragma.memory-evidence/v1",
        messageId: "message",
        topic: "execution.message.appended",
        schemaRef: "pragma.memory.execution-message/v2",
        sourceRef: { type: "pragma.execution-event", id: "source", canonicalEventId: "canonical" },
        subjectRefs: [{ type: "pragma.execution", id: "execution" }],
        correlationId: "execution",
        occurredAt: "2026-10-14T00:00:00.000Z",
        visibility: { mode: "host-private" },
        sensitivity: "confidential",
        bindings: [],
        policySnapshot: {
          capture: true,
          recall: true,
          learning: "local-candidates",
          appliedRevisions: [],
        },
        payload: { message: { role: "user", text } },
      }),
    ],
  };
}
export const factArguments = {
  statement: "用户偏好简体中文回答。",
  subjects: ["user"],
  property: { predicate: "user.preference.language", conflictMode: "exclusive" },
  value: "zh-Hans",
  confidence: 0.8,
  evidence: ["e1"],
};
