import { describe, expect, it, vi } from "vitest";

import type { CapabilityStore } from "./capability-store.ts";
import { createDesktopSkillRevisionSubmissionPort } from "./skill-revision-capability.ts";
import type { SkillRevisionService } from "./skill-revision-service.ts";

describe("Skill revision management capability", () => {
  it("unmounts a submitted draft before returning its receipt", async () => {
    const draftId = "10000000-0000-4000-8000-000000000001";
    const jobId = "20000000-0000-4000-8000-000000000001";
    const missionId = "30000000-0000-4000-8000-000000000001";
    const unmountDraft = vi.fn(async () => undefined);
    const revisions = {
      submitDraft: vi.fn(async () => ({
        id: jobId,
        draftId,
        revision: 2,
        state: "pending_review",
      })),
      getDraft: vi.fn(async () => ({ id: draftId, revision: 2 })),
    } as unknown as SkillRevisionService;
    const port = createDesktopSkillRevisionSubmissionPort({
      capabilities: {} as CapabilityStore,
      revisions,
      inlineMissionId: missionId,
      unmountDraft,
    });

    await expect(
      port.submitDraft({
        executionId: "40000000-0000-4000-8000-000000000001",
        invocationId: "50000000-0000-4000-8000-000000000001",
        expertId: "0000000000sk1rev",
        operationId: "60000000-0000-4000-8000-000000000001",
        draftId,
        expectedRevision: 1,
        expectedWorkingTreeHash: "a".repeat(64),
        summary: "Submit the draft.",
      }),
    ).resolves.toMatchObject({ draftId, jobId, revision: 2, state: "pending_review" });
    expect(unmountDraft).toHaveBeenCalledWith({ missionId, draftId });
  });

  it("starts an empty creation draft without a synthetic target", async () => {
    const draftId = "10000000-0000-4000-8000-000000000001";
    const jobId = "20000000-0000-4000-8000-000000000001";
    const start = vi.fn(async (request) => ({
      id: jobId,
      draftId,
      state: "editing",
      request,
    }));
    const revisions = {
      start,
      inspectDraft: vi.fn(async () => ({
        draft: {
          schemaVersion: "pragma.skill-revision-draft/v5",
          operation: "create",
          id: draftId,
          revision: 1,
          capabilityId: start.mock.calls[0]![0].capabilityId,
          name: "created-skill",
          resourceDescription: "Created through review.",
          baseRevision: 0,
          baseContentHash: "a".repeat(64),
          workspacePath: "/tmp/workspace",
          state: "editing",
          createdAt: "2026-09-19T00:00:00.000Z",
          updatedAt: "2026-09-19T00:00:00.000Z",
        },
        draftPath: "/tmp/draft",
        workingTree: { hash: "a".repeat(64), entries: [], totalBytes: 0 },
        currentRevision: 0,
        currentContentHash: "a".repeat(64),
        stale: false,
        changes: [],
      })),
    } as unknown as SkillRevisionService;
    const port = createDesktopSkillRevisionSubmissionPort({
      capabilities: { list: vi.fn(async () => []) } as unknown as CapabilityStore,
      revisions,
    });

    const result = await port.start({
      executionId: "30000000-0000-4000-8000-000000000001",
      invocationId: "40000000-0000-4000-8000-000000000001",
      expertId: "0000000000sk1rev",
      operationId: "50000000-0000-4000-8000-000000000001",
      create: { name: "created-skill", description: "Created through review." },
      prompt: "Create a Skill.",
    });

    expect(result.target).toBeUndefined();
    expect(result.creation).toMatchObject({
      resourceId: expect.any(String),
      name: "created-skill",
      description: "Created through review.",
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "create",
        capabilityId: result.creation?.resourceId,
        resourceName: "created-skill",
        resourceDescription: "Created through review.",
      }),
      expect.any(Object),
    );
  });

  it("reuses the reserved Skill id when a creation invocation is replayed", async () => {
    const draftId = "10000000-0000-4000-8000-000000000003";
    const start = vi.fn(async (request) => ({
      id: "20000000-0000-4000-8000-000000000003",
      draftId,
      state: "editing" as const,
      request,
    }));
    const revisions = {
      start,
      inspectDraft: vi.fn(async () => ({
        draft: {
          schemaVersion: "pragma.skill-revision-draft/v5",
          operation: "create",
          id: draftId,
          revision: 1,
          capabilityId: start.mock.calls[0]![0].capabilityId,
          name: "created-skill",
          resourceDescription: "Created through review.",
          baseRevision: 0,
          baseContentHash: "a".repeat(64),
          workspacePath: "/tmp/workspace",
          state: "editing",
          createdAt: "2026-09-19T00:00:00.000Z",
          updatedAt: "2026-09-19T00:00:00.000Z",
        },
        draftPath: "/tmp/draft",
        workingTree: { hash: "a".repeat(64), entries: [], totalBytes: 0 },
        currentRevision: 0,
        currentContentHash: "a".repeat(64),
        stale: false,
        changes: [],
      })),
    } as unknown as SkillRevisionService;
    const port = createDesktopSkillRevisionSubmissionPort({
      capabilities: { list: vi.fn(async () => []) } as unknown as CapabilityStore,
      revisions,
    });
    const input = {
      executionId: "30000000-0000-4000-8000-000000000001",
      invocationId: "40000000-0000-4000-8000-000000000001",
      expertId: "0000000000sk1rev",
      operationId: "50000000-0000-4000-8000-000000000001",
      create: { name: "created-skill", description: "Created through review." },
      prompt: "Create a Skill.",
    };

    const first = await port.start(input);
    const replay = await port.start(input);

    expect(replay.creation?.resourceId).toBe(first.creation?.resourceId);
    expect(start.mock.calls[1]![0]).toMatchObject({
      capabilityId: first.creation?.resourceId,
      sourceDigest: start.mock.calls[0]![0].sourceDigest,
    });
  });

  it("rejects a targetRef that does not match the continued draft", async () => {
    const draftId = "10000000-0000-4000-8000-000000000002";
    const firstId = "60000000-0000-4000-8000-000000000001";
    const secondId = "60000000-0000-4000-8000-000000000002";
    const skill = (id: string, name: string) => ({
      manifest: { id, name, latestRevision: 1 },
      definition: {
        kind: "skill" as const,
        name,
        description: `${name} description`,
        contentHash: "a".repeat(64),
      },
    });
    const revisions = {
      getDraft: vi.fn(async () => ({
        operation: "revise",
        capabilityId: firstId,
      })),
      start: vi.fn(),
    } as unknown as SkillRevisionService;
    const port = createDesktopSkillRevisionSubmissionPort({
      capabilities: {
        list: vi.fn(async () => [skill(firstId, "first"), skill(secondId, "second")]),
      } as unknown as CapabilityStore,
      revisions,
    });

    await expect(
      port.start({
        executionId: "30000000-0000-4000-8000-000000000001",
        invocationId: "40000000-0000-4000-8000-000000000001",
        expertId: "0000000000sk1rev",
        operationId: "50000000-0000-4000-8000-000000000001",
        targetRef: `skill:${secondId}`,
        draftId,
        prompt: "Continue the draft.",
      }),
    ).rejects.toMatchObject({
      code: "revision_conflict",
      message: "skill_revision_target_draft_mismatch",
    });
  });
});
