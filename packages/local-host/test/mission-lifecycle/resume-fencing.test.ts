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

it.each([false, true])(
  "settles a reserved resume after a transient snapshot failure (detach: %s)",
  async (detach) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-resume-read-failure-"));
    const controller = createMissionControllerStore({ missionsPath: root });
    const ownerScope = createMissionOwnerScope({ controller });
    const missionId = randomUUID();
    const requestId = randomUUID();
    const readSnapshot = controller.readSnapshot;
    let reads = 0;
    const failure = new Error("Transient aggregate read failed");
    vi.spyOn(controller, "readSnapshot").mockImplementation(async (input) => {
      reads += 1;
      if (reads === (detach ? 2 : 1)) throw failure;
      return await readSnapshot(input);
    });
    const recover = vi.fn(async () => undefined);
    const startOwner = vi.fn(async () => {
      // Owner acquisition also reads the durable aggregate before claiming.
      await controller.readSnapshot({ missionId });
      await ownerScope.acquire(missionId);
      return "acquired" as const;
    });
    const control = {
      reserveOperation: controller.reserveOperation,
      completeOperation: controller.completeOperation,
      startOwner,
    } as unknown as MissionControlApplication;
    const executions = createInMemoryExecutionStore();
    const options = {
      input: { missionId, requestId, detach },
      ownerLifetime: "request" as const,
      missionController: controller,
      missionControl: control,
      coreControl: {
        assertAcquisitionAllowed: async () => undefined,
        recoverMission: recover,
      } as unknown as LocalHostCoreMissionControlAdapter,
      ownerScope,
      projectCatalog: { resolve: async () => undefined },
      resolveBuiltInExecutor: async () => undefined,
      expertSessionStore: createFileExpertSessionStore({ pragmaHome: root, executions }),
      executionStore: executions,
    };
    try {
      if (detach) {
        await expect(resumeLocalHostMission(options)).resolves.toMatchObject({
          status: "accepted",
          operation: { state: "queued" },
        });
      } else {
        await expect(resumeLocalHostMission(options)).rejects.toThrow(failure.message);
      }
      await expect
        .poll(async () => (await controller.getOperation({ missionId, requestId }))?.state)
        .toBe("rejected");
      const receipt = await controller.getOperation({ missionId, requestId });
      expect(receipt?.error).toMatchObject({ message: failure.message });
      expect(recover).not.toHaveBeenCalled();
      expect(ownerScope.currentGuard(missionId)).toBeUndefined();
      // The durable terminal receipt rejects an identical retry without dispatch.
      await expect(resumeLocalHostMission(options)).rejects.toMatchObject({
        message: failure.message,
      });
      expect(startOwner).toHaveBeenCalledTimes(detach ? 1 : 0);
    } finally {
      await ownerScope.stop(missionId);
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  { detach: false, status: "waiting", expectedStatus: "input_required" },
  { detach: true, status: "waiting", expectedStatus: "input_required" },
  { detach: false, status: "succeeded", expectedStatus: "resumed" },
  { detach: true, status: "succeeded", expectedStatus: "resumed" },
])(
  "settles resumed $status and replays its applied receipt (detach: $detach)",
  async ({ detach, status, expectedStatus }) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-resume-receipt-"));
    const controller = createMissionControllerStore({ missionsPath: root });
    const ownerScope = createMissionOwnerScope({ controller });
    const missionId = randomUUID();
    const requestId = randomUUID();
    const executionId = randomUUID();
    const recover = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const checkpoint = vi.fn(async () => undefined);
    const startOwner = vi.fn(async () => {
      await ownerScope.acquire(missionId);
      return "acquired" as const;
    });
    const control = {
      reserveOperation: controller.reserveOperation,
      completeOperation: controller.completeOperation,
      startOwner,
      waitExecution: async () => ({ executionId, status }),
    } as unknown as MissionControlApplication;
    const executions = createInMemoryExecutionStore();
    const options = {
      input: { missionId, requestId, detach },
      ownerLifetime: "request" as const,
      missionController: controller,
      missionControl: control,
      coreControl: {
        assertAcquisitionAllowed: async () => undefined,
        recoverMission: recover,
        resolveExecutionTarget: async () => executionId,
        release,
        releaseAfterHumanCheckpoint: checkpoint,
      } as unknown as LocalHostCoreMissionControlAdapter,
      ownerScope,
      projectCatalog: { resolve: async () => undefined },
      resolveBuiltInExecutor: async () => undefined,
      expertSessionStore: createFileExpertSessionStore({ pragmaHome: root, executions }),
      executionStore: executions,
    };
    try {
      await expect(resumeLocalHostMission(options)).resolves.toMatchObject({
        status: detach ? "accepted" : expectedStatus,
      });
      await expect
        .poll(async () => (await controller.getOperation({ missionId, requestId }))?.state)
        .toBe("applied");
      await expect(resumeLocalHostMission(options)).resolves.toMatchObject({
        status: expectedStatus,
        execution: { executionId, status },
      });
      expect(recover).toHaveBeenCalledOnce();
      expect(startOwner).toHaveBeenCalledOnce();
      expect(checkpoint).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      await expect.poll(() => ownerScope.currentGuard(missionId)).toBeUndefined();
    } finally {
      await ownerScope.stop(missionId);
      await rm(root, { recursive: true, force: true });
    }
  },
);
