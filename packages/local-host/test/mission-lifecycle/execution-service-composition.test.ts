import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
  defineFlow,
  type RuntimeResolver,
} from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { releaseLocalHostFlowExecution } from "../../src/missions/flow-lifecycle.ts";
import { MissionExecutionOwner } from "../../src/missions/execution-owner.ts";
import { describe, expect, it, vi } from "vitest";
import { createSqliteExecutionStore } from "../../src/execution/sqlite-execution-store.ts";
import {
  createLocalHostMissionExecutionService,
  isLocalHostMissionExecutionService,
  type LocalHostMissionExecutionResourcePorts,
} from "../../src/missions/execution-service.ts";
import { createMissionControllerStore } from "../../src/missions/controller/mission-controller-store.ts";
import { createMissionOwnerScope } from "../../src/missions/controller/owner-scope.ts";
import { createMissionControlApplication } from "../../src/missions/controller/mission-control.ts";
import type { MissionStore } from "../../src/missions/repository/mission-store.ts";

describe("execution service composition", () => {
  it.each([false, true])(
    "cancels a controller-only Core Flow and retains teardown identity (blocked=%s)",
    async (blocked) => {
      const home = await mkdtemp(join(tmpdir(), "pragma-controller-flow-release-"));
      const executions = createSqliteExecutionStore({ pragmaHome: home });
      const owners = new MissionExecutionOwner();
      let rejectTurn: (error: Error) => void = () => undefined;
      let unblockCancel = (): void => undefined;
      const cancelBarrier = new Promise<void>((resolve) => {
        unblockCancel = resolve;
      });
      const started = vi.fn();
      const cancel = vi.fn(async () => {
        rejectTurn(new Error("Native Flow turn stopped"));
      });
      const nativeClosed = vi.fn();
      const nativeClose = vi.fn(async () => {
        await cancel();
        if (blocked) await cancelBarrier;
        nativeClosed();
      });
      const runtime = defineRuntimeTestDriver<never, { id: string }>({
        descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
        createSession: ({ systemSessionId }) => ({ id: systemSessionId }),
        readSession: (session) => ({ runtimeSessionId: session.id }),
        startTurn: async () => {
          started();
          return await new Promise<never>((_resolve, reject) => {
            rejectTurn = reject;
          });
        },
        cancelTurn: cancel,
        closeSession: nativeClose,
        mapEvent: () => ({ events: [] }),
      });
      const runtimes = createStaticRuntimeResolver({
        runtimes: [runtime],
        defaultRuntimeId: "fake",
      });
      const service = createLocalHostMissionExecutionService({
        pragmaHome: home,
        executionStore: executions,
        executionOwner: owners,
        missions: {} as MissionStore,
        runtimes,
        resourcePorts: {
          createCompileService: () => ({}),
        } as LocalHostMissionExecutionResourcePorts,
      });
      const app = createPragma({
        pragmaHome: home,
        runtimes,
        executionStore: executions,
        expertSessionStore: service.controllerFactSessionStore,
      });
      const expert = await defineExpert({
        id: "aaaaaaaaaaaaaaaa",
        name: "Stopping expert",
        scope: "test",
        description: "",
        tags: [],
        workspace: home,
        pragmaHome: home,
      });
      const flow = defineFlow({ id: "controller-only-flow" });
      const step = flow.use("expert", expert);
      flow.compose(({ start, end }) => start(step).next(end()));
      const handle = await app.flows.start(flow, { input: {} });
      void handle.result.catch(() => undefined);
      const owner = { kind: "flow" as const, execution: handle };
      owners.setControlOwner("historical-controller-mission", owner, "recovered");
      try {
        await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
        if (blocked) {
          // Shorten only Host's five-second teardown observation window. Core's
          // native close deadline remains intact and the driver stays blocked.
          const schedule = globalThis.setTimeout;
          vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, timeout, ...args) =>
            schedule(handler, timeout === 5_000 ? 25 : timeout, ...args),
          );
        }
        await service.stopLocalController("historical-controller-mission");
        expect(cancel).toHaveBeenCalled();
        if (blocked) {
          await vi.waitFor(() => expect(nativeClose).toHaveBeenCalled());
          await vi.waitFor(async () =>
            expect((await executions.get(handle.executionId))?.status).toBe("cancelled"),
          );
          expect(nativeClosed).not.toHaveBeenCalled();
          expect(owners.controlOwner("historical-controller-mission")).toBe(owner);
          const replacementFlow = defineFlow({ id: "replacement-controller-flow" });
          const gate = replacementFlow.humanTask({
            id: "gate",
            request: {
              kind: "manual_intervention",
              title: "Waiting",
              prompt: "Keep successor alive",
            },
          });
          replacementFlow.compose(({ start, end }) => start(gate).next(end()));
          const replacement = await app.flows.start(replacementFlow, { input: {} });
          void replacement.result.catch(() => undefined);
          const successor = { kind: "flow" as const, execution: replacement };
          owners.setControlOwner("historical-controller-mission", successor, "recovered");
          unblockCancel();
          await handle.stopForDeletion("finish original teardown");
          expect(nativeClosed).toHaveBeenCalled();
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(owners.controlOwner("historical-controller-mission")).toBe(successor);
          await replacement.cancel("test cleanup");
        } else {
          expect(owners.controlOwner("historical-controller-mission")).toBeUndefined();
          expect((await executions.get(handle.executionId))?.status).toBe("cancelled");
        }
      } finally {
        unblockCancel();
        await handle.cancel("test cleanup").catch(() => undefined);
        vi.restoreAllMocks();
        await vi.waitFor(async () => {
          const contexts = await executions.listContexts(handle.executionId);
          expect(contexts.length).toBeGreaterThan(0);
          expect(contexts.every((context) => context["lifecycle"] === "closed")).toBe(true);
        });
        await executions.close();
        await rm(home, { recursive: true, force: true });
      }
    },
    15_000,
  );
  it("retains a terminal controller-only Flow lease until native idle release completes", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-controller-flow-idle-"));
    const executions = createSqliteExecutionStore({ pragmaHome: home });
    const owners = new MissionExecutionOwner();
    const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
    const scope = createMissionOwnerScope({ controller });
    scope.bindConsumer({ apply: async () => ({ result: {} }) });
    let unblockClose = (): void => undefined;
    const closeGate = new Promise<void>((resolve) => {
      unblockClose = resolve;
    });
    const nativeClosed = vi.fn();
    const nativeClose = vi.fn(async () => {
      await closeGate;
      nativeClosed();
    });
    const runtime = defineRuntimeTestDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: ({ systemSessionId }) => ({ id: systemSessionId }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: async () => ({ outputText: "done" }),
      closeSession: nativeClose,
      mapEvent: () => ({ events: [] }),
    });
    const runtimes = createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" });
    const service = createLocalHostMissionExecutionService({
      pragmaHome: home,
      executionStore: executions,
      executionOwner: owners,
      ownerScope: scope,
      missions: {} as MissionStore,
      runtimes,
      resourcePorts: { createCompileService: () => ({}) } as LocalHostMissionExecutionResourcePorts,
    });
    service.bindControllerFacts({
      controller,
      hasEnvelope: async () => false,
      resolveSessionId: async () => undefined,
      resolveMissionBinding: async () => undefined,
      executors: [],
    });
    const app = createPragma({
      pragmaHome: home,
      runtimes,
      executionStore: executions,
      expertSessionStore: service.controllerFactSessionStore,
    });
    const expert = await defineExpert({
      id: "aaaaaaaaaaaaaaaa",
      name: "Finishing expert",
      scope: "test",
      description: "",
      tags: [],
      workspace: home,
      pragmaHome: home,
    });
    const flow = defineFlow({ id: "idle-flow" });
    const step = flow.use("expert", expert);
    flow.compose(({ start, end }) => start(step).next(end()));
    const missionId = crypto.randomUUID();
    const guard = await scope.acquire(missionId);
    const handle = await app.flows.start(flow, { input: {} });
    void handle.result.catch(() => undefined);
    const owner = { kind: "flow" as const, execution: handle };
    owners.setControlOwner(missionId, owner, "recovered");
    let releasing: Promise<boolean> | undefined;
    try {
      await handle.result;
      await vi.waitFor(() => expect(nativeClose).toHaveBeenCalled());
      let released = false;
      releasing = service.releaseIdleSession(missionId, 0, async () => {
        released = true;
        await scope.release(missionId);
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(nativeClosed).not.toHaveBeenCalled();
      expect(released).toBe(false);
      expect(owners.controlOwner(missionId)).toBe(owner);
      await expect(scope.assertOwnership(missionId, guard)).resolves.toBeUndefined();
      unblockClose();
      await expect(releasing).resolves.toBe(true);
      expect(nativeClosed).toHaveBeenCalled();
      expect(owners.controlOwner(missionId)).toBeUndefined();
      expect((await executions.get(handle.executionId))?.status).toBe("succeeded");
    } finally {
      unblockClose();
      await releasing;
      await handle.stopForDeletion("test cleanup");
      await scope.stop(missionId);
      await vi.waitFor(async () => {
        const contexts = await executions.listContexts(handle.executionId);
        expect(contexts.every((context) => context["lifecycle"] === "closed")).toBe(true);
      });
      await executions.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  it("confirms checkpoint native release without cancelling a waiting HumanTask", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-flow-checkpoint-native-"));
    const executions = createSqliteExecutionStore({ pragmaHome: home });
    let unblockClose = (): void => undefined;
    const closeGate = new Promise<void>((resolve) => {
      unblockClose = resolve;
    });
    unblockClose();
    const effects = vi.fn(() => ({ outputText: "done" }));
    const nativeClosed = vi.fn();
    const nativeClose = vi.fn(async () => {
      await closeGate;
      nativeClosed();
    });
    const runtime = defineRuntimeTestDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: ({ systemSessionId }) => ({ id: systemSessionId }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: effects,
      closeSession: nativeClose,
      mapEvent: () => ({ events: [] }),
    });
    const runtimes = createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" });
    const app = createPragma({ pragmaHome: home, runtimes, executionStore: executions });
    const expert = await defineExpert({
      id: "aaaaaaaaaaaaaaaa",
      name: "Checkpoint expert",
      scope: "test",
      description: "",
      tags: [],
      workspace: home,
      pragmaHome: home,
    });
    const flow = defineFlow({ id: "checkpoint-native-flow" });
    const step = flow.use("expert", expert);
    const human = flow.humanTask({
      id: "gate",
      request: { kind: "manual_intervention", prompt: "Continue?" },
    });
    flow.compose(({ start, end }) => start(step).next(human).next(end()));
    const handle = await app.flows.start(flow, { input: {} });
    void handle.result.catch(() => undefined);
    let recovered: typeof handle | undefined;
    try {
      await vi.waitFor(
        async () =>
          expect(
            (await executions.listInvocations(handle.executionId)).some(
              (invocation) =>
                invocation.status === "waiting" && invocation.waitReason === "human_input",
            ),
          ).toBe(true),
        { timeout: 3000 },
      );
      const originalContexts = await executions.listContexts(handle.executionId);
      const events = await handle.listEvents({ scope: { kind: "all" } });
      const interactionId = events.items.find((event) => event.type === "human.requested")?.data[
        "interactionId"
      ];
      expect(typeof interactionId).toBe("string");
      const subscription = await handle.subscribeEvents({ scope: { kind: "all" } });
      const finished = (async () => {
        for await (const event of subscription) {
          expect(event.executionId).toBe(handle.executionId);
        }
      })();
      await handle.checkpointWaitingHuman();
      await vi.waitFor(() => expect(nativeClose).toHaveBeenCalled());
      await releaseLocalHostFlowExecution(handle);
      expect((await handle.getState()).status).toBe("waiting");
      expect(nativeClosed).toHaveBeenCalled();
      expect((await handle.getState()).status).toBe("waiting");
      recovered = await app.flows.recover(flow, { executionId: handle.executionId });
      expect(recovered).not.toBe(handle);
      await finished;
      await subscription.close();
      void recovered.result.catch(() => undefined);
      await recovered.respondToHumanInteraction(
        interactionId as string,
        { kind: "user_question", answered: true, answers: { "Continue?": "yes" } },
        { requestId: crypto.randomUUID() },
      );
      await recovered.result;
      await releaseLocalHostFlowExecution(recovered);
      expect(effects).toHaveBeenCalledTimes(1);
      expect((await recovered.getState()).status).toBe("succeeded");
      const contexts = await executions.listContexts(handle.executionId);
      for (const original of originalContexts)
        expect(
          contexts.find((context) => context.contextId === original.contextId)?.snapshot,
        ).toEqual(original.snapshot);
    } finally {
      unblockClose();
      await recovered?.cancel("test cleanup");
      await handle.cancel("test cleanup");
      await handle.releaseRuntimeResources();
      await vi.waitFor(async () =>
        expect(
          (await executions.listContexts(handle.executionId)).every(
            (context) => context.lifecycle === "closed",
          ),
        ).toBe(true),
      );
      await executions.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  it("leaves Inbox consumer binding to the composed persistence router", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-execution-composition-"));
    const executions = createSqliteExecutionStore({ pragmaHome: home });
    const controller = createMissionControllerStore({
      missionsPath: join(home, "data", "missions"),
    });
    const ownerScope = createMissionOwnerScope({ controller });
    try {
      const service = createLocalHostMissionExecutionService({
        pragmaHome: home,
        executionStore: executions,
        ownerScope,
        missions: {} as MissionStore,
        runtimes: {} as RuntimeResolver,
        resourcePorts: {
          createCompileService: () => ({}),
        } as LocalHostMissionExecutionResourcePorts,
      });
      const routedConsumer: typeof service.missionControl.consumer = {
        ...service.missionControl.consumer,
      };
      const application = createMissionControlApplication({
        controller,
        ownerScope,
        consumer: routedConsumer,
        assertMission: async () => undefined,
        resolveStrictTarget: service.missionControl.resolveStrictTarget,
        resolveExecutionTarget: service.missionControl.resolveExecutionTarget,
      });
      expect(() => service.missionControl.bindApplication(application)).not.toThrow();
      expect(() => ownerScope.bindConsumer(routedConsumer)).not.toThrow();
      expect(isLocalHostMissionExecutionService(service)).toBe(true);
      expect(isLocalHostMissionExecutionService({ ...service })).toBe(false);
      const factResources = {
        controller,
        hasEnvelope: async () => false,
        resolveSessionId: async () => undefined,
        resolveMissionBinding: async () => undefined,
        executors: [],
      };
      service.bindControllerFacts(factResources);
      expect(() => service.bindControllerFacts(factResources)).not.toThrow();
      expect(() => service.bindControllerFacts({ ...factResources })).toThrow("already bound");
      expect(service.controllerFactSessionStore).toBeDefined();
    } finally {
      await executions.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
