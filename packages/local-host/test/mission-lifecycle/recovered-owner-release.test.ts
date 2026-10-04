import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileExpertSessionStore,
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
} from "@pragma/core";
import { createInMemoryExecutionStore, defineRuntimeTestDriver } from "@pragma/core/testing";
import type { MissionCommand } from "@pragma/shared/integration";
import { expect, it, vi } from "vitest";
import { createLocalHostCoreMissionControlAdapter } from "../../src/core-control-adapter.ts";
import type { MissionControllerGuard } from "../../src/missions/controller/mission-controller-store.ts";
import { createMissionControllerStore } from "../../src/missions/controller/mission-controller-store.ts";
import { createMissionOwnerScope } from "../../src/missions/controller/owner-scope.ts";
import { MissionExecutionOwner } from "../../src/missions/execution-owner.ts";
import { createLocalHostMissionMemoryLifecycle } from "../../src/mission-memory-lifecycle.ts";

it.each(["native", "memory"] as const)(
  "serializes recovered %s release before a competing prompt and drains its successor",
  { timeout: 15_000 },
  async (boundary) => {
    const home = await mkdtemp(join(tmpdir(), "pragma-recovered-release-"));
    const executions = createInMemoryExecutionStore();
    const sessions = createFileExpertSessionStore({ pragmaHome: home, executions });
    const controller = createMissionControllerStore({
      missionsPath: join(home, "data", "missions"),
    });
    const scope = createMissionOwnerScope({ controller });
    const owners = new MissionExecutionOwner();
    const missionId = randomUUID();
    let finishB!: () => void;
    const gateB = new Promise<void>((resolve) => {
      finishB = resolve;
    });
    let turns = 0;
    let allowResourceRelease!: () => void;
    const resourceGate = new Promise<void>((resolve) => {
      allowResourceRelease = resolve;
    });
    const closeNative = vi.fn(async () => {
      if (boundary === "native" && closeNative.mock.calls.length === 1) await resourceGate;
    });
    const runtime = defineRuntimeTestDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: (context) => ({ id: context.systemSessionId }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: async () => {
        turns += 1;
        if (turns === 2) await gateB;
        return { outputText: "done" };
      },
      mapEvent: () => ({ events: [] }),
      closeSession: closeNative,
    });
    const runtimes = createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" });
    const app = createPragma({
      pragmaHome: home,
      runtimes,
      executionStore: executions,
      expertSessionStore: sessions,
    });
    const expert = await defineExpert({
      id: "release-worker",
      name: "Worker",
      description: "Worker",
      tags: [],
      scope: "test",
      workspace: home,
      defaultRuntimeId: "fake",
    });
    const states = vi.fn<(input: unknown) => Promise<void>>(async () => undefined);
    const stopMemory = vi.fn(async () => undefined);
    const memory = createLocalHostMissionMemoryLifecycle({
      ports: {
        bindings: async () => [],
        register: async () => undefined,
        setConversationState: states,
        stopMission: stopMemory,
      },
    });
    const originalGuard = await scope.acquire(missionId);
    const sessionA = await app.experts.createSession(expert);
    const turnA = await sessionA.prompt("A", { requestId: randomUUID() });
    await turnA.result;
    await turnA.settled;
    const originalContexts = await executions.listContexts(turnA.executionId);
    await memory.register({ missionId, executionId: turnA.executionId });
    owners.setControlOwner(missionId, { kind: "session", session: sessionA }, "recovered");
    let currentExecutionId = turnA.executionId;

    let releaseCalls = 0;
    const releaseMissionOwner = vi.fn(async (id: string, guard: MissionControllerGuard) => {
      releaseCalls += 1;
      if (boundary === "memory" && releaseCalls === 1) await resourceGate;
      // The real composition reads current durable association at resource completion.
      await memory.complete(id, currentExecutionId);
      await scope.assertOwnership(id, guard);
      await scope.release(id, guard);
    });
    const control = createLocalHostCoreMissionControlAdapter({
      ownerAccess: owners,
      runtimes,
      executions,
      sessions,
      executors: [],
      resolveMissionBinding: async () => undefined,
      releaseMissionOwner,
      currentMissionGuard: (id) => scope.currentGuard(id),
      assertMissionOwnership: (id, guard) => scope.assertOwnership(id, guard),
    });
    const command = {
      missionId,
      kind: "queue.pause",
      request: { requestId: randomUUID() },
    } as MissionCommand;
    try {
      await control.consumer.afterOutcome!({ command, guard: originalGuard, state: "applied" });
      await vi.waitFor(() => expect(closeNative).toHaveBeenCalledOnce());
      if (boundary === "memory")
        await vi.waitFor(() => expect(releaseMissionOwner).toHaveBeenCalledOnce());
      else expect(releaseMissionOwner).not.toHaveBeenCalled();
      expect(closeNative).toHaveBeenCalledOnce();
      const admittedB = vi.fn();
      const admissionB = owners.admit(missionId, async () => {
        admittedB();
        const guardB = await scope.acquire(missionId);
        const sessionB = await app.experts.createSession(expert);
        const turnB = await sessionB.prompt("B", { requestId: randomUUID() });
        currentExecutionId = turnB.executionId;
        await memory.register({ missionId, executionId: turnB.executionId });
        owners.setControlOwner(missionId, { kind: "session", session: sessionB }, "recovered");
        return { guardB, sessionB, turnB };
      });
      // The short barrier observes the competing admission, not Runtime latency.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(admittedB).not.toHaveBeenCalled();
      await scope.assertOwnership(missionId, originalGuard);
      allowResourceRelease();
      const b = await admissionB;
      await control.consumer.afterOutcome!({ command, guard: b.guardB, state: "applied" });
      expect(b.guardB).not.toEqual(originalGuard);
      await scope.assertOwnership(missionId, b.guardB);
      expect(owners.controlOwner(missionId)).toMatchObject({
        kind: "session",
        session: b.sessionB,
      });
      expect(states).toHaveBeenLastCalledWith({ missionId, state: "running" });
      expect(await executions.listContexts(turnA.executionId)).toEqual(originalContexts);
      expect(stopMemory).toHaveBeenCalledTimes(1);
      finishB();
      await b.turnB.result;
      await b.turnB.settled;
      await control.waitExecution({ missionId, executionId: b.turnB.executionId });
      await vi.waitFor(() => expect(scope.currentGuard(missionId)).toBeUndefined());
      expect(owners.controlOwner(missionId)).toBeUndefined();
      expect(releaseMissionOwner).toHaveBeenCalledTimes(2);
      expect(stopMemory).toHaveBeenCalledTimes(2);
      expect(states).toHaveBeenLastCalledWith({ missionId, state: "completed" });
      expect(closeNative).toHaveBeenCalledTimes(2);
    } finally {
      finishB();
      allowResourceRelease();
      await scope.stop(missionId);

      await rm(home, { recursive: true, force: true, maxRetries: 3 });
    }
  },
);
