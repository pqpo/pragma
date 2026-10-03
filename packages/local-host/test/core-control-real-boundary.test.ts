import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPragma,
  createFileExpertSessionStore,
  createStaticRuntimeResolver,
  defineExpert,
  defineFlow,
  ExecutionController,
  FlowExecutionManager,
  FlowInterruptionUnconfirmedError,
  type ExecutionStore,
  type ExpertSessionStore,
  type RuntimeResolver,
  type RuntimeNativeSessionContext,
} from "@pragma/core";
import { createInMemoryExecutionStore, defineRuntimeTestDriver } from "@pragma/core/testing";
import { createSqliteExecutionStore } from "../src/execution/sqlite-execution-store.ts";
import { MissionExecutionOwner } from "../src/missions/execution-owner.ts";
import { createMissionOwnerScope } from "../src/missions/controller/owner-scope.ts";
import { createLocalHostCoreMissionControlAdapter } from "../src/core-control-adapter.ts";
import { createMissionControllerStore, MissionSemanticWritePendingError } from "../src/index.ts";
import type { MissionCommand } from "@pragma/shared/integration";

const requestId = "00000000-0000-4000-8000-000000000001";
const guard = { claimId: "00000000-0000-4000-8000-000000000002", fencingToken: "1" };
const homes: string[] = [];
const stores: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map(async (store) => await store.close()));
  await Promise.all(
    homes.splice(0).map(async (home) => await rm(home, { recursive: true, force: true })),
  );
});
async function home() {
  const value = await mkdtemp(join(tmpdir(), "pragma-control-boundary-"));
  homes.push(value);
  return value;
}
const runtimes = {
  bind: async () => ({ binding: { runtimeId: "fake", revision: 1, fingerprint: "a".repeat(64) } }),
} as RuntimeResolver;
const input = (command: MissionCommand) => ({
  command,
  guard,
  signal: new AbortController().signal,
  deadlineAt: "2026-10-02T01:00:00.000Z",
});
function respond(
  missionId: string,
  interactionId: string,
  approved: boolean,
  id = requestId,
): MissionCommand {
  return {
    missionId,
    kind: "respond",
    target: { executionId: missionId, interactionId },
    payload: { kind: "respond", response: { approved } },
    request: { requestId: id },
  } as MissionCommand;
}
async function approvalFixture(approved: boolean) {
  const executions = createInMemoryExecutionStore();
  const app = createPragma({
    pragmaHome: await home(),
    runtimes,
    executionStore: executions,
    expertSessionStore: {} as ExpertSessionStore,
  });
  const flow = defineFlow({ id: "approval-boundary" });
  const gate = flow.humanTask({
    id: "gate",
    request: {
      kind: "approval",
      prompt: "Ship?",
      options: [
        { label: "Ship", description: "Ship" },
        { label: "Hold", description: "Hold" },
      ],
      approveOption: "Ship",
    },
  });
  flow.compose(({ start, end }) => start(gate).next(end()));
  const execution = await app.flows.start(flow, { input: null });
  void execution.result.catch(() => undefined);
  await vi.waitFor(async () =>
    expect(
      (await executions.readEvents(execution.executionId)).some(
        (event) => event.type === "human.requested",
      ),
    ).toBe(true),
  );
  const event = (await executions.readEvents(execution.executionId)).find(
    (event) => event.type === "human.requested",
  )!;
  const interactionId = (event.data as { interactionId: string }).interactionId;
  const adapter = createLocalHostCoreMissionControlAdapter({
    runtimes,
    executions,
    sessions: {} as ExpertSessionStore,
    executors: [],
    resolveMissionBinding: async () => undefined,
    resolveActiveOwner: async () => ({ kind: "flow", execution }),
  });
  return {
    app,
    flow,
    executions,
    execution,
    adapter,
    command: respond(execution.executionId, interactionId, approved),
  };
}

