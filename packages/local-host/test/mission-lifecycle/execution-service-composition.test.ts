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
