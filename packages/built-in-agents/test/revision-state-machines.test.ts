import { describe, expect, it } from "vitest";

import { transitionContextStoreRevisionJob, type ContextStoreRevisionJob } from "../src/index.ts";

const timestamp = "2026-01-01T00:00:00.000Z";

describe("built-in revision state machines", () => {
  it("returns the same submitted draft for repeated review without rejecting it", () => {
    let job = { ...contextJob(), missionId: "30000000-0000-4000-8000-000000000001" };
    for (let round = 0; round < 2; round++) {
      job = transitionContextStoreRevisionJob(job, { type: "submitted" }, timestamp) as typeof job;
      job = transitionContextStoreRevisionJob(
        job,
        { type: "returned_for_rework" },
        timestamp,
      ) as typeof job;
      expect(job).toMatchObject({
        id: contextJob().id,
        draftId: contextJob().draftId,
        state: "editing",
        missionId: "30000000-0000-4000-8000-000000000001",
      });
    }
    expect(() => transitionContextStoreRevisionJob(job, { type: "returned_for_rework" })).toThrow(
      "revision_state_invalid",
    );
  });

  it("prevents retry or editing of a deliberate rejection while retaining historical stopped-job recovery", () => {
    const review = transitionContextStoreRevisionJob(
      contextJob(),
      { type: "submitted" },
      timestamp,
    );
    const rejected = transitionContextStoreRevisionJob(review, { type: "rejected" }, timestamp);
    expect(rejected.error?.code).toBe("revision_user_rejected");
    expect(() => transitionContextStoreRevisionJob(rejected, { type: "retried" })).toThrow(
      "revision_user_rejected",
    );
    expect(() => transitionContextStoreRevisionJob(rejected, { type: "editing_started" })).toThrow(
      "revision_user_rejected",
    );
    expect(
      transitionContextStoreRevisionJob({ ...rejected, error: undefined }, { type: "retried" })
        .state,
    ).toBe("editing");
  });

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
});

function contextJob(): ContextStoreRevisionJob {
  return {
    schemaVersion: "pragma.context-store-revision-job/v4",
    submissionApprovalMode: "required",
    id: "10000000-0000-4000-8000-000000000001",
    revision: 1,
    draftId: "10000000-0000-4000-8000-000000000002",
    request: {
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise",
      storeId: "20000000-0000-4000-8000-000000000002",
      prompt: "Add knowledge.",
      source: "user",
    },
    state: "editing",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

it("accepts complete Memory source prompts while retaining ordinary revision prompt limits", async () => {
  const { ContextStoreRevisionRequestSchema, SkillRevisionRequestV4Schema } =
    await import("../src/index.ts");
  const prompt = "验".repeat(410000);
  const knowledge = {
    schemaVersion: "pragma.context-store-revision-request/v2",
    operation: "revise",
    storeId: "11111111-1111-4111-8111-111111111111",
    source: "memory-learning",
    sourceDigest: "a".repeat(64),
    prompt,
  };
  const skill = {
    schemaVersion: "pragma.skill-revision-request/v4",
    operation: "revise",
    capabilityId: "1h2j3k4m5n6p7q8r",
    source: "memory-learning",
    sourceDigest: "a".repeat(64),
    prompt,
  };
  expect(ContextStoreRevisionRequestSchema.safeParse(knowledge).success).toBe(true);
  expect(SkillRevisionRequestV4Schema.safeParse(skill).success).toBe(true);
  expect(
    ContextStoreRevisionRequestSchema.safeParse({
      ...knowledge,
      source: "user",
      sourceDigest: undefined,
      prompt: "x".repeat(50001),
    }).success,
  ).toBe(false);
  expect(
    SkillRevisionRequestV4Schema.safeParse({ ...skill, source: "user", prompt: "x".repeat(50001) })
      .success,
  ).toBe(false);
});
