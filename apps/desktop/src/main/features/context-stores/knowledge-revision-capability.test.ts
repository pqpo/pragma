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
    request,
  }));
  const scheduleProcessing = vi.fn();
  const attachMission = vi.fn(async (_jobId: string, nextMissionId: string) => {
    missionId = nextMissionId;
  });
  const mountDraft = vi.fn(async ({ storeId }: { readonly storeId: string }) => ({
    writableNamespace: `mission-knowledge-draft:${storeId}`,
  }));
  const listDrafts = vi.fn<ContextStoreRevisionService["listDrafts"]>(async () => []);
  const getDraft = vi.fn<ContextStoreRevisionService["getDraft"]>();
  const getDraftFile = vi.fn<ContextStoreRevisionService["getDraftFile"]>();
  const revisions = {
    start,
    listDrafts,
    getDraft,
    getDraftFile,
    inspectRebase: vi.fn(),
    rebase: vi.fn(),
    submitDraft: vi.fn(),
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
    port: createDesktopKnowledgeRevisionSubmissionPort({
      project,
      contextStores,
      revisions,
      additionalMountResources: () => [systemExpert, systemContextResource],
      ...(inline
        ? {
            inlineMission: {
              id: "00000000-0000-4000-8000-000000000401",
              allowedStoreIds: new Set([STORE_ID]),
              activeRevisionJobIdForStore: async (storeId) =>
                activeSourceDigest !== undefined && storeId === STORE_ID ? "job-1" : undefined,
              writableNamespaceForStore: (storeId) => `mission-knowledge-draft:${storeId}`,
              mountDraft,
            },
          }
        : {}),
    }),
    start,
    scheduleProcessing,
    targetRef,
    attachMission,
    mountDraft,
    listDrafts,
    getDraft,
    getDraftFile,
  };
}

const invocation = {
  executionId: "execution-1",
  invocationId: "invocation-1",
  expertId: EXPERT_ID,
  operationId: "call-1",
};

describe("Desktop Pragma management knowledge revision tools", () => {
  it("lists every knowledge base with descriptions and current Expert or Team mounts", async () => {
    const { port, targetRef } = fixture();

    await expect(port.listTargets(invocation)).resolves.toEqual([
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
    ]);
  });

  it("lists lightweight draft summaries without returning overlay content", async () => {
    const { port, listDrafts } = fixture();
    listDrafts.mockResolvedValue([
      {
        schemaVersion: "pragma.context-store-draft/v1",
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

    await expect(port.listDrafts({ ...invocation })).resolves.toEqual([
      {
        draftId: "00000000-0000-4000-8000-000000000301",
        revision: 5,
        name: "Retry invariants",
        storeId: STORE_ID,
        baseRevision: 4,
        state: "editing",
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T01:00:00.000Z",
      },
    ]);
  });

  it("recovers the writable namespace for a draft claimed by the current Mission", async () => {
    const { port, listDrafts, getDraft } = fixture(true);
    const draft = {
      schemaVersion: "pragma.context-store-draft/v1" as const,
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

    await expect(port.listDrafts({ ...invocation })).resolves.toEqual([
      expect.objectContaining({
        draftId: draft.id,
        writableNamespace: `mission-knowledge-draft:${STORE_ID}`,
      }),
    ]);
    await expect(port.getDraft({ ...invocation, draftId: draft.id })).resolves.toMatchObject({
      mode: "summary",
      draft: { draftId: draft.id, writableNamespace: `mission-knowledge-draft:${STORE_ID}` },
    });
  });

  it("reads draft hashes by default and only one file body on demand", async () => {
    const { port, getDraft, getDraftFile } = fixture();
    getDraft.mockResolvedValue({
      schemaVersion: "pragma.context-store-draft/v1",
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
      content: "large draft content",
      revision: "draft-revision",
      etag: "draft-etag",
    });
  });

  it("submits to any listed target and records Team provenance when applicable", async () => {
    const { port, start, scheduleProcessing } = fixture();
    const unmounted = (await port.listTargets(invocation)).find(
      (target) => target.name === "Unattached knowledge",
    )!;

    await port.start({
      ...invocation,
      teamId: TEAM_ID,
      targetRef: unmounted.targetRef,
      prompt: "Record invariant",
    });

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: UNMOUNTED_STORE_ID,
        source: "expert-reflection",
        sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        provenance: {
          executionId: "execution-1",
          invocationId: "invocation-1",
          expertId: EXPERT_ID,
          teamId: TEAM_ID,
        },
      }),
      {},
    );
    expect(scheduleProcessing).toHaveBeenCalledOnce();
  });

  it("supports standalone Experts and rejects targets that are not in the current store list", async () => {
    const { port, start } = fixture();
    const unmounted = (await port.listTargets(invocation)).find(
      (target) => target.name === "Unattached knowledge",
    )!;

    await expect(
      port.start({
        ...invocation,
        targetRef: "context-store:0000000000000999",
        prompt: "No",
      }),
    ).rejects.toThrow("knowledge_revision_target_unavailable");
    await port.start({
      ...invocation,
      targetRef: unmounted.targetRef,
      prompt: "Record invariant",
    });
    expect(start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provenance: {
          executionId: "execution-1",
          invocationId: "invocation-1",
          expertId: EXPERT_ID,
        },
      }),
      {},
    );
  });

  it("attaches a selected Mission Knowledge target to the same Mission", async () => {
    const { port, targetRef, attachMission, mountDraft, scheduleProcessing } = fixture(true);

    await expect(
      port.start({ ...invocation, targetRef, prompt: "Revise this Mission knowledge" }),
    ).resolves.toMatchObject({
      jobId: "job-1",
      missionId: "00000000-0000-4000-8000-000000000401",
      state: "running",
      writableNamespace: `mission-knowledge-draft:${STORE_ID}`,
    });
    expect(attachMission).toHaveBeenCalledWith("job-1", "00000000-0000-4000-8000-000000000401");
    expect(mountDraft).toHaveBeenCalledWith({
      storeId: STORE_ID,
      draftId: "00000000-0000-4000-8000-000000000301",
      revisionJobId: "job-1",
    });
    expect(scheduleProcessing).not.toHaveBeenCalled();
  });

  it("returns an already-mounted matching revision without attaching or mounting it again", async () => {
    const first = fixture(true);
    await first.port.start({
      ...invocation,
      targetRef: first.targetRef,
      prompt: "Revise this Mission knowledge",
    });
    const sourceDigest = first.start.mock.calls[0]?.[0].sourceDigest;
    if (sourceDigest === undefined) throw new Error("Expected a source digest.");
    const retry = fixture(true, sourceDigest);

    await expect(
      retry.port.start({
        ...invocation,
        targetRef: retry.targetRef,
        prompt: "Revise this Mission knowledge",
      }),
    ).resolves.toMatchObject({
      jobId: "job-1",
      state: "running",
      writableNamespace: `mission-knowledge-draft:${STORE_ID}`,
    });
    expect(retry.start).not.toHaveBeenCalled();
    expect(retry.attachMission).not.toHaveBeenCalled();
    expect(retry.mountDraft).not.toHaveBeenCalled();
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

  it("rejects a direct revision target that is not mounted in the Mission", async () => {
    const { port } = fixture(true);
    const target = (await port.listTargets(invocation)).find(
      (candidate) => candidate.name === "Unattached knowledge",
    )!;

    await expect(
      port.start({ ...invocation, targetRef: target.targetRef, prompt: "Do not fork" }),
    ).rejects.toThrow("knowledge_revision_target_not_mounted");
  });
});
