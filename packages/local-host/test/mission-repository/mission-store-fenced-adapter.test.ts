import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMissionControllerStore } from "../../src/missions/controller/mission-controller-store.ts";
import { createMissionOwnerScope } from "../../src/missions/controller/owner-scope.ts";
import { PRAGMA_DSL_WRITE_API_VERSION, type PragmaExpertResource } from "@pragma/interpreter/ast";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MissionExecutorSchema } from "@pragma/shared";
function missionExecutorSnapshot(resource: PragmaExpertResource) {
  return MissionExecutorSchema.parse({
    kind: "expert",
    ref: `expert:${resource.metadata.id}`,
    name: resource.metadata.name,
  });
}

import { createMissionStore } from "../../src/missions/repository/mission-store.ts";
import { createFencedMissionStore } from "../../src/missions/repository/mission-store-fenced-adapter.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(
        async (root) =>
          await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
      ),
  );
});

describe("Local Host fenced Mission repository", () => {
  it("uses the shared Local Host owner scope for semantic writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-fenced-store-"));
    roots.push(root);
    const missionsPath = join(root, "missions");
    const rawStore = createMissionStore({ missionsPath });
    const skillDraftId = "11111111-1111-4111-8111-111111111111";
    const skillJobId = "33333333-3333-4333-8333-333333333333";
    const skillCapabilityId = "44444444-4444-4444-8444-444444444444";
    const legacyWorkspace = join(root, "legacy-worktree");
    const mission = await rawStore.create({
      workspace: { path: legacyWorkspace, basename: "legacy-worktree" },
      goal: "Check the shared owner boundary",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
      origin: {
        type: "system-skill-revision",
        jobId: skillJobId,
        capabilityId: skillCapabilityId,
      },
      contextMounts: [
        {
          kind: "skill-revision-draft",
          draftId: skillDraftId,
          revisionJobId: skillJobId,
          capabilityId: skillCapabilityId,
        },
      ],
    });
    const controller = createMissionControllerStore({
      missionsPath,
      missionPath: rawStore.storagePath,
    });
    const ownerScope = createMissionOwnerScope({ controller, leaseMs: 1_000 });
    const onExecutionChanged = vi.fn();
    const fencedStore = createFencedMissionStore(rawStore, {
      controller,
      ownerScope,
      setSemanticWriteReplay: () => undefined,
      onExecutionChanged,
    });

    await ownerScope.acquire(mission.id);
    await fencedStore.updateOptions(mission.id, { toolPermissionMode: "full-access" });
    const executionId = "22222222-2222-4222-8222-222222222222";
    await fencedStore.updateExecution(mission.id, {
      id: executionId,
      inputMessageId: mission.initialMessageId,
      status: "running",
      startedAt: "2026-09-16T00:00:00.000Z",
    });
    await fencedStore.rebindLegacySkillRevisionWorkspace({
      id: mission.id,
      draftId: skillDraftId,
      expectedWorkspacePath: legacyWorkspace,
      workspace: { path: join(root, "workspace"), basename: "workspace" },
    });
    await fencedStore.unmountSkillRevisionDraft({ id: mission.id, draftId: skillDraftId });
    await fencedStore.mountSkillRevisionDraft({
      id: mission.id,
      draftId: skillDraftId,
      revisionJobId: skillJobId,
      capabilityId: skillCapabilityId,
    });
    await fencedStore.unmountSkillRevisionDraft({ id: mission.id, draftId: skillDraftId });
    await fencedStore.updateExecution(mission.id, {
      id: executionId,
      inputMessageId: mission.initialMessageId,
      status: "succeeded",
      startedAt: "2026-09-16T00:00:00.000Z",
      finishedAt: "2026-09-16T00:01:00.000Z",
    });
    const storeId = "55555555-5555-4555-8555-555555555555";
    const managedDraftId = "66666666-6666-4666-8666-666666666666";
    const managedJobId = "77777777-7777-4777-8777-777777777777";
    await fencedStore.updateContextMounts(mission.id, [{ kind: "context-store", storeId }]);
    await fencedStore.mountManagedRevisionDraft({
      id: mission.id,
      expectedExecutorRef: mission.executor.ref,
      storeId,
      draftId: managedDraftId,
      revisionJobId: managedJobId,
    });
    await fencedStore.restoreManagedRevisionStore({
      id: mission.id,
      storeId,
      draftId: managedDraftId,
      revisionJobId: managedJobId,
    });
    await fencedStore.updateContextMounts(mission.id, []);
    await expect(rawStore.get(mission.id)).resolves.toMatchObject({
      toolPermissionMode: "full-access",
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      contextMounts: [],
    });
    await expect(controller.readSnapshot({ missionId: mission.id })).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ type: "mission.options.updated" }),
        expect.objectContaining({ type: "mission.execution.updated" }),
        expect.objectContaining({ type: "mission.skill-revision-workspace.rebound" }),
        expect.objectContaining({ type: "mission.skill-revision-draft.unmounted" }),
        expect.objectContaining({ type: "mission.skill-revision-draft.mounted" }),
        expect.objectContaining({ type: "mission.managed-revision-draft.mounted" }),
        expect.objectContaining({ type: "mission.managed-revision-store.restored" }),
      ]),
    });
    expect(onExecutionChanged).toHaveBeenCalledWith({
      missionId: mission.id,
      execution: { id: executionId, status: "running" },
    });
    await ownerScope.release(mission.id);

    const competingOwner = createMissionOwnerScope({ controller, leaseMs: 1_000 });
    await competingOwner.acquire(mission.id);
    await expect(
      fencedStore.updateOptions(mission.id, { toolPermissionMode: "request-approval" }),
    ).rejects.toMatchObject({ code: "MISSION_LEASE_HELD" });
    await competingOwner.release(mission.id);
  });

  it("recovers a pending semantic write under the same live owner before the retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-fenced-recovery-"));
    roots.push(root);
    const missionsPath = join(root, "missions");
    const rawStore = createMissionStore({ missionsPath });
    const mission = await rawStore.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Recover a projected command",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const controller = createMissionControllerStore({
      missionsPath,
      missionPath: rawStore.storagePath,
    });
    const ownerScope = createMissionOwnerScope({ controller, leaseMs: 1_000 });
    const fencedStore = createFencedMissionStore(rawStore, {
      controller,
      ownerScope,
      setSemanticWriteReplay: () => undefined,
    });
    const guard = await ownerScope.acquire(mission.id);
    const operation = {
      name: "mission.options.update",
      input: {
        id: mission.id,
        input: { toolPermissionMode: "request-approval" },
      },
    };

    await expect(
      controller.coordinateSemanticWrite({
        missionId: mission.id,
        guard,
        operation,
        eventType: "mission.options.updated",
        eventData: {},
        apply: async () => {
          throw new Error("simulated projection interruption");
        },
      }),
    ).rejects.toMatchObject({ name: "MissionSemanticWritePendingError" });

    await expect(
      fencedStore.updateOptions(mission.id, { toolPermissionMode: "request-approval" }),
    ).resolves.toMatchObject({ toolPermissionMode: "request-approval" });
    await expect(controller.readSnapshot({ missionId: mission.id })).resolves.toMatchObject({
      events: [expect.objectContaining({ type: "mission.options.updated" })],
    });
    await ownerScope.release(mission.id);
  });

  it("returns the replay result without overwriting a successor after lease revocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-fenced-recovery-revoked-"));
    roots.push(root);
    const missionsPath = join(root, "missions");
    const rawStore = createMissionStore({ missionsPath });
    const mission = await rawStore.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Preserve the successor mutation",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const controller = createMissionControllerStore({
      missionsPath,
      missionPath: rawStore.storagePath,
    });
    const ownerScope = createMissionOwnerScope({ controller, leaseMs: 1_000 });
    const successor = createMissionOwnerScope({ controller, leaseMs: 1_000 });
    const fencedStore = createFencedMissionStore(rawStore, {
      controller,
      ownerScope,
      setSemanticWriteReplay: () => undefined,
    });
    const guard = await ownerScope.acquire(mission.id);
    const operation = {
      name: "mission.options.update",
      input: { id: mission.id, input: { toolPermissionMode: "request-approval" } },
    };
    await expect(
      controller.coordinateSemanticWrite({
        missionId: mission.id,
        guard,
        operation,
        eventType: "mission.options.updated",
        eventData: {},
        apply: async () => {
          throw new Error("interrupted before mutation");
        },
      }),
    ).rejects.toMatchObject({ name: "MissionSemanticWritePendingError" });

    const mutations = vi.spyOn(rawStore, "updateOptions");
    const recover = controller.recoverSemanticWrite.bind(controller);
    vi.spyOn(controller, "recoverSemanticWrite").mockImplementationOnce(async (input) => {
      const result = await recover(input);
      await ownerScope.forceRevoke(mission.id);
      const successorGuard = await successor.acquire(mission.id);
      await controller.coordinateSemanticWrite({
        missionId: mission.id,
        guard: successorGuard,
        operation: {
          name: "mission.options.update",
          input: { id: mission.id, input: { toolPermissionMode: "full-access" } },
        },
        eventType: "mission.options.updated",
        eventData: {},
        apply: async () =>
          await rawStore.updateOptions(mission.id, { toolPermissionMode: "full-access" }),
      });
      return result;
    });
    await expect(
      fencedStore.updateOptions(mission.id, {
        toolPermissionMode: "request-approval",
      }),
    ).resolves.toMatchObject({ toolPermissionMode: "request-approval" });
    expect(mutations).toHaveBeenCalledTimes(2);
    await expect(rawStore.get(mission.id)).resolves.toMatchObject({
      toolPermissionMode: "full-access",
    });
    const snapshot = await controller.readSnapshot({ missionId: mission.id });
    expect(
      snapshot.events.filter((event) => event.type === "mission.options.updated"),
    ).toHaveLength(2);
    await successor.release(mission.id);
  });

  it("rejects a late scoped write instead of letting it acquire a successor lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-fenced-late-write-"));
    roots.push(root);
    const missionsPath = join(root, "missions");
    const rawStore = createMissionStore({ missionsPath });
    const mission = await rawStore.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Fence a late write",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const controller = createMissionControllerStore({
      missionsPath,
      missionPath: rawStore.storagePath,
    });
    const ownerScope = createMissionOwnerScope({ controller, leaseMs: 1_000 });
    const fencedStore = createFencedMissionStore(rawStore, {
      controller,
      ownerScope,
      setSemanticWriteReplay: () => undefined,
    });
    const guard = await ownerScope.acquire(mission.id);

    await ownerScope.runWithGuard(mission.id, guard, async () => {
      await ownerScope.forceRevoke(mission.id);
      await expect(
        fencedStore.updateOptions(mission.id, { toolPermissionMode: "full-access" }),
      ).rejects.toMatchObject({ code: "MISSION_FENCING_REJECTED" });
    });

    await expect(rawStore.get(mission.id)).resolves.toMatchObject({
      toolPermissionMode: "request-approval",
    });
  });
});

function expertFixture(): PragmaExpertResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id: "1xddvess309a6gme",
      avatarId: "pragma.avatar.expert.default",
      name: "Writer",
      description: "Writes concise answers",
      tags: [],
    },
    spec: {
      scope: "Writing",
      instructions: "Write concise answers.",
      runtime: { ref: "runtime-profile:rdzgnq05qfqcpqcm" },
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}
