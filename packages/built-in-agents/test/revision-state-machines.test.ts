import { describe, expect, it } from "vitest";

import {
  transitionContextStoreRevisionJob,
  transitionSkillRevisionJob,
  type ContextStoreRevisionJob,
  type SkillRevisionJob,
} from "../src/index.ts";

const timestamp = "2026-01-01T00:00:00.000Z";

describe("built-in revision state machines", () => {
  it("owns the Store Revision review and approval transitions", () => {
    const pending = contextJob();
    const running = transitionContextStoreRevisionJob(
      pending,
      { type: "execution_started" },
      timestamp,
    );
    const review = transitionContextStoreRevisionJob(running, { type: "submitted" }, timestamp);
    const applying = transitionContextStoreRevisionJob(review, { type: "approved" }, timestamp);
    const completed = transitionContextStoreRevisionJob(
      applying,
      { type: "merge_succeeded" },
      timestamp,
    );

    expect([running.state, review.state, applying.state, completed.state]).toEqual([
      "running",
      "pending_review",
      "merging",
      "merged",
    ]);
    expect(completed.revision).toBe(5);
  });

  it("updates Mission ownership atomically with Store Revision state", () => {
    const attached = transitionContextStoreRevisionJob(
      contextJob(),
      { type: "mission_attached", missionId: "30000000-0000-4000-8000-000000000003" },
      timestamp,
    );
    const detached = transitionContextStoreRevisionJob(
      attached,
      { type: "mission_detached", missionId: attached.missionId! },
      timestamp,
    );

    expect(attached).toMatchObject({ state: "running", revision: 2 });
    expect(detached).toMatchObject({ state: "editing", revision: 3 });
    expect(detached.missionId).toBeUndefined();
  });

  it("can detach a missing Mission while preserving interrupted merge recovery", () => {
    const attached = transitionContextStoreRevisionJob(
      contextJob(),
      { type: "mission_attached", missionId: "30000000-0000-4000-8000-000000000003" },
      timestamp,
    );
    const submitted = transitionContextStoreRevisionJob(attached, { type: "submitted" }, timestamp);
    const merging = transitionContextStoreRevisionJob(submitted, { type: "approved" }, timestamp);
    const detached = transitionContextStoreRevisionJob(
      merging,
      { type: "mission_detached", missionId: merging.missionId! },
      timestamp,
    );

    expect(detached.state).toBe("merging");
    expect(detached.missionId).toBeUndefined();
  });

  it("keeps Skill evaluation failure review-safe", () => {
    const running = transitionSkillRevisionJob(
      skillJob(),
      { type: "generation_started" },
      timestamp,
    );
    const evaluating = transitionSkillRevisionJob(
      running,
      {
        type: "generation_succeeded",
        changeSet: {
          schemaVersion: "pragma.skill-revision-change-set/v1",
          capabilityId: running.request.capabilityId,
          baseRevision: 1,
          baseContentHash: "b".repeat(64),
          name: "Skill",
          description: "Updated skill",
          summary: "Update instructions.",
          operations: [{ operation: "upsert", path: "SKILL.md", content: "# Skill\n\nUpdated" }],
        },
      },
      timestamp,
    );
    const failed = transitionSkillRevisionJob(
      evaluating,
      {
        type: "evaluation_succeeded",
        evaluation: {
          schemaVersion: "pragma.skill-evaluation-snapshot/v1",
          subjectHash: "c".repeat(64),
          passed: false,
          staticChecksPassed: true,
          scriptTestsPassed: true,
          profileRevision: 0,
          runtimeId: "runtime",
          providerId: "provider",
          modelId: "model",
          cases: Array.from({ length: 4 }, (_, index) => ({
            id: `case-${index}`,
            kind: index === 3 ? "boundary" : "source-replay",
            passed: false,
            assertions: [{ dimension: "correctness", passed: false, message: "Failed." }],
          })),
          evaluatedAt: timestamp,
        },
      },
      timestamp,
    );

    expect(failed).toMatchObject({
      state: "needs_attention",
      error: { code: "skill_evaluation_failed" },
    });
    expect(() => transitionSkillRevisionJob(failed, { type: "approved" }, timestamp)).toThrow(
      "revision_state_invalid",
    );
  });
});

function contextJob(): ContextStoreRevisionJob {
  return {
    schemaVersion: "pragma.context-store-revision-job/v2",
    id: "10000000-0000-4000-8000-000000000001",
    revision: 1,
    draftId: "10000000-0000-4000-8000-000000000002",
    request: {
      schemaVersion: "pragma.context-store-revision-request/v1",
      storeId: "20000000-0000-4000-8000-000000000002",
      prompt: "Add knowledge.",
      source: "user",
    },
    state: "editing",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function skillJob(): SkillRevisionJob {
  return {
    schemaVersion: "pragma.skill-revision-job/v1",
    id: "30000000-0000-4000-8000-000000000003",
    revision: 1,
    request: {
      schemaVersion: "pragma.skill-revision-request/v1",
      capabilityId: "40000000-0000-4000-8000-000000000004",
      prompt: "Update the Skill.",
      source: "user",
      sourceRefs: [],
    },
    state: "pending",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
