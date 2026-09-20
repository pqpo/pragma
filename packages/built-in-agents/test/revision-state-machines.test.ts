import { describe, expect, it } from "vitest";

import { transitionContextStoreRevisionJob, type ContextStoreRevisionJob } from "../src/index.ts";

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
});

function contextJob(): ContextStoreRevisionJob {
  return {
    schemaVersion: "pragma.context-store-revision-job/v3",
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
