import { describe, expect, it, vi } from "vitest";
import { PRAGMA_DSL_WRITE_API_VERSION, PragmaExpertResourceSchema } from "@pragma/interpreter/ast";

import { createDesktopContextResource } from "../../platform/bindings/desktop-bound-resource-policy.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { createDesktopKnowledgeRevisionSubmissionPort } from "./knowledge-revision-capability.ts";
import type { ContextStoreRevisionService } from "./context-store-revision-service.ts";
import type { ContextStoreStore } from "./context-store-store.ts";

const TEAM_ID = "0000000000000001";
const EXPERT_ID = "0000000000000002";
const STORE_ID = "00000000-0000-4000-8000-000000000201";
const UNMOUNTED_STORE_ID = "00000000-0000-4000-8000-000000000202";

function fixture(inline = false, activeSourceDigest?: string, ownerMissionId?: string) {
  const contextResource = createDesktopContextResource({
    owner: "project-expert",
    storeId: STORE_ID,
  });
  const systemContextResource = createDesktopContextResource({
    owner: "system-expert-customization",
    storeId: STORE_ID,
  });
  const targetRef = `context-store:${contextResource.metadata.id}`;
  const expert = {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: { id: EXPERT_ID, name: "Reflector", description: "", tags: [] },
    spec: {
      scope: "Reflect",
      instructions: "Reflect",
      capabilities: [],
      toolApprovals: {},
      contextStores: [{ ref: targetRef, namespace: "private-knowledge", required: false }],
      plugins: [],
      tools: [],
    },
  } as const;
  const team = {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "ExpertTeam",
    metadata: { id: TEAM_ID, name: "Reflection team", description: "", tags: [] },
    spec: {
      coordinator: { ref: `expert:${EXPERT_ID}` },
      members: [{ ref: "expert:0000000000000003" }],
      contextStores: [
        {
          ref: targetRef,
          namespace: "team-knowledge",
          required: true,
          visibility: { mode: "whitelist", expertIds: [EXPERT_ID] },
        },
      ],
      delegation: { permissions: { interact: {} }, maxConcurrency: 2, maxDepth: 2, runtimes: {} },
    },
  } as const;
  const systemExpert = PragmaExpertResourceSchema.parse({
    ...expert,
    metadata: {
      ...expert.metadata,
      id: "0000000000000004",
      name: "Pragma",
      description: "Built-in expert",
      avatarId: "pragma.avatar.expert.default",
    },
    spec: {
      ...expert.spec,
      contextStores: [
        {
          ref: `context-store:${systemContextResource.metadata.id}`,
          namespace: "system-knowledge",
          required: true,
        },
      ],
    },
  });
  const project = {
    get: vi.fn(async () => ({ resources: [expert, team, contextResource] })),
  } as unknown as PragmaProjectStore;
  const contextStores = {
    list: vi.fn(async () => [
      {
        id: STORE_ID,
        name: "Team knowledge",
        description: "Shared engineering invariants.",
        contentRevision: 4,
      },
      {
        id: UNMOUNTED_STORE_ID,
        name: "Unattached knowledge",
        description: "Available but not mounted.",
        contentRevision: 2,
      },
    ]),
    getSnapshot: vi.fn(async () => ({ revision: 6, snapshotHash: "b".repeat(64) })),
  } as unknown as ContextStoreStore;
  let missionId: string | undefined =
    ownerMissionId ??
    (activeSourceDigest === undefined ? undefined : "00000000-0000-4000-8000-000000000401");
  const start = vi.fn(async (request) => ({
    id: "job-1",
    draftId: "00000000-0000-4000-8000-000000000301",
    state: "editing",
    missionId,
    request:
      !inline && activeSourceDigest !== undefined
        ? { ...request, sourceDigest: activeSourceDigest }
        : request,
  }));
  const startForMission = vi.fn(async ({ request, missionId: claimedMissionId }) => {
    const job = await start(request);
    if (job.missionId === undefined) missionId = claimedMissionId;
    return {
      ...job,
      missionId,
      state: missionId === undefined ? job.state : "running",
    };
  });
  const scheduleProcessing = vi.fn();
  const continueMission = vi.fn(async () => undefined);
  const assertOwnership = vi.fn(async () => undefined);
  const attachMission = vi.fn(async (_jobId: string, nextMissionId: string) => {
    missionId = nextMissionId;
  });
  const mountDraft = vi.fn(async ({ storeId }: { readonly storeId: string }) => ({
    writableNamespace: `mission-knowledge-draft:${storeId}`,
  }));
  const listDrafts = vi.fn<ContextStoreRevisionService["listDrafts"]>(async () => []);
  const getDraft = vi.fn<ContextStoreRevisionService["getDraft"]>();
  const listDraftsWithRecovery = vi.fn(async () =>
    (await listDrafts()).map((draft) => ({ draft })),
  );
  const getDraftWithRecovery = vi.fn(async (draftId: string) => ({
    draft: await getDraft(draftId),
  }));
  const getDraftFile = vi.fn<ContextStoreRevisionService["getDraftFile"]>();
  const discardDraft = vi.fn<ContextStoreRevisionService["discardDraft"]>();
  const revisions = {
    start,
    startForMission,
    listDrafts,
    listDraftsWithRecovery,
    getDraft,
    getDraftWithRecovery,
    getDraftFile,
    inspectRebase: vi.fn(),
    rebase: vi.fn(),
    submitDraft: vi.fn(),
    discardDraft,
    scheduleProcessing,
    attachMission,
    detachMission: vi.fn(async () => ({ id: "job-1" })),
    get: vi.fn(async () => ({
      id: "job-1",
      draftId: "00000000-0000-4000-8000-000000000301",
      state: missionId === undefined ? "editing" : "running",
      missionId,
      request: { sourceDigest: activeSourceDigest },
    })),
  } as unknown as ContextStoreRevisionService;
  return {
    assertOwnership,
    port: createDesktopKnowledgeRevisionSubmissionPort({
      project,
      contextStores,
      revisions,
      continueMission,
      additionalMountResources: () => [systemExpert, systemContextResource],
      ...(inline
        ? {
            inlineMission: {
              id: "00000000-0000-4000-8000-000000000401",
              assertOwnership,
              activeRevisionJobIdForStore: async (storeId) =>
                activeSourceDigest !== undefined && storeId === STORE_ID ? "job-1" : undefined,
              writableNamespaceForStore: (storeId) => `mission-knowledge-draft:${storeId}`,
              mountDraft,
            },
          }
        : {}),
    }),
    start,
    startForMission,
    continueMission,
    scheduleProcessing,
    targetRef,
    attachMission,
    mountDraft,
    listDrafts,
    getDraft,
    getDraftFile,
    discardDraft,
  };
}

