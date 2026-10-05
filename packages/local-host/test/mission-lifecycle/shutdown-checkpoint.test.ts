import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
  defineFlow,
  type RuntimeNativeSessionContext,
} from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { expect, it, vi } from "vitest";
import { createSqliteExecutionStore } from "../../src/execution/sqlite-execution-store.ts";
import { createLocalHostMissionApplication } from "../../src/missions/application.ts";
import { createLocalHostMissionController } from "../../src/missions/controller/composition.ts";
import { MissionExecutionOwner } from "../../src/missions/execution-owner.ts";
import type { LocalHostMissionExecutionResourcePorts } from "../../src/missions/execution-service.ts";
import { createMissionStore } from "../../src/missions/repository/mission-store.ts";

it.each(["flow-human", "session-human", "flow-terminal"] as const)(
  "disposes a %s through the shared release boundary without changing durable completion",
  async (kind) => {
    const home = await mkdtemp(join(tmpdir(), "pragma-shutdown-checkpoint-"));
    const executions = createSqliteExecutionStore({ pragmaHome: home });
    const owners = new MissionExecutionOwner();
    const lifecycle = createLocalHostMissionController({ missionsPath: join(home, "missions") });
    const nativeClosed = vi.fn();
    const startTurn = vi.fn(async (session: { context: RuntimeNativeSessionContext }) => {
      if (kind === "session-human") {
        await session.context.request.humanInteractionHandler!({
          kind: "tool_approval",
          toolName: "write_file",
          toolCallId: "approve-write",
          reason: "Approve write",
          input: { path: "output.txt" },
        });
      }
      return { outputText: "done" };
    });
    const runtime = defineRuntimeTestDriver<
      never,
      { id: string; context: RuntimeNativeSessionContext }
    >({
      descriptor: { id: "fake", kind: "fake", displayName: "Fixture" },
      createSession: (context) => ({ id: context.systemSessionId, context }),
      restoreSession: (context) => ({ id: context.systemSessionId, context }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn,
      mapEvent: () => ({ events: [] }),
      closeSession: async () => {
        nativeClosed();
      },
    });
    const runtimes = createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" });
    const closeResources = vi.fn(async () => {
      expect(nativeClosed).toHaveBeenCalled();
    });
    const host = createLocalHostMissionApplication({
      lifecycle,
      resolveExecutor: async () => undefined,
      closeResources,
      execution: {
        pragmaHome: home,
        runtimes,
        executionStore: executions,
        executionOwner: owners,
        missions: createMissionStore({ missionsPath: join(home, "missions") }),
        resourcePorts: {
          createCompileService: () => ({}),
        } as LocalHostMissionExecutionResourcePorts,
      },
    });
    const core = createPragma({ pragmaHome: home, runtimes, executionStore: executions });
    const expert = await defineExpert({
      id: "aaaaaaaaaaaaaaaa",
      name: "Fixture",
      scope: "test",
      description: "",
      tags: [],
      workspace: home,
      pragmaHome: home,
    });
    const missionId = randomUUID();
    let executionId!: string;
    let cancel: unknown;
    let flow: ReturnType<typeof defineFlow> | undefined;
    let sessionId: string | undefined;
    let queuedExecutionId: string | undefined;
    try {
      if (kind === "session-human") {
        const session = await core.experts.createSession(expert);
        sessionId = session.sessionId;
        const turn = await session.prompt("approval", { requestId: randomUUID() });
        void turn.result.catch(() => undefined);
        executionId = turn.executionId;
        cancel = vi.spyOn(session, "cancelPromptQueue");
        owners.setControlOwner(missionId, { kind: "session", session }, "live");
        const queued = await session.prompt("queued after approval", { requestId: randomUUID() });
        void queued.result.catch(() => undefined);
        queuedExecutionId = queued.executionId;
      } else {
        flow = defineFlow({ id: "shutdown-flow" });
        const step = flow.use("expert", expert);
        if (kind === "flow-human") {
          const human = flow.humanTask({
            id: "approval",
            request: {
              kind: "manual_intervention",
              title: "Approval",
              prompt: "Continue?",
            },
          });
          flow.compose(({ start, end }) => start(step).next(human).next(end()));
        } else flow.compose(({ start, end }) => start(step).next(end()));
        const handle = await core.flows.start(flow, { input: {} });
        void handle.result.catch(() => undefined);
        executionId = handle.executionId;
        cancel = vi.spyOn(handle, "cancel");
        owners.setControlOwner(missionId, { kind: "flow", execution: handle }, "live");
        if (kind === "flow-terminal") await handle.result;
      }
      if (kind !== "flow-terminal") {
        await vi.waitFor(async () =>
          expect(
            (await executions.listInvocations(executionId)).some(
              (invocation) =>
                invocation.status === "waiting" && invocation.waitReason === "human_input",
            ),
          ).toBe(true),
        );
      }
      await lifecycle.ownerScope.acquire(missionId);
      const originalContexts = await executions.listContexts(executionId);
      await host.dispose();
      expect(cancel).not.toHaveBeenCalled();
      expect(closeResources).toHaveBeenCalledOnce();
      expect(owners.controlOwner(missionId)).toBeUndefined();
      expect(
        (await lifecycle.controller.readSnapshot({ missionId })).snapshot.lease,
      ).toBeUndefined();
      expect((await executions.get(executionId))?.status).toBe(
        kind === "flow-terminal" ? "succeeded" : "waiting",
      );
      const identities = (contexts: typeof originalContexts) =>
        contexts.map(({ contextId, owner, expert, runtime, snapshot }) => ({
          contextId,
          owner,
          expert,
          runtime,
          snapshot,
        }));
      expect(identities(await executions.listContexts(executionId))).toEqual(
        identities(originalContexts),
      );
      if (flow !== undefined && kind === "flow-human") {
        const recovered = await core.flows.recover(flow, { executionId });
        void recovered.result.catch(() => undefined);
        const request = (await executions.readEvents(executionId)).find(
          (event) => event.type === "human.requested",
        )!;
        await recovered.respondToHumanInteraction(
          (request.data as { interactionId: string }).interactionId,
          { kind: "user_question", answered: true, answers: { "Continue?": "yes" } },
          { requestId: randomUUID() },
        );
        await recovered.result;
        await recovered.releaseRuntimeResources();
        expect(startTurn).toHaveBeenCalledOnce();
      }
      if (queuedExecutionId !== undefined) {
        expect((await executions.get(queuedExecutionId))?.status).toBe("queued");
        expect(startTurn).toHaveBeenCalledOnce();
      }
      if (sessionId !== undefined) {
        const resumed = await core.experts.resumeSession(expert, { sessionId });
        await resumed.cancelPromptQueue("test cleanup");
        await resumed.releaseAfterTerminal({ waitForIdle: true });
      }
    } finally {
      await host.dispose();
      await executions.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  15_000,
);