describe("Mission control against real Core execution boundaries", () => {
  it.each(["release", "checkpoint", "settlement"] as const)(
    "checkpoints a recovered HumanTask before releasing native resources via %s",
    async (boundary) => {
      const f = await approvalFixture(true);
      const owners = new MissionExecutionOwner();
      const checkpoint = vi.fn(async () => await f.execution.checkpointWaitingHuman());
      const release = vi.fn(async () => {
        expect((await f.executions.get(f.execution.executionId))?.status).toBe("waiting");
        await f.execution.releaseRuntimeResources();
      });
      owners.setControlOwner(
        f.execution.executionId,
        {
          kind: "flow",
          execution: {
            ...f.execution,
            getState: () => f.execution.getState(),
            checkpointWaitingHuman: checkpoint,
            releaseRuntimeResources: release,
          },
        },
        "recovered",
      );
      const releaseMissionOwner = vi.fn(async () => undefined);
      const control = createLocalHostCoreMissionControlAdapter({
        ownerAccess: owners,
        runtimes,
        executions: f.executions,
        sessions: {} as ExpertSessionStore,
        executors: [],
        resolveMissionBinding: async () => undefined,
        releaseMissionOwner,
      });
      if (boundary === "release") await control.release(f.execution.executionId);
      else if (boundary === "checkpoint")
        await control.releaseAfterHumanCheckpoint(f.execution.executionId, guard);
      else {
        await control.consumer.afterOutcome?.({ command: f.command, guard, state: "applied" });
        await vi.waitFor(() => expect(releaseMissionOwner).toHaveBeenCalledOnce());
      }
      expect(checkpoint).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(owners.controlOwner(f.execution.executionId)).toBeUndefined();
      const recovered = await f.app.flows.recover(f.flow, { executionId: f.execution.executionId });
      const resumed = createLocalHostCoreMissionControlAdapter({
        runtimes,
        executions: f.executions,
        sessions: {} as ExpertSessionStore,
        executors: [],
        resolveMissionBinding: async () => undefined,
        resolveActiveOwner: async () => ({ kind: "flow", execution: recovered }),
      });
      await resumed.consumer.apply(input(f.command));
      await expect(recovered.result).resolves.toMatchObject({ approved: true });
      expect(
        (await f.executions.readEvents(f.execution.executionId)).filter(
          (event) => event.type === "human.requested",
        ),
      ).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "retains the recovered Flow claim through terminal teardown (takeover: %s)",
    async (takeover) => {
      const f = await approvalFixture(true);
      await f.adapter.consumer.apply(input(f.command));
      await f.execution.result;
      const owners = new MissionExecutionOwner();
      let confirmClose: () => void = () => undefined;
      const closed = new Promise<void>((resolve) => {
        confirmClose = resolve;
      });
      const releaseRuntimeResources = vi.fn(async () => await closed);
      const owner = {
        kind: "flow" as const,
        execution: { ...f.execution, releaseRuntimeResources },
      };
      owners.setControlOwner(f.execution.executionId, owner, "recovered");
      const releaseMissionOwner = vi.fn(async () => undefined);
      const controller = createMissionControllerStore({ missionsPath: await home() });
      const scope = createMissionOwnerScope({ controller });
      const originalGuard = await scope.acquire(f.execution.executionId);
      const control = createLocalHostCoreMissionControlAdapter({
        ownerAccess: owners,
        runtimes,
        executions: f.executions,
        sessions: {} as ExpertSessionStore,
        executors: [],
        resolveMissionBinding: async () => undefined,
        releaseMissionOwner,
        assertMissionOwnership: (id, capturedGuard) => scope.assertOwnership(id, capturedGuard),
      });
      try {
        const applied = await control.consumer.apply(input(f.command));
        await control.consumer.afterOutcome?.({
          command: f.command,
          guard: originalGuard,
          state: "applied",
          result: applied.result,
        });
        await vi.waitFor(() => expect(releaseRuntimeResources).toHaveBeenCalledOnce());
        expect(owners.controlOwner(f.execution.executionId)).toBe(owner);
        expect(releaseMissionOwner).not.toHaveBeenCalled();
        let replacementGuard;
        if (takeover) {
          await scope.forceRevoke(f.execution.executionId);
          replacementGuard = await scope.acquire(f.execution.executionId);
        }
        const settlement = control.waitExecution({
          missionId: f.execution.executionId,
          executionId: f.execution.executionId,
        });
        confirmClose();
        if (takeover) {
          await expect(settlement).rejects.toMatchObject({ code: "MISSION_FENCING_REJECTED" });
          expect(releaseMissionOwner).not.toHaveBeenCalled();
          await scope.assertOwnership(f.execution.executionId, replacementGuard!);
        } else {
          await settlement;
          expect(releaseMissionOwner).toHaveBeenCalledExactlyOnceWith(
            f.execution.executionId,
            originalGuard,
          );
          expect(owners.controlOwner(f.execution.executionId)).toBeUndefined();
        }
      } finally {
        confirmClose();
        await scope.stop(f.execution.executionId);
      }
    },
  );

  it.each([true, false])(
    "answers a Flow approval using its original user-question shape: %s",
    async (approved) => {
      const f = await approvalFixture(approved);
      await f.adapter.consumer.apply(input(f.command));
      await expect(f.execution.result).resolves.toMatchObject({
        approved,
        decision: approved ? "Ship" : "Hold",
      });
      expect(
        (await f.executions.readEvents(f.execution.executionId)).find(
          (event) => event.type === "human.responded",
        )?.data,
      ).toMatchObject({
        response: { kind: "user_question", answers: { "Ship?": approved ? "Ship" : "Hold" } },
      });
    },
  );

  it("replays a terminal Flow response receipt before recovery and rejects another request", async () => {
    const f = await approvalFixture(true);
    await f.adapter.consumer.apply(input(f.command));
    await f.execution.result;
    const recover = vi.fn(async () => {
      throw new Error("terminal Flow cannot recover");
    });
    const replay = createLocalHostCoreMissionControlAdapter({
      runtimes,
      executions: f.executions,
      sessions: {} as ExpertSessionStore,
      executors: [],
      resolveMissionBinding: async () => undefined,
      recoverActiveOwner: recover,
    });
    await expect(replay.consumer.apply(input(f.command))).resolves.toMatchObject({
      result: { interactionId: f.command.target?.interactionId },
    });
    await expect(
      replay.consumer.apply(
        input(
          respond(
            f.execution.executionId,
            f.command.target!.interactionId!,
            true,
            "00000000-0000-4000-8000-000000000003",
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: "INTERACTION_NOT_PENDING" });
    expect(recover).not.toHaveBeenCalled();
    expect(
      (await f.executions.readEvents(f.execution.executionId)).filter(
        (event) => event.type === "human.responded",
      ),
    ).toHaveLength(1);
  });

  it("answers a current Session interaction without scanning history and replays its terminal receipt before recovery", async () => {
    const pragmaHome = await home();
    const executions = createInMemoryExecutionStore();
    const sessions = createFileExpertSessionStore({ executions, pragmaHome });
    const runtime = defineRuntimeTestDriver<
      never,
      { id: string; context: RuntimeNativeSessionContext }
    >({
      descriptor: { id: "human", kind: "fake", displayName: "Human" },
      createSession: (context) => ({ id: context.systemSessionId, context }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: async (native) => {
        const handler = native.context.request.humanInteractionHandler!;
        await handler({
          kind: "user_question",
          toolName: "askUserQuestion",
          toolCallId: "session-question",
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              kind: "single_choice",
              options: [{ label: "Yes", description: "Continue" }],
            },
          ],
        });
        return { outputText: "done" };
      },
      mapEvent: () => ({ events: [] }),
      closeSession: () => undefined,
    });
    const resolver = createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: "human",
    });
    const app = createPragma({
      pragmaHome,
      runtimes: resolver,
      executionStore: executions,
      expertSessionStore: sessions,
    });
    const expert = await defineExpert({
      id: "human-worker",
      name: "Worker",
      description: "Worker",
      tags: [],
      scope: "test",
      workspace: pragmaHome,
      defaultRuntimeId: "human",
    });
    const session = await app.experts.createSession(expert);
    const turn = await session.prompt("work", { requestId: "initial" });
    void turn.result.catch(() => undefined);
    await vi.waitFor(async () =>
      expect(
        (await executions.readEvents(turn.executionId)).some(
          (event) => event.type === "human.requested",
        ),
      ).toBe(true),
    );
    const interactionId = (
      (await executions.readEvents(turn.executionId)).find(
        (event) => event.type === "human.requested",
      )!.data as { interactionId: string }
    ).interactionId;
    const originalGet = sessions.get.bind(sessions);
    const getSession = vi.fn(async (id: string) => {
      const record = await originalGet(id);
      return record === undefined
        ? undefined
        : {
            ...record,
            executionIds: [
              ...Array.from({ length: 200 }, (_, i) => `historical-${i}`),
              ...record.executionIds,
            ],
          };
    });
    const controlSessions = { ...sessions, get: getSession };
    const reads = vi.spyOn(executions, "readEvents");
    const command = {
      ...respond(session.sessionId, interactionId, true),
      target: { interactionId },
      payload: { kind: "respond", response: { answers: { "Continue?": "Yes" } } },
    } as MissionCommand;
    const adapter = createLocalHostCoreMissionControlAdapter({
      runtimes: resolver,
      executions,
      sessions: controlSessions,
      executors: [],
      resolveMissionBinding: async () => undefined,
      resolveExecutionId: async () => turn.executionId,
      resolveActiveOwner: async () => ({ kind: "session", session }),
    });
    await adapter.consumer.apply(input(command));
    await turn.result;
    expect(reads.mock.calls.some(([id]) => id.startsWith("historical-"))).toBe(false);
    expect(getSession).not.toHaveBeenCalled();
    const recover = vi.fn(async () => {
      throw new Error("must not recover terminal response");
    });
    const replay = createLocalHostCoreMissionControlAdapter({
      runtimes: resolver,
      executions,
      sessions: controlSessions,
      executors: [],
      resolveMissionBinding: async () => undefined,
      resolveExecutionId: async () => "newer-execution",
      resolveSessionId: async () => session.sessionId,
      recoverActiveOwner: recover,
    });
    await expect(replay.consumer.apply(input(command))).resolves.toMatchObject({
      result: { executionId: turn.executionId, interactionId },
    });
    expect(recover).not.toHaveBeenCalled();
    expect(
      (await executions.readEvents(turn.executionId)).filter(
        (event) => event.type === "human.responded",
      ),
    ).toHaveLength(1);
    await session.close();
  });

  it("keeps a Core-accepted response applying when projection fails and replays its receipt", async () => {
    const f = await approvalFixture(true);
    const controller = createMissionControllerStore({
      missionsPath: join(await home(), "missions"),
    });
    const missionId = f.execution.executionId;
    const claimed = await controller.claim({ missionId, claimId: guard.claimId, leaseMs: 30_000 });
    await controller.appendCommand({
      missionId,
      kind: "respond",
      target: f.command.target,
      payload: f.command.payload,
      request: {
        schemaVersion: "pragma.integration-request/v1",
        requestId,
        payloadHash: `sha256:${"a".repeat(64)}`,
        requestedAt: new Date().toISOString(),
        client: { surface: "desktop", version: "test", instanceId: guard.claimId },
      },
    });
    let fail = true;
    const adapter = createLocalHostCoreMissionControlAdapter({
      runtimes,
      executions: f.executions,
      sessions: {} as ExpertSessionStore,
      executors: [],
      resolveMissionBinding: async () => undefined,
      resolveActiveOwner: async () => ({ kind: "flow", execution: f.execution }),
      onCommandApplied: async () => {
        if (fail) throw new Error("projection failed");
      },
    });
    await expect(
      controller.processNext({ missionId, guard: claimed, consumer: adapter.consumer }),
    ).rejects.toBeInstanceOf(MissionSemanticWritePendingError);
    expect((await controller.getOperation({ missionId, requestId }))?.state).toBe("applying");
    await f.execution.result;
    fail = false;
    await controller.processNext({ missionId, guard: claimed, consumer: adapter.consumer });
    expect((await controller.getOperation({ missionId, requestId }))?.state).toBe("applied");
    expect(
      (await f.executions.readEvents(missionId)).filter(
        (event) => event.type === "human.responded",
      ),
    ).toHaveLength(1);
  });
});

