import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMissionControllerStore } from "../../src/missions/controller/mission-controller-store.ts";
import { createMissionOwnerScope } from "../../src/missions/controller/owner-scope.ts";
import { createMissionStore } from "../../src/missions/repository/mission-store.ts";
import { observeMissionExecution } from "../../src/missions/mission-execution-observer.ts";
import { createMissionExecutionEventProjector } from "../../src/missions/mission-execution-event-projector.ts";

describe("terminal observer fencing", () => {
  it("rejects a late terminal under its original claim after a successor acquires", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-terminal-fencing-"));
    const missions = createMissionStore({ missionsPath: root });
    const controller = createMissionControllerStore({
      missionsPath: root,
      missionPath: missions.storagePath,
    });
    const scope = createMissionOwnerScope({ controller });
    scope.bindConsumer({ apply: async () => ({ result: {} }) });
    const mission = await missions.create({
      goal: "Keep the successor authoritative",
      project: { id: "studio", revision: 1 },
      workspace: { path: root, basename: "workspace" },
      executor: { kind: "expert", ref: "expert:aaaaaaaaaaaaaaaa", name: "Expert" },
    });
    const projector = createMissionExecutionEventProjector({ controller, ownerScope: scope });
    try {
      const original = await scope.acquire(mission.id);
      const executionId = crypto.randomUUID();
      await missions.updateExecution(mission.id, {
        id: executionId,
        inputMessageId: mission.initialMessageId,
        status: "running",
        startedAt: mission.createdAt,
      });
      await scope.release(mission.id);
      const successor = await scope.acquire(mission.id);
      expect(successor.claimId).not.toBe(original.claimId);
      const update = vi.spyOn(missions, "updateExecution");
      const materialize = vi.fn();
      const durable = vi.fn();
      await observeMissionExecution(
        missions,
        mission.id,
        {
          executionId,
          result: Promise.resolve("late output"),
          getState: async () => ({ status: "succeeded" }),
        },
        mission.createdAt,
        mission.initialMessageId,
        async () => undefined,
        undefined,
        async () =>
          await projector.terminal({
            mission,
            executionId,
            status: "succeeded",
            result: "late output",
            guard: original,
          }),
        undefined,
        materialize,
        undefined,
        false,
        { onDurableTerminal: durable },
      );
      expect(durable).toHaveBeenCalledWith(
        expect.objectContaining({ code: "MISSION_FENCING_REJECTED" }),
      );
      expect(update).not.toHaveBeenCalled();
      expect(materialize).not.toHaveBeenCalled();
      expect((await missions.get(mission.id)).execution?.status).toBe("running");
      const { snapshot, events } = await controller.readSnapshot({ missionId: mission.id });
      expect(events.some((event) => event.type.startsWith("run."))).toBe(false);
      expect(snapshot.lease?.claimId).toBe(successor.claimId);
      await expect(scope.assertOwnership(mission.id, successor)).resolves.toBeUndefined();
    } finally {
      await scope.stop(mission.id);
      await rm(root, { recursive: true, force: true });
    }
  });
  it("launches the original terminal detach before release without waiting for delayed cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-terminal-enrichment-fencing-"));
    const missions = createMissionStore({ missionsPath: root });
    const controller = createMissionControllerStore({
      missionsPath: root,
      missionPath: missions.storagePath,
    });
    const scope = createMissionOwnerScope({ controller });
    scope.bindConsumer({ apply: async () => ({ result: {} }) });
    const mission = await missions.create({
      goal: "Recover the same Execution",
      project: { id: "studio", revision: 1 },
      workspace: { path: root, basename: "workspace" },
      executor: { kind: "expert", ref: "expert:aaaaaaaaaaaaaaaa", name: "Expert" },
    });
    const projector = createMissionExecutionEventProjector({ controller, ownerScope: scope });
    let allowCleanup = (): void => undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      allowCleanup = resolve;
    });
    let cleanupEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      cleanupEntered = resolve;
    });
    const executionId = crypto.randomUUID();
    let finishMemory = (): void => undefined;
    const memoryGate = new Promise<void>((resolve) => {
      finishMemory = resolve;
    });
    const memoryTerminal = vi.fn(async () => await memoryGate);
    const materialize = vi.fn(async () => undefined);
    const durable = vi.fn();
    let observation: Promise<"terminal" | "checkpointed"> | undefined;
    try {
      const original = await scope.acquire(mission.id);
      await missions.updateExecution(mission.id, {
        id: executionId,
        inputMessageId: mission.initialMessageId,
        status: "running",
        startedAt: mission.createdAt,
      });
      observation = observeMissionExecution(
        missions,
        mission.id,
        {
          executionId,
          result: Promise.resolve("done"),
          getState: async () => ({ status: "succeeded" }),
        },
        mission.createdAt,
        mission.initialMessageId,
        async () => {
          cleanupEntered();
          await cleanupGate;
        },
        undefined,
        async () =>
          await projector.terminal({ mission, executionId, status: "succeeded", guard: original }),
        undefined,
        materialize,
        undefined,
        false,
        {
          onDurableTerminal: durable,
          assertEnrichmentOwnership: async () => await scope.assertOwnership(mission.id, original),
          onTerminalEnrichment: memoryTerminal,
        },
      );
      await entered;
      expect(memoryTerminal).toHaveBeenCalledOnce();
      expect(durable).toHaveBeenCalledWith(undefined);
      expect((await missions.get(mission.id)).execution?.status).toBe("succeeded");
      await scope.release(mission.id);
      const successor = await scope.acquire(mission.id);
      expect(successor.claimId).not.toBe(original.claimId);
      allowCleanup();
      await observation;
      expect(memoryTerminal).toHaveBeenCalledOnce();
      expect(materialize).not.toHaveBeenCalled();
      await expect(scope.assertOwnership(mission.id, successor)).resolves.toBeUndefined();
      expect((await missions.get(mission.id)).execution?.id).toBe(executionId);
    } finally {
      allowCleanup();
      finishMemory();
      await observation;
      await scope.stop(mission.id);
      await rm(root, { recursive: true, force: true });
    }
  });
});