const invocation = {
  executionId: "execution-1",
  invocationId: "invocation-1",
  expertId: EXPERT_ID,
  operationId: "call-1",
};

describe("Desktop Pragma management knowledge revision tools", () => {
  it("starts a creation without exposing a synthetic formal target", async () => {
    const { port, start } = fixture(false);
    const result = await port.start({
      ...invocation,
      create: { name: "Agent knowledge", description: "Created after review." },
      prompt: "Create a new knowledge base.",
    });

    expect(result.target).toBeUndefined();
    expect(result.creation).toMatchObject({
      resourceId: expect.any(String),
      name: "Agent knowledge",
      description: "Created after review.",
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "create",
        storeId: result.creation?.resourceId,
        resourceName: "Agent knowledge",
        resourceDescription: "Created after review.",
      }),
      expect.any(Object),
    );
  });

  it("rejects a targetRef that does not match the continued draft", async () => {
    const { port, getDraft } = fixture(false);
    getDraft.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000301",
      operation: "revise",
      storeId: STORE_ID,
    } as Awaited<ReturnType<ContextStoreRevisionService["getDraft"]>>);
    const mismatchedResource = createDesktopContextResource({
      owner: "project-expert",
      storeId: UNMOUNTED_STORE_ID,
    });

    await expect(
      port.start({
        ...invocation,
        targetRef: `context-store:${mismatchedResource.metadata.id}`,
        draftId: "00000000-0000-4000-8000-000000000301",
        prompt: "Continue the draft.",
      }),
    ).rejects.toMatchObject({
      code: "revision_conflict",
      message: "knowledge_revision_target_draft_mismatch",
    });
  });

  it("reports a creation draft as stale when its reserved id already exists", async () => {
    const { port, getDraft } = fixture(false);
    const draftId = "00000000-0000-4000-8000-000000000302";
    getDraft.mockResolvedValue({
      schemaVersion: "pragma.context-store-draft/v2",
      operation: "create",
      id: draftId,
      revision: 1,
      name: "Creation draft",
      storeId: "90000000-0000-4000-8000-000000000010",
      resourceName: "Reserved knowledge",
      resourceDescription: "Creation metadata.",
      baseRevision: 0,
      baseSnapshotHash: "a".repeat(64),
      state: "editing",
      overlay: { files: [], deletedFiles: [], directories: [], deletedDirectories: [] },
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
    });

    await expect(port.getDraft({ ...invocation, draftId })).resolves.toMatchObject({
      mode: "summary",
      currentStoreRevision: 6,
      stale: true,
    });
  });

  it.each(["rebase", "submitDraft", "discardDraft"] as const)(
    "rejects %s when a claimed draft has no verifiable owner",
    async (operation) => {
      const { port, getDraft, assertOwnership } = fixture(true);
      getDraft.mockResolvedValue({
        id: "00000000-0000-4000-8000-000000000301",
        storeId: STORE_ID,
        activeMissionId: "00000000-0000-4000-8000-000000000401",
      } as Awaited<ReturnType<ContextStoreRevisionService["getDraft"]>>);
      const input = {
        ...invocation,
        draftId: "00000000-0000-4000-8000-000000000301",
        expectedRevision: 1,
        summary: "Submit",
        resolutions: [],
      };
      await expect(port[operation](input)).rejects.toThrow("knowledge_revision_owner_unavailable");
      expect(assertOwnership).not.toHaveBeenCalled();
    },
  );

  it("lists every knowledge base with descriptions and current Expert or Team mounts", async () => {
    const { port, targetRef } = fixture();

    await expect(port.listTargets({ ...invocation, limit: 25 })).resolves.toEqual({
      items: [
        {
          targetRef,
          name: "Team knowledge",
          description: "Shared engineering invariants.",
          revision: 4,
          mounted: true,
          mounts: [
            {
              ownerKind: "expert",
              ownerRef: `expert:${EXPERT_ID}`,
              ownerName: "Reflector",
              namespace: "private-knowledge",
              required: false,
            },
            {
              ownerKind: "team",
              ownerRef: `team:${TEAM_ID}`,
              ownerName: "Reflection team",
              namespace: "team-knowledge",
              required: true,
              visibility: { mode: "whitelist", expertIds: [EXPERT_ID] },
            },
            {
              ownerKind: "expert",
              ownerRef: "expert:0000000000000004",
              ownerName: "Pragma",
              namespace: "system-knowledge",
              required: true,
            },
          ],
        },
        expect.objectContaining({
          name: "Unattached knowledge",
          description: "Available but not mounted.",
          revision: 2,
          mounted: false,
          mounts: [],
        }),
      ],
    });
  });

  it("lists lightweight draft summaries without returning overlay content", async () => {
    const { port, listDrafts } = fixture();
    listDrafts.mockResolvedValue([
      {
        schemaVersion: "pragma.context-store-draft/v2",
        operation: "revise" as const,
        id: "00000000-0000-4000-8000-000000000301",
        revision: 5,
        name: "Retry invariants",
        storeId: STORE_ID,
        baseRevision: 4,
        baseSnapshotHash: "a".repeat(64),
        state: "editing",
        overlay: {
          files: [
            {
              id: "items/retry.md",
              content: "large draft content",
              metadata: { trigger: "model_decision", priority: "normal" },
            },
          ],
          deletedFiles: [],
          directories: [],
          deletedDirectories: [],
        },
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T01:00:00.000Z",
      },
    ]);

    await expect(port.listDrafts({ ...invocation, limit: 25 })).resolves.toEqual({
      items: [
        {
          draftId: "00000000-0000-4000-8000-000000000301",
          revision: 5,
          name: "Retry invariants",
          storeId: STORE_ID,
          baseRevision: 4,
          operation: "revise",
          state: "editing",
          createdAt: "2026-08-28T00:00:00.000Z",
          updatedAt: "2026-08-28T01:00:00.000Z",
        },
      ],
    });
  });

  it("recovers the writable namespace for a draft claimed by the current Mission", async () => {
    const { port, listDrafts, getDraft } = fixture(true);
    const draft = {
      schemaVersion: "pragma.context-store-draft/v2" as const,
      operation: "revise" as const,
      id: "00000000-0000-4000-8000-000000000301",
      revision: 5,
      name: "Retry invariants",
      storeId: STORE_ID,
      baseRevision: 4,
      baseSnapshotHash: "a".repeat(64),
      state: "editing" as const,
      overlay: { files: [], deletedFiles: [], directories: [], deletedDirectories: [] },
      activeMissionId: "00000000-0000-4000-8000-000000000401",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T01:00:00.000Z",
    };
    listDrafts.mockResolvedValue([draft]);
    getDraft.mockResolvedValue(draft);

    await expect(port.listDrafts({ ...invocation, limit: 25 })).resolves.toEqual({
      items: [
        expect.objectContaining({
          draftId: draft.id,
          writableNamespace: `mission-knowledge-draft:${STORE_ID}`,
        }),
      ],
    });
    await expect(port.getDraft({ ...invocation, draftId: draft.id })).resolves.toMatchObject({
      mode: "summary",
      draft: { draftId: draft.id, writableNamespace: `mission-knowledge-draft:${STORE_ID}` },
    });
  });

  it("reads draft hashes by default and only one file body on demand", async () => {
    const { port, getDraft, getDraftFile } = fixture();
    getDraft.mockResolvedValue({
      schemaVersion: "pragma.context-store-draft/v2",
      operation: "revise" as const,
      id: "00000000-0000-4000-8000-000000000301",
      revision: 5,
      name: "Retry invariants",
      storeId: STORE_ID,
      baseRevision: 4,
      baseSnapshotHash: "a".repeat(64),
      state: "editing",
      overlay: {
        files: [
          {
            id: "items/retry.md",
            content: "large draft content",
            metadata: { trigger: "model_decision", priority: "normal" },
          },
        ],
        deletedFiles: [],
        directories: [],
        deletedDirectories: [],
      },
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T01:00:00.000Z",
    });
    getDraftFile.mockResolvedValue({
      id: "items/retry.md",
      content: "large draft content",
      metadata: { trigger: "model_decision", priority: "normal" },
      revision: "draft-revision",
      etag: "draft-etag",
      truncated: false,
    });

    const summary = await port.getDraft({
      ...invocation,
      draftId: "00000000-0000-4000-8000-000000000301",
    });
    expect(summary).toMatchObject({
      mode: "summary",
      currentStoreRevision: 6,
      currentSnapshotHash: "b".repeat(64),
      stale: true,
      overlay: {
        files: [
          {
            id: "items/retry.md",
            sizeBytes: 19,
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          },
        ],
      },
    });
    expect(JSON.stringify(summary)).not.toContain("large draft content");
    expect(getDraftFile).not.toHaveBeenCalled();

    await expect(
      port.getDraft({
        ...invocation,
        draftId: "00000000-0000-4000-8000-000000000301",
        fileId: "items/retry.md",
      }),
    ).resolves.toMatchObject({
      mode: "file",
      id: "items/retry.md",
      content: expect.objectContaining({
        content: "large draft content",
        offset: 0,
        totalChars: 19,
        complete: true,
      }),
      revision: "draft-revision",
      etag: "draft-etag",
    });
  });

  it.each([false, true])(
    "uses background submission only without a Mission binding (inline=%s)",
    async (inline) => {
      const { port, start, startForMission, mountDraft, scheduleProcessing } = fixture(inline);
      const target = (await port.listTargets({ ...invocation, limit: 25 })).items.find(
        (candidate) => candidate.name === "Unattached knowledge",
      )!;
      const request = {
        ...invocation,
        teamId: TEAM_ID,
        targetRef: target.targetRef,
        prompt: "Record invariant",
        draftName: "Review invariant",
      };
      if (inline) {
        await expect(port.start(request)).resolves.toMatchObject({
          state: "running",
          writableNamespace: `mission-knowledge-draft:${UNMOUNTED_STORE_ID}`,
        });
        expect(startForMission).toHaveBeenCalledOnce();
        expect(scheduleProcessing).not.toHaveBeenCalled();
        expect(mountDraft).toHaveBeenCalledOnce();
        return;
      }
      const result = await port.start(request);
      expect(result).toMatchObject({ draftId: expect.any(String), state: "editing", target });
      expect(result.writableNamespace).toBeUndefined();
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: UNMOUNTED_STORE_ID,
          provenance: expect.objectContaining({ expertId: EXPERT_ID, teamId: TEAM_ID }),
        }),
        { draftName: "Review invariant" },
      );
      expect(scheduleProcessing).toHaveBeenCalledOnce();
      expect(startForMission).not.toHaveBeenCalled();
      expect(mountDraft).not.toHaveBeenCalled();
    },
  );

  it("delivers an explicit background continuation with a stable request id", async () => {
    const missionId = "00000000-0000-4000-8000-000000000499";
    const { port, targetRef, continueMission, scheduleProcessing } = fixture(
      false,
      "a".repeat(64),
      missionId,
    );
    const request = {
      ...invocation,
      targetRef,
      draftId: "00000000-0000-4000-8000-000000000301",
      prompt: "Finish the prepared draft",
    };
    await port.start(request);
    await port.start(request);
    expect(continueMission).toHaveBeenCalledTimes(2);
    expect(continueMission.mock.calls[0]).toEqual(continueMission.mock.calls[1]);
    expect(continueMission).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId,
        draftId: request.draftId,
        prompt: request.prompt,
        requestId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      }),
    );
    expect(scheduleProcessing).not.toHaveBeenCalled();
  });

  it("does not report an undelivered follow-up to a job still awaiting its Mission as accepted", async () => {
    const { port, targetRef, start, continueMission } = fixture(false);
    start.mockResolvedValueOnce({
      id: "job-1",
      draftId: "00000000-0000-4000-8000-000000000301",
      state: "running",
      missionId: undefined,
      request: { sourceDigest: "a".repeat(64) },
    });
    await expect(
      port.start({
        ...invocation,
        targetRef,
        draftId: "00000000-0000-4000-8000-000000000301",
        prompt: "New request",
      }),
    ).rejects.toMatchObject({ code: "already_attached", retryable: false });
    expect(continueMission).not.toHaveBeenCalled();
  });

  it("discards an unmerged draft through the revision service", async () => {
    const { port, discardDraft } = fixture();
    const draftId = "00000000-0000-4000-8000-000000000301";

    await expect(
      port.discardDraft({ ...invocation, draftId, expectedRevision: 5 }),
    ).resolves.toEqual({ draftId, discarded: true });
    expect(discardDraft).toHaveBeenCalledWith(draftId, 5);
  });

  it("rejects unavailable targets before attempting a revision", async () => {
    const { port } = fixture();
    const unmounted = (await port.listTargets({ ...invocation, limit: 25 })).items.find(
      (target) => target.name === "Unattached knowledge",
    )!;

    await expect(
      port.start({
        ...invocation,
        targetRef: "context-store:0000000000000999",
        prompt: "No",
      }),
    ).rejects.toThrow("knowledge_revision_target_unavailable");
    await expect(
      port.start({
        ...invocation,
        targetRef: unmounted.targetRef,
        prompt: "Record invariant",
      }),
    ).resolves.toMatchObject({ state: "editing", target: unmounted });
  });

  it("claims a selected Mission Knowledge target before mounting it", async () => {
    const { port, targetRef, startForMission, mountDraft, scheduleProcessing } = fixture(true);

    await expect(
      port.start({ ...invocation, targetRef, prompt: "Revise this Mission knowledge" }),
    ).resolves.toMatchObject({
      jobId: "job-1",
      missionId: "00000000-0000-4000-8000-000000000401",
      state: "running",
      writableNamespace: `mission-knowledge-draft:${STORE_ID}`,
    });
    expect(startForMission).toHaveBeenCalledWith(
      expect.objectContaining({ missionId: "00000000-0000-4000-8000-000000000401" }),
    );
    expect(mountDraft).toHaveBeenCalledWith({
      storeId: STORE_ID,
      draftId: "00000000-0000-4000-8000-000000000301",
      revisionJobId: "job-1",
    });
    expect(scheduleProcessing).not.toHaveBeenCalled();
  });

  it("returns an already-mounted revision even when the retry input differs", async () => {
    const retry = fixture(true, "a".repeat(64));

    await expect(
      retry.port.start({
        ...invocation,
        targetRef: retry.targetRef,
        prompt: "Continue with a more specific request",
      }),
    ).resolves.toMatchObject({
      jobId: "job-1",
      state: "running",
      writableNamespace: `mission-knowledge-draft:${STORE_ID}`,
    });
    expect(retry.startForMission).not.toHaveBeenCalled();
    expect(retry.attachMission).not.toHaveBeenCalled();
    expect(retry.mountDraft).toHaveBeenCalledWith({
      storeId: STORE_ID,
      draftId: "00000000-0000-4000-8000-000000000301",
      revisionJobId: "job-1",
    });
  });

  it("does not silently replace an explicitly selected draft with the active draft", async () => {
    const { port, targetRef, mountDraft } = fixture(true, "a".repeat(64));
    await expect(
      port.start({
        ...invocation,
        targetRef,
        prompt: "Continue",
        draftId: "00000000-0000-4000-8000-000000000399",
      }),
    ).rejects.toMatchObject({ code: "revision_conflict", retryable: false });
    expect(mountDraft).not.toHaveBeenCalled();
  });

  it("asks the Host to transfer an existing draft claim from an earlier Mission", async () => {
    const previousMissionId = "00000000-0000-4000-8000-000000000499";
    const { port, targetRef, attachMission, mountDraft } = fixture(
      true,
      undefined,
      previousMissionId,
    );

    await port.start({
      ...invocation,
      targetRef,
      draftId: "00000000-0000-4000-8000-000000000301",
      prompt: "Continue the existing draft",
    });

    expect(attachMission).not.toHaveBeenCalled();
    expect(mountDraft).toHaveBeenCalledWith({
      storeId: STORE_ID,
      draftId: "00000000-0000-4000-8000-000000000301",
      revisionJobId: "job-1",
      previousMissionId,
    });
  });
});