async function copyColdExecution(
  source: ExecutionStore,
  executionId: string,
  target: ExecutionStore = createInMemoryExecutionStore(),
): Promise<ExecutionStore> {
  const record = (await source.get(executionId))!;
  const invocations = await source.listInvocations(executionId);
  delete record.state["__recoveryClaim"];
  await target.create(
    record,
    invocations.find((invocation) => invocation.invocationId === record.rootInvocationId)!,
  );
  await target.commit({
    commitId: "crash-snapshot",
    executionId,
    invocationPuts: invocations.filter(
      (invocation) => invocation.invocationId !== record.rootInvocationId,
    ),
    contextPuts: await source.listContexts(executionId),
    agentPuts: await source.listAgents(executionId),
  });
  return target;
}

describe("cold Flow interruption", () => {
  it("does not rerun an unfinished Task and uses the stop-only Core boundary", async () => {
    const executions = createInMemoryExecutionStore();
    const manager = new FlowExecutionManager(executions, runtimes, undefined, await home());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = vi.fn(async () => {
      await gate;
      return "done";
    });
    const flow = defineFlow({ id: "unfinished-task" });
    flow.compose(({ start, end }) =>
      start(flow.task({ id: "external-effect", handler: task })).next(end()),
    );
    const original = await manager.start(flow, { input: null });
    void original.result.catch(() => undefined);
    await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
    const cold = await copyColdExecution(executions, original.executionId);
    await original.cancel("simulated shutdown");
    release();
    await original.result.catch(() => undefined);
    const stopped = new FlowExecutionManager(cold, runtimes, undefined, await home());
    const recover = vi.fn(async () => {
      throw new Error("must not activate");
    });
    const owners = new MissionExecutionOwner();
    let failStop = true;
    const adapter = createLocalHostCoreMissionControlAdapter({
      ownerAccess: owners,
      runtimes,
      executions: cold,
      sessions: {} as ExpertSessionStore,
      executors: [],
      resolveMissionBinding: async () => undefined,
      recoverActiveOwner: recover,
      stopFlow: async (_missionId, executionId, reason, signal) => {
        if (failStop)
          throw new FlowInterruptionUnconfirmedError(executionId, new Error("native unavailable"));
        await stopped.stop(flow, { executionId, reason, signal });
      },
    });
    const command = {
      missionId: original.executionId,
      kind: "interrupt",
      target: { executionId: original.executionId },
      payload: { kind: "interrupt", reason: "stop" },
      request: { requestId },
    } as MissionCommand;
    await expect(adapter.consumer.apply(input(command))).rejects.toBeInstanceOf(
      MissionSemanticWritePendingError,
    );
    expect(owners.controlIssue(original.executionId)).toMatchObject({
      reasonCode: "MISSION_INTERRUPT_UNCERTAIN",
    });
    expect((await cold.get(original.executionId))?.status).toBe("running");
    failStop = false;
    await adapter.consumer.apply(input(command));
    expect(owners.controlIssue(original.executionId)).toBeUndefined();
    await adapter.consumer.apply(input(command));
    expect((await cold.get(original.executionId))?.status).toBe("cancelled");
    expect(task).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
  });

  it.each(["running", "interrupted"] as const)(
    "stops a cold %s Flow using exact Native identity and preserves safe retry/replay",
    async (status) => {
      const pragmaHome = await home();
      const restore = vi.fn((context: RuntimeNativeSessionContext) => ({
        id: context.request.runtimeSession!.id,
      }));
      let failStop = false;
      let waitForStop: Promise<void> | undefined;
      const close = vi.fn(async () => {
        if (failStop) throw new Error("native stop failed");
        await waitForStop;
      });
      const start = vi.fn(async (_session: { id: string }, turn: { signal: AbortSignal }) => {
        await new Promise<never>((_resolve, reject) => {
          if (turn.signal.aborted) reject(turn.signal.reason);
          else
            turn.signal.addEventListener("abort", () => reject(turn.signal.reason), { once: true });
        });
        return { outputText: "done" };
      });
      const runtime = defineRuntimeTestDriver<never, { id: string }>({
        descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
        createSession: () => ({ id: "owned-native" }),
        restoreSession: restore,
        readSession: (session) => ({ runtimeSessionId: session.id }),
        startTurn: start,
        mapEvent: () => ({ events: [] }),
        cancelTurn: () => undefined,
        closeSession: close,
      });
      const resolver = createStaticRuntimeResolver({
        runtimes: [runtime],
        defaultRuntimeId: "fake",
      });
      const expert = await defineExpert({
        id: "worker",
        name: "Worker",
        description: "Worker",
        tags: [],
        scope: "test",
        instructions: "Work",
        workspace: pragmaHome,
        defaultRuntimeId: "fake",
      });
      const flow = defineFlow({ id: "native-stop" });
      const step = flow.use("worker", expert);
      flow.compose(({ start, end }) => start(step).next(end()));
      const source = createInMemoryExecutionStore();
      const original = await new FlowExecutionManager(
        source,
        resolver,
        undefined,
        pragmaHome,
      ).start(flow, { input: null });
      void original.result.catch(() => undefined);
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      const snapshot = (await source.listContexts(original.executionId))[0]!;
      const sqlite =
        status === "interrupted"
          ? createSqliteExecutionStore({ pragmaHome: await home() })
          : undefined;
      if (sqlite !== undefined) stores.push(sqlite);
      const cold = await copyColdExecution(source, original.executionId, sqlite);
      if (status === "interrupted") {
        await cold.commit({
          commitId: "persisted-interrupted",
          executionId: original.executionId,
          executionPatch: { status: "interrupted" },
          invocationPatches: (await cold.listInvocations(original.executionId))
            .filter((invocation) => invocation.status === "running")
            .map((invocation) => ({
              invocationId: invocation.invocationId,
              patch: { status: "interrupted" },
            })),
        });
      }
      if (status === "interrupted") {
        await new ExecutionController(original.executionId, cold).cancel("ordinary cancellation");
        expect((await cold.get(original.executionId))?.status).toBe("interrupted");
        await expect(
          cold.commit({
            commitId: "unclaimed-interrupted-cancel",
            executionId: original.executionId,
            executionPatch: { status: "cancelled" },
          }),
        ).rejects.toMatchObject({ name: "ExecutionFinalStatusConflictError" });
      }
      if (status === "interrupted") {
        for (const claimCase of ["wrong", "expired"] as const) {
          const current = (await cold.get(original.executionId))!;
          await cold.commit({
            commitId: `claim-${claimCase}`,
            executionId: original.executionId,
            executionPatch: {
              state: {
                ...current.state,
                __recoveryClaim: {
                  claimId: "held",
                  expiresAt: new Date(
                    Date.now() + (claimCase === "expired" ? -1_000 : 30_000),
                  ).toISOString(),
                },
              },
            },
          });
          for (const boundary of ["execution", "invocation"] as const) {
            await expect(
              cold.commit({
                commitId: `reject-${claimCase}-${boundary}`,
                executionId: original.executionId,
                recoveryClaimId: claimCase === "wrong" ? "other" : "held",
                ...(boundary === "execution"
                  ? { executionPatch: { status: "cancelled" as const } }
                  : {
                      invocationPatches: [
                        {
                          invocationId: original.executionId,
                          patch: { status: "cancelled" as const },
                        },
                      ],
                    }),
              }),
            ).rejects.toMatchObject({ name: "ExecutionFinalStatusConflictError" });
          }
        }
        const current = (await cold.get(original.executionId))!;
        delete current.state["__recoveryClaim"];
        await cold.commit({
          commitId: "clear-test-claim",
          executionId: original.executionId,
          executionPatch: { state: current.state },
        });
      }
      await original.cancel("shutdown");
      await original.result.catch(() => undefined);
      const missingSnapshot = await copyColdExecution(cold, original.executionId);
      await missingSnapshot.commit({
        commitId: "snapshot-missing",
        executionId: original.executionId,
        contextPatches: [{ contextId: snapshot.contextId, patch: { snapshot: undefined } }],
      });
      await expect(
        new FlowExecutionManager(missingSnapshot, resolver, undefined, pragmaHome).stop(flow, {
          executionId: original.executionId,
        }),
      ).rejects.toMatchObject({ code: "FLOW_NATIVE_STOP_UNCONFIRMED" });
      expect((await missingSnapshot.get(original.executionId))?.status).toBe(status);
      expect(restore).not.toHaveBeenCalled();
      failStop = true;
      const manager = new FlowExecutionManager(cold, resolver, undefined, pragmaHome);
      await expect(manager.stop(flow, { executionId: original.executionId })).rejects.toMatchObject(
        {
          code: "FLOW_NATIVE_STOP_UNCONFIRMED",
        },
      );
      expect((await cold.get(original.executionId))?.status).toBe(status);
      expect((await cold.listContexts(original.executionId))[0]?.lifecycle).toBe("open");
      expect(restore.mock.calls[0]?.[0].request).toMatchObject({
        owner: {
          type: "flow-execution",
          ownerId: original.executionId,
          invocationId: snapshot.origin.type === "invocation" ? snapshot.origin.invocationId : "",
        },
        systemSessionId: snapshot.snapshot!.systemSessionId,
        runtimeSession: snapshot.snapshot!.runtimeSession,
      });
      failStop = false;
      const takeoverStore = await copyColdExecution(cold, original.executionId);
      let releaseStop!: () => void;
      waitForStop = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      const closes = close.mock.calls.length;
      const takeover = new FlowExecutionManager(
        takeoverStore,
        resolver,
        undefined,
        pragmaHome,
      ).stop(flow, { executionId: original.executionId });
      const rejectedTakeover = expect(takeover).rejects.toMatchObject({
        code: "FLOW_NATIVE_STOP_UNCONFIRMED",
      });
      await vi.waitFor(() => expect(close.mock.calls.length).toBeGreaterThan(closes));
      const beforeTakeover = (await takeoverStore.get(original.executionId))!;
      await takeoverStore.commit({
        commitId: "successor-owner",
        executionId: original.executionId,
        expectedVersion: beforeTakeover.version,
        executionPatch: {
          state: {
            ...beforeTakeover.state,
            __recoveryClaim: {
              claimId: "successor",
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            },
          },
        },
      });
      releaseStop();
      await rejectedTakeover;
      expect((await takeoverStore.get(original.executionId))?.status).toBe(status);
      expect(
        (await takeoverStore.get(original.executionId))?.state["__recoveryClaim"],
      ).toMatchObject({ claimId: "successor" });
      waitForStop = undefined;
      const casStore = await copyColdExecution(cold, original.executionId);
      const originalCommit = casStore.commit.bind(casStore);
      let changeOwnerBeforeCancelCommit = true;
      vi.spyOn(casStore, "commit").mockImplementation(async (request) => {
        if (request.executionPatch?.status === "cancelled" && changeOwnerBeforeCancelCommit) {
          changeOwnerBeforeCancelCommit = false;
          const current = (await casStore.get(original.executionId))!;
          await originalCommit({
            commitId: "CAS-successor",
            executionId: original.executionId,
            expectedVersion: current.version,
            executionPatch: {
              state: {
                ...current.state,
                __recoveryClaim: {
                  claimId: "CAS-successor",
                  expiresAt: new Date(Date.now() + 30_000).toISOString(),
                },
              },
            },
          });
        }
        return await originalCommit(request);
      });
      await expect(
        new FlowExecutionManager(casStore, resolver, undefined, pragmaHome).stop(flow, {
          executionId: original.executionId,
        }),
      ).rejects.toMatchObject({ code: "FLOW_NATIVE_STOP_UNCONFIRMED" });
      expect((await casStore.get(original.executionId))?.status).toBe(status);
      expect((await casStore.get(original.executionId))?.state["__recoveryClaim"]).toMatchObject({
        claimId: "CAS-successor",
      });
      const closedContextStore = await copyColdExecution(cold, original.executionId);
      await closedContextStore.commit({
        commitId: "context-lifecycle-only",
        executionId: original.executionId,
        contextPatches: [
          {
            contextId: snapshot.contextId,
            patch: { lifecycle: "closed", closedAt: new Date().toISOString() },
          },
        ],
      });
      const beforeClosedRestore = restore.mock.calls.length;
      await new FlowExecutionManager(closedContextStore, resolver, undefined, pragmaHome).stop(
        flow,
        {
          executionId: original.executionId,
        },
      );
      expect(restore).toHaveBeenCalledTimes(beforeClosedRestore + 1);
      const commits = vi.spyOn(cold, "commit");
      await manager.stop(flow, { executionId: original.executionId });
      const cancellations = commits.mock.calls.filter(
        ([request]) => request.executionPatch?.status === "cancelled",
      );
      expect(cancellations).toHaveLength(1);
      expect(cancellations[0]?.[0]).toMatchObject({
        invocationPatches: expect.arrayContaining([
          {
            invocationId: original.executionId,
            patch: expect.objectContaining({ status: "cancelled" }),
          },
        ]),
        contextPatches: expect.arrayContaining([
          {
            contextId: snapshot.contextId,
            patch: expect.objectContaining({ lifecycle: "closed" }),
          },
        ]),
      });
      const restores = restore.mock.calls.length;
      await manager.stop(flow, { executionId: original.executionId });
      expect(restore).toHaveBeenCalledTimes(restores);
      expect(start).toHaveBeenCalledOnce();
      expect((await cold.get(original.executionId))?.status).toBe("cancelled");
      expect((await cold.getInvocation(original.executionId, original.executionId))?.status).toBe(
        "cancelled",
      );
      expect((await cold.listContexts(original.executionId))[0]?.lifecycle).toBe("closed");
    },
  );
});
