import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { it, expect, vi } from "vitest";

// The backfill chain is independently integration-tested; isolate the late claim boundary.
vi.mock("../../src/missions/controller/pinned-binding-backfill.ts", () => ({
  backfillMissionPinnedBinding: async () => undefined,
}));
import { createInMemoryExecutionStore } from "@pragma/core/testing";
import { createFileExpertSessionStore } from "@pragma/core";
import { resumeLocalHostMission } from "../../src/missions/resume-use-case.ts";
import { createMissionControllerStore } from "../../src/missions/controller/mission-controller-store.ts";
import { createMissionOwnerScope } from "../../src/missions/controller/owner-scope.ts";
import { createMissionPinnedBinding } from "../../src/missions/controller/pinned-binding.ts";
import type { MissionControlApplication } from "../../src/missions/controller/mission-control.ts";
import type { LocalHostCoreMissionControlAdapter } from "../../src/core-control-adapter.ts";

it.each([false, true])(
  "fences a late resume after takeover (recovery failure: %s)",
  async (failRecovery) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-resume-fencing-"));
    const controller = createMissionControllerStore({ missionsPath: root });
    const ownerScope = createMissionOwnerScope({ controller });
    const missionId = randomUUID();
    const requestId = randomUUID();
    const original = await ownerScope.acquire(missionId);
    await controller.ensurePinnedBinding({
      missionId,
      guard: original,
      binding: createMissionPinnedBinding({
        requestId: randomUUID(),
        payloadHash: `sha256:${"a".repeat(64)}`,
        command: "expert.run",
        executor: { source: "built_in", ref: { kind: "expert", id: "7k2m9q4v8np6r3dt" } },
        workspace: { canonicalPath: root, identityHash: `sha256:${"b".repeat(64)}` },
        provenance: "new_run",
      }),
    });
    await ownerScope.release(missionId);
    let unblock!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const release = vi.fn(async () => undefined);
    const checkpoint = vi.fn(async () => undefined);
    const coreControl = {
      assertAcquisitionAllowed: async () => undefined,
      recoverMission: async () => {
        entered();
        await blocked;
        if (failRecovery) throw new Error("Recovery failed");
      },
      resolveExecutionTarget: async () => undefined,
      release,
      releaseAfterHumanCheckpoint: checkpoint,
    } as unknown as LocalHostCoreMissionControlAdapter;
    const control = {
      reserveOperation: controller.reserveOperation,
      completeOperation: controller.completeOperation,
      startOwner: async () => {
        await ownerScope.acquire(missionId);
        return "acquired" as const;
      },
    } as unknown as MissionControlApplication;
    const resume = resumeLocalHostMission({
      input: { missionId, requestId },
      ownerLifetime: "request",
      missionController: controller,
      missionControl: control,
      coreControl,
      ownerScope,
      projectCatalog: { resolve: async () => undefined },
      resolveBuiltInExecutor: async () => undefined,
      expertSessionStore: createFileExpertSessionStore({
        pragmaHome: root,
        executions: createInMemoryExecutionStore(),
      }),
      executionStore: createInMemoryExecutionStore(),
    });
    const outcome = resume.then(
      () => ({ success: true }),
      (error: unknown) => ({ success: false, error }),
    );
    try {
      await started;
      await ownerScope.forceRevoke(missionId);
      const successor = await ownerScope.acquire(missionId);
      unblock();
      expect(await outcome).toMatchObject({ success: false });
      expect((await controller.getOperation({ missionId, requestId }))?.state).toBe("queued");
      expect(release).not.toHaveBeenCalled();
      expect(checkpoint).not.toHaveBeenCalled();
      await expect(ownerScope.assertOwnership(missionId, successor)).resolves.toBeUndefined();
    } finally {
      unblock();
      await outcome;
      await ownerScope.stop(missionId);
      await rm(root, { recursive: true, force: true });
    }
  },
);
