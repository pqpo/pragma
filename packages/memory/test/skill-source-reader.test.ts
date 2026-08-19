import type { EpisodicMemoryRecord } from "../src/episodic/schema.ts";
import { createSkillSourceReader } from "../src/skill/source-reader.ts";
import type { SemanticFact } from "@pragma/shared";
import { describe, expect, it } from "vitest";

const rootRef = { type: "pragma.expert", id: "expert-a" } as const;

describe("Skill source reader", () => {
  it("reserves the source limit for Episodic evidence before Semantic support", async () => {
    const reader = createSkillSourceReader({
      episodic: {
        list: async () => [
          episode("episode-old", "2026-08-01T00:00:00.000Z"),
          episode("episode-new", "2026-08-03T00:00:00.000Z"),
          episode("episode-mid", "2026-08-02T00:00:00.000Z"),
        ],
      },
      semantic: {
        list: async () => [fact("fact-new", "2026-08-04T00:00:00.000Z")],
      },
    });

    const sources = await reader.listEligibleSources({
      rootRef,
      limit: 3,
      now: new Date("2026-08-05T00:00:00.000Z"),
    });

    expect(sources.map((source) => source.ref)).toEqual([
      { kind: "episodic", id: "episode-new", revision: 1 },
      { kind: "episodic", id: "episode-mid", revision: 1 },
      { kind: "episodic", id: "episode-old", revision: 1 },
    ]);
  });
});

function episode(id: string, updatedAt: string): EpisodicMemoryRecord {
  return {
    schemaVersion: "pragma.memory-episodic/v3",
    id,
    revision: 1,
    conversationRef: { type: "pragma.mission", id: `mission-${id}` },
    sourceExecutionIds: [`execution-${id}`],
    sourceUpdatedAt: updatedAt,
    executionId: `execution-${id}`,
    terminalMessageId: `message-${id}`,
    rootRefs: [rootRef],
    producerRefs: [rootRef],
    language: "en",
    goal: { text: "Complete a reusable workflow.", evidenceRefs: [`evidence-${id}`] },
    summary: { text: "The workflow completed.", evidenceRefs: [`evidence-${id}`] },
    attempts: [],
    failuresAndRecoveries: [],
    outcome: {
      status: "succeeded",
      summary: "Completed",
      evidenceRefs: [`evidence-${id}`],
    },
    artifactRefs: [],
    evidenceRefs: [`evidence-${id}`],
    visibility: { mode: "host-private" },
    sensitivity: "internal",
    bindings: [{ consumerRef: rootRef, recall: "allow", export: "allow", permissionRevision: 1 }],
    valueScore: 0.9,
    status: "active",
    extractor: {
      curatorRef: "pragma.memory.curator",
      promptVersion: "episodic/v1",
      profileRevision: 1,
      runtimeId: "runtime-a",
      providerId: "provider-a",
      modelId: "model-a",
      extractedAt: updatedAt,
    },
    createdAt: updatedAt,
    updatedAt,
  };
}

function fact(id: string, observedAt: string): SemanticFact {
  return {
    schemaVersion: "pragma.memory-semantic/v1",
    id,
    revision: 1,
    statement: "A supporting fact.",
    subjectRefs: [rootRef],
    predicate: "workflow.preference",
    normalizedValue: "supporting",
    conflictMode: "compatible",
    confidence: 0.9,
    observedAt,
    evidenceRefs: [`evidence-${id}`],
    conflictsWith: [],
    supersedes: [],
    status: "active",
    visibility: { mode: "host-private" },
    sensitivity: "internal",
    bindings: [{ consumerRef: rootRef, recall: "allow", export: "allow", permissionRevision: 1 }],
    rootRefs: [rootRef],
    producerRefs: [rootRef],
    extractor: {
      curatorRef: "pragma.memory.curator",
      promptVersion: "semantic/v1",
      profileRevision: 1,
      runtimeId: "runtime-a",
      providerId: "provider-a",
      modelId: "model-a",
      extractedAt: observedAt,
    },
    createdAt: observedAt,
    updatedAt: observedAt,
  };
}
