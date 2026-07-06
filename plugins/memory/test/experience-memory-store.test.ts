import { describe, expect, it } from "vitest";

import { createInMemoryExperienceMemoryStore } from "../src/index.ts";

describe("in-memory ExperienceMemoryStore", () => {
  it("writes, lists, and filters experience entries", async () => {
    const store = createInMemoryExperienceMemoryStore();

    const written = await store.write({
      record: {
        id: "experience-1",
        type: "experience",
        scope: "session",
        workflowRunId: "workflow-1",
        taskRunId: "task-1",
        runtimeSessionId: "session-1",
        kind: "tool",
        content: "Searched packages/core/src/loop and confirmed runtime files.",
        status: "summarized",
        provenance: {
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          evidence: [{ type: "run", id: "workflow-1" }],
        },
      },
    });

    expect(written.ok).toBe(true);

    const listed = await store.list({
      workflowRunId: "workflow-1",
      taskRunId: "task-1",
      kind: "tool",
    });

    expect(listed).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ id: "experience-1" })],
    });
  });

  it("retrieves relevant experiences for runtime and prioritizes summarized entries", async () => {
    const store = createInMemoryExperienceMemoryStore();

    await store.write({
      record: {
        id: "experience-1",
        type: "experience",
        scope: "session",
        workflowRunId: "workflow-1",
        kind: "tool",
        content: "Located @pragma/core loop code under packages/core/src/loop.",
        status: "recorded",
        provenance: {
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          evidence: [{ type: "run", id: "workflow-1" }],
        },
      },
    });
    await store.write({
      record: {
        id: "experience-2",
        type: "experience",
        scope: "session",
        workflowRunId: "workflow-1",
        kind: "tool",
        content: "Located @pragma/core loop code under packages/core/src/loop.",
        status: "summarized",
        provenance: {
          createdAt: "2026-07-06T01:00:00.000Z",
          updatedAt: "2026-07-06T01:00:00.000Z",
          evidence: [{ type: "run", id: "workflow-1" }],
        },
      },
    });

    const retrieved = await store.retrieveForRuntime({
      agentId: "agent-a",
      workflowRunId: "workflow-1",
      query: "packages/core/src/loop",
    });

    expect(retrieved.ok).toBe(true);
    if (!retrieved.ok) {
      return;
    }

    expect(retrieved.value[0]?.id).toBe("experience-2");
  });

  it("matches runtime retrieval queries case-insensitively", async () => {
    const store = createInMemoryExperienceMemoryStore();

    await store.write({
      record: {
        id: "experience-1",
        type: "experience",
        scope: "session",
        workflowRunId: "workflow-1",
        kind: "tool",
        title: "Loop Ownership",
        summary: "Packages/Core/Src/Loop is the canonical location.",
        content: "Packages/Core/Src/Loop is the canonical location.",
        status: "summarized",
        provenance: {
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          evidence: [{ type: "run", id: "workflow-1" }],
        },
      },
    });

    const retrieved = await store.retrieveForRuntime({
      agentId: "agent-a",
      workflowRunId: "workflow-1",
      query: "packages/core/src/loop",
    });

    expect(retrieved).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ id: "experience-1" })],
    });
  });

  it("updates and deletes entries", async () => {
    const store = createInMemoryExperienceMemoryStore();

    await store.write({
      record: {
        id: "experience-1",
        type: "experience",
        scope: "session",
        kind: "conversation",
        content: "Initial content",
        status: "recorded",
        provenance: {
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          evidence: [{ type: "message", id: "message-1" }],
        },
      },
    });

    const updated = await store.update({
      record: {
        id: "experience-1",
        type: "experience",
        scope: "session",
        kind: "conversation",
        content: "Updated content",
        status: "summarized",
        provenance: {
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T01:00:00.000Z",
          evidence: [{ type: "message", id: "message-1" }],
        },
      },
    });

    expect(updated).toMatchObject({
      ok: true,
      value: expect.objectContaining({
        content: "Updated content",
        status: "summarized",
      }),
    });

    const deleted = await store.delete({ id: "experience-1" });
    expect(deleted).toEqual({
      ok: true,
      value: { id: "experience-1" },
    });
  });
});
