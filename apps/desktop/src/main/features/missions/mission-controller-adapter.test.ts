import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFileExecutionStore,
  createFileExpertSessionStore,
  createRuntimeSessionRecord,
  PragmaPaths,
} from "@pragma/core";
import { createMissionControllerStore } from "@pragma/local-host";
import {
  PRAGMA_DSL_WRITE_API_VERSION,
  type PragmaExpertResource,
  type PragmaFlowResource,
} from "@pragma/interpreter/ast";
import { createIntegrationError } from "@pragma/shared/integration";
import { afterEach, describe, expect, it, vi } from "vitest";

import { missionExecutorSnapshot } from "../../../shared/contracts/index.ts";
import {
  createDesktopMissionController,
  createDesktopMissionCommandConsumer,
  createGuardedMissionStore,
} from "./mission-controller-adapter.ts";
import { createMissionStore, type MissionStore } from "./mission-store.ts";
import { createMissionRunner } from "./mission-runner.ts";
import { createPragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { CapabilityCredentialStore } from "../capabilities/capability-credential-store.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";

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

describe("Desktop Mission controller composition", () => {
  it("fences a real Desktop MissionStore semantic write and releases only after lower-level settlement", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-mission-control-"));
    roots.push(root);
    const missionsPath = join(root, "missions");
    const rawStore = createMissionStore({ missionsPath });
    const mission = await rawStore.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Guard this Mission",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const controllerStore = createMissionControllerStore({ missionsPath });
    const first = createDesktopMissionController({ controller: controllerStore, leaseMs: 1_000 });
    const guardedStore = createGuardedMissionStore(rawStore, first);

    await first.acquire(mission.id);
    await guardedStore.updateOptions(mission.id, { toolPermissionMode: "full-access" });
    await expect(rawStore.get(mission.id)).resolves.toMatchObject({
      toolPermissionMode: "full-access",
    });
    await expect(controllerStore.readSnapshot({ missionId: mission.id })).resolves.toMatchObject({
      events: [expect.objectContaining({ type: "mission.options.updated" })],
    });

    const order: string[] = [];
    await first.releaseAfterLowerLevel(mission.id, async () => {
      order.push("lower-level-settled");
    });
    order.push("mission-released");
    expect(order).toEqual(["lower-level-settled", "mission-released"]);

    const second = createDesktopMissionController({ controller: controllerStore, leaseMs: 1_000 });
    await second.acquire(mission.id);
    await expect(
      guardedStore.updateOptions(mission.id, { toolPermissionMode: "request-approval" }),
    ).rejects.toMatchObject({ code: "MISSION_LEASE_HELD" });
  });

  it("rejects a human response after lease loss without reclaiming or restarting a controller", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-lost-lease-respond-"));
    roots.push(root);
    const missionsPath = join(root, "missions");
    const missionId = "00000000-0000-4000-8000-000000000081";
    const controllerStore = createMissionControllerStore({ missionsPath });
    const controller = createDesktopMissionController({ controller: controllerStore, leaseMs: 1_000 });
    const acquire = vi.spyOn(controller, "acquire");
    const runner = createMissionRunner({
      missions: createMissionStore({ missionsPath }),
      project: createPragmaProjectStore({ projectsPath: join(root, "projects") }),
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "state"),
      runtimes: {} as never,
      missionController: controller,
    });

    await runner.stopLocalController(missionId);
    await expect(
      runner.respondToHumanInteraction({
        missionId,
        interactionId: "00000000-0000-4000-8000-000000000082",
        requestId: "00000000-0000-4000-8000-000000000083",
        response: { answers: {} },
      }),
    ).rejects.toMatchObject({ code: "MISSION_FENCING_REJECTED" });
    expect(acquire).not.toHaveBeenCalled();
    const snapshot = await controllerStore.readSnapshot({ missionId });
    expect(snapshot.snapshot.lease).toBeUndefined();
    expect(snapshot.events).toEqual([]);
  });

  it("polls all seven Inbox command kinds through the Desktop consumer and never falls back for rejected strict steer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-command-consumer-"));
    roots.push(root);
    const missionsPath = join(root, "missions");
    const missionId = "00000000-0000-4000-8000-000000000101";
    const store = createMissionControllerStore({ missionsPath });
    const controller = createDesktopMissionController({ controller: store, leaseMs: 1_000 });
    const calls: string[] = [];
    const consumer = createDesktopMissionCommandConsumer({
      commands: {
        send: async (input) => {
          calls.push(`${input.mode}:${input.prompt}`);
          return { missionId: input.missionId };
        },
        respond: async (input) => {
          calls.push(`respond:${input.interactionId}`);
          return { missionId: input.missionId, interactionId: input.interactionId };
        },
        interrupt: async (input) => {
          calls.push(`interrupt:${input.reason ?? ""}`);
          return { missionId: input.missionId };
        },
        removeQueued: async (input) => {
          calls.push(`remove:${input.requestId}`);
          return { missionId: input.missionId };
        },
        resumeQueue: async (input) => {
          calls.push("resume");
          return { missionId: input.missionId };
        },
        steerQueued: async (input) => {
          calls.push(`queue-steer:${input.requestId}`);
          return { missionId: input.missionId };
        },
      },
      validateStrictTarget: async ({ executionId, turnId }) => {
        calls.push(`validate:${executionId}:${turnId}`);
      },
    });
    const guard = await controller.acquire(missionId);
    const queuedRequestId = "00000000-0000-4000-8000-000000000109";
    const commands = [
      command(missionId, "send", 1),
      command(
        missionId,
        "steer",
        2,
        { executionId: "00000000-0000-4000-8000-000000000102", turnId: "turn-1" },
        guard.fencingToken,
      ),
      command(missionId, "respond", 3, { interactionId: "interaction-1" }),
      command(missionId, "interrupt", 4),
      command(missionId, "queue.remove", 5, undefined, undefined, queuedRequestId),
      command(missionId, "queue.resume", 6),
      command(
        missionId,
        "queue.steer",
        7,
        { executionId: "00000000-0000-4000-8000-000000000102", turnId: "turn-1" },
        guard.fencingToken,
        queuedRequestId,
      ),
    ];
    for (const input of commands) await store.appendCommand(input);

    const poller = await controller.startPolling({
      missionId,
      consumer,
      initialDelayMs: 1,
      maxDelayMs: 5,
      jitter: () => 0,
    });
    await vi.waitFor(
      async () => {
        const operations = await store.listOperations({ missionId });
        expect(operations).toHaveLength(7);
        expect(operations.map((operation) => operation.state)).toEqual([
          "applied",
          "applied",
          "applied",
          "applied",
          "applied",
          "applied",
          "applied",
        ]);
      },
      { timeout: 10_000, interval: 10 },
    );
    await poller.stop();
    expect(calls).toEqual([
      "enqueue:prompt-1",
      "validate:00000000-0000-4000-8000-000000000102:turn-1",
      "steer:prompt-2",
      "respond:interaction-1",
      "interrupt:user-request",
      `remove:${queuedRequestId}`,
      "resume",
      "validate:00000000-0000-4000-8000-000000000102:turn-1",
      `queue-steer:${queuedRequestId}`,
    ]);

    const strictChanged = command(
      missionId,
      "steer",
      8,
      { executionId: "00000000-0000-4000-8000-000000000102", turnId: "turn-2" },
      undefined,
    );
    await store.renew({ missionId, guard, leaseMs: 1_000 });
    const expired = { ...command(missionId, "send", 9), expiresAt: "2020-01-01T00:00:00.000Z" };
    await store.appendCommand(strictChanged);
    await store.appendCommand(expired);
    const rejectingConsumer = createDesktopMissionCommandConsumer({
      commands: consumerCommands(calls),
      validateStrictTarget: async () => {
        throw createIntegrationError({
          code: "STEER_TARGET_CHANGED",
          category: "conflict",
          message: "The live canonical turn changed.",
        });
      },
    });
    await store.processNext({ missionId, guard, consumer: rejectingConsumer });
    await store.processNext({ missionId, guard, consumer });
    await expect(
      store.getOperation({ missionId, requestId: strictChanged.request.requestId }),
    ).resolves.toMatchObject({
      state: "rejected",
      error: { code: "STEER_TARGET_CHANGED" },
    });
    await expect(
      store.getOperation({ missionId, requestId: expired.request.requestId }),
    ).resolves.toMatchObject({
      state: "expired",
      error: { code: "COMMAND_EXPIRED" },
    });
    expect(calls).not.toContain("steer:prompt-8");
  });

  it("uses the real MissionRunner strict target validator for every reject and accept branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-strict-target-"));
    roots.push(root);
    const missionsPath = join(root, "missions");
    const missions = createMissionStore({ missionsPath });
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const expertMission = await missions.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Validate strict target",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const flowMission = await missions.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Flow has no strict target",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(flowFixture()),
      flowInput: {},
    });
    const runner = createMissionRunner({
      missions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "state"),
      runtimes: {} as never,
    });
    const controllerStore = createMissionControllerStore({ missionsPath });
    const controller = createDesktopMissionController({
      controller: controllerStore,
      leaseMs: 10_000,
    });
    const handled = vi.fn(async () => ({ handled: true }));
    const consumer = createDesktopMissionCommandConsumer({
      commands: {
        send: async () => await handled(),
        respond: async () => ({}),
        interrupt: async () => ({}),
        removeQueued: async () => ({}),
        resumeQueue: async () => ({}),
        steerQueued: async () => ({}),
      },
      validateStrictTarget: async (input) => {
        const current = await runner.getCanonicalStrictTarget(input.missionId);
        if (current === undefined) {
          throw createIntegrationError({
            code: "STEER_TARGET_NOT_ACTIVE",
            category: "conflict",
            message: "Mission has no active Expert or Team turn for strict steer.",
          });
        }
        if (current.executionId !== input.executionId || current.turnId !== input.turnId) {
          throw createIntegrationError({
            code: "STEER_TARGET_CHANGED",
            category: "conflict",
            message: "Strict Mission steer target changed before command apply.",
          });
        }
      },
    });
    const expertGuard = await controller.acquire(expertMission.id);
    const flowGuard = await controller.acquire(flowMission.id);
    const apply = async (
      id: string,
      guard: { readonly claimId: string; readonly fencingToken: string },
      sequence: number,
      target: { readonly executionId: string; readonly turnId: string },
    ) => {
      const input = command(id, "steer", sequence, target, guard.fencingToken);
      await controllerStore.appendCommand(input);
      await controllerStore.processNext({ missionId: id, guard, consumer });
      return await controllerStore.getOperation({
        missionId: id,
        requestId: input.request.requestId,
      });
    };

    const noActive = await apply(expertMission.id, expertGuard, 20, {
      executionId: "00000000-0000-4000-8000-000000000401",
      turnId: expertMission.initialMessageId,
    });
    expect(noActive).toMatchObject({
      state: "rejected",
      error: { code: "STEER_TARGET_NOT_ACTIVE" },
    });

    await missions.updateExecution(expertMission.id, {
      id: "00000000-0000-4000-8000-000000000402",
      inputMessageId: expertMission.initialMessageId,
      status: "running",
      startedAt: "2026-08-24T00:00:00.000Z",
    });
    const executionChanged = await apply(expertMission.id, expertGuard, 21, {
      executionId: "00000000-0000-4000-8000-000000000403",
      turnId: expertMission.initialMessageId,
    });
    expect(executionChanged).toMatchObject({
      state: "rejected",
      error: { code: "STEER_TARGET_CHANGED" },
    });
    const turnChanged = await apply(expertMission.id, expertGuard, 22, {
      executionId: "00000000-0000-4000-8000-000000000402",
      turnId: "00000000-0000-4000-8000-000000000404",
    });
    expect(turnChanged).toMatchObject({
      state: "rejected",
      error: { code: "STEER_TARGET_CHANGED" },
    });
    const accepted = await apply(expertMission.id, expertGuard, 23, {
      executionId: "00000000-0000-4000-8000-000000000402",
      turnId: expertMission.initialMessageId,
    });
    expect(accepted).toMatchObject({ state: "applied" });

    await missions.updateExecution(flowMission.id, {
      id: "00000000-0000-4000-8000-000000000405",
      inputMessageId: flowMission.initialMessageId,
      status: "running",
      startedAt: "2026-08-24T00:00:00.000Z",
    });
    const flow = await apply(flowMission.id, flowGuard, 24, {
      executionId: "00000000-0000-4000-8000-000000000405",
      turnId: flowMission.initialMessageId,
    });
    expect(flow).toMatchObject({ state: "rejected", error: { code: "STEER_TARGET_NOT_ACTIVE" } });
    for (const [index, status] of (["succeeded", "failed", "cancelled"] as const).entries()) {
      await missions.updateExecution(expertMission.id, {
        id: "00000000-0000-4000-8000-000000000402",
        inputMessageId: expertMission.initialMessageId,
        status,
        startedAt: "2026-08-24T00:00:00.000Z",
      });
      const terminal = await apply(expertMission.id, expertGuard, 25 + index, {
        executionId: "00000000-0000-4000-8000-000000000402",
        turnId: expertMission.initialMessageId,
      });
      expect(terminal).toMatchObject({
        state: "rejected",
        error: { code: "STEER_TARGET_NOT_ACTIVE" },
      });
    }
    const interruptedRunner = createMissionRunner({
      missions: {
        ...missions,
        get: async (id) => {
          const mission = await missions.get(id);
          if (id !== expertMission.id || mission.execution === undefined) return mission;
          return {
            ...mission,
            execution: { ...mission.execution, status: "interrupted" as never },
          };
        },
      } as MissionStore,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "state"),
      runtimes: {} as never,
    });
    const interruptedConsumer = createDesktopMissionCommandConsumer({
      commands: {
        send: async () => await handled(),
        respond: async () => ({}),
        interrupt: async () => ({}),
        removeQueued: async () => ({}),
        resumeQueue: async () => ({}),
        steerQueued: async () => ({}),
      },
      validateStrictTarget: async (input) => {
        const current = await interruptedRunner.getCanonicalStrictTarget(input.missionId);
        if (current === undefined) {
          throw createIntegrationError({
            code: "STEER_TARGET_NOT_ACTIVE",
            category: "conflict",
            message: "Mission has no active Expert or Team turn for strict steer.",
          });
        }
      },
    });
    const interruptedInput = command(expertMission.id, "steer", 28, {
      executionId: "00000000-0000-4000-8000-000000000402",
      turnId: expertMission.initialMessageId,
    }, expertGuard.fencingToken);
    await controllerStore.appendCommand(interruptedInput);
    await controllerStore.processNext({
      missionId: expertMission.id,
      guard: expertGuard,
      consumer: interruptedConsumer,
    });
    await expect(
      controllerStore.getOperation({ missionId: expertMission.id, requestId: interruptedInput.request.requestId }),
    ).resolves.toMatchObject({ state: "rejected", error: { code: "STEER_TARGET_NOT_ACTIVE" } });
    expect(handled).toHaveBeenCalledOnce();
  });

  it.each([
    "semantic-write.prepare",
    "semantic-write.mutation-commit",
    "semantic-write.event-append",
    "semantic-write.state-sequence",
    "semantic-write.clear",
  ] as const)("replays a guarded Mission mutation and its event after %s", async (crashPoint) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-semantic-write-"));
    roots.push(root);
    const missionsPath = join(root, "missions");
    const rawStore = createMissionStore({ missionsPath });
    const mission = await rawStore.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Recover semantic write",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    let now = Date.parse("2026-08-24T00:00:00.000Z");
    let interrupted = false;
    const clock = { now: () => new Date(now) };
    const interruptedStore = createMissionControllerStore({
      missionsPath,
      clock,
      onJournalPhase: (phase) => {
        if (!interrupted && phase === crashPoint) {
          interrupted = true;
          throw new Error(`simulated crash at ${phase}`);
        }
      },
    });
    const first = createDesktopMissionController({ controller: interruptedStore, leaseMs: 10 });
    const guarded = createGuardedMissionStore(rawStore, first);
    await expect(
      guarded.updateOptions(mission.id, { toolPermissionMode: "full-access" }),
    ).rejects.toThrow(`simulated crash at ${crashPoint}`);
    await first.stop(mission.id);

    now += 11;
    const recoveredStore = createMissionControllerStore({ missionsPath, clock });
    const recoveredController = createDesktopMissionController({
      controller: recoveredStore,
      leaseMs: 10,
    });
    createGuardedMissionStore(rawStore, recoveredController);
    await recoveredController.acquire(mission.id);

    await expect(rawStore.get(mission.id)).resolves.toMatchObject({
      toolPermissionMode: "full-access",
    });
    await expect(recoveredStore.readSnapshot({ missionId: mission.id })).resolves.toMatchObject({
      snapshot: { eventSequence: 1 },
      events: [expect.objectContaining({ type: "mission.options.updated" })],
    });
    const snapshot = await recoveredStore.readSnapshot({ missionId: mission.id });
    expect(
      snapshot.events.filter((event) => event.type === "mission.options.updated"),
    ).toHaveLength(1);
    await recoveredController.stop(mission.id);
  });

  it("deduplicates concurrent acquire calls and clears a failed in-flight acquisition", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-controller-acquire-"));
    roots.push(root);
    const missionId = "00000000-0000-4000-8000-000000000302";
    const store = createMissionControllerStore({ missionsPath: join(root, "missions") });
    const claim = vi.spyOn(store, "claim");
    const controller = createDesktopMissionController({ controller: store, leaseMs: 1_000 });
    const [first, second] = await Promise.all([
      controller.acquire(missionId),
      controller.acquire(missionId),
    ]);
    expect(first).toEqual(second);
    expect(claim).toHaveBeenCalledOnce();

    const failedMissionId = "00000000-0000-4000-8000-000000000304";
    claim.mockRejectedValueOnce(new Error("temporary claim failure"));
    await expect(controller.acquire(failedMissionId)).rejects.toThrow("temporary claim failure");
    await expect(controller.acquire(failedMissionId)).resolves.toMatchObject({
      claimId: expect.any(String),
    });
  });

  it("uses terminal deletion without releasing a moved Mission aggregate", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-controller-delete-"));
    roots.push(root);
    const missionsPath = join(root, "missions");
    const missionId = "00000000-0000-4000-8000-000000000303";
    const store = createMissionControllerStore({ missionsPath });
    const controller = createDesktopMissionController({ controller: store, leaseMs: 1_000 });
    const guard = await controller.acquire(missionId);
    await expect(
      controller.terminalDelete(
        missionId,
        async () => await rm(join(missionsPath, missionId), { recursive: true, force: true }),
      ),
    ).resolves.toBeUndefined();
    await expect(store.assertWriteGuard({ missionId, guard })).rejects.toMatchObject({
      code: "MISSION_FENCING_REJECTED",
    });
  });

  it("uses real Core lease, recovery, and Runtime ownership stores without holding the Mission aggregate lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-core-ownership-"));
    roots.push(root);
    const executions = createFileExecutionStore({ pragmaHome: root });
    const sessions = createFileExpertSessionStore({ executions, pragmaHome: root });
    const now = new Date().toISOString();
    await sessions.create({
      schemaVersion: "pragma.expert-session/v5",
      sessionId: "session-1",
      expertId: "expert-1",
      definitionFingerprint: "a".repeat(64),
      status: "open",
      queuedRequestIds: [],
      executionIds: [],
      rootContextId: "root",
      contexts: {
        root: {
          schemaVersion: "pragma.runtime-context/v5",
          contextId: "root",
          owner: { type: "expert-session", ownerId: "session-1" },
          origin: { type: "expert-session", sessionId: "session-1" },
          expert: { id: "expert-1" },
          runtime: { runtimeId: "test", revision: 1, fingerprint: "b".repeat(64) },
          lifecycle: "open",
          createdAt: now,
          updatedAt: now,
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    await expect(sessions.claimLease("session-1", "session-owner-a", 1_000)).resolves.toBe(true);
    await expect(sessions.claimLease("session-1", "session-owner-b", 1_000)).resolves.toBe(false);

    await executions.create(
      {
        schemaVersion: "pragma.execution/v10",
        executionId: "execution-1",
        version: 0,
        kind: "flow",
        definition: { id: "flow-1", kind: "flow" },
        rootInvocationId: "root",
        status: "running",
        input: null,
        state: {},
        lastAppliedSequence: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        invocationId: "root",
        rootInvocationId: "root",
        contextId: "root-context",
        definition: { id: "flow-1", kind: "flow" },
        status: "running",
        pendingExpertMessages: [],
        input: null,
        createdAt: now,
        updatedAt: now,
      },
    );
    await expect(executions.claimRecovery("execution-1", "recovery-a", 1_000)).resolves.toBe(true);
    await expect(executions.claimRecovery("execution-1", "recovery-b", 1_000)).resolves.toBe(false);

    const paths = new PragmaPaths({ pragmaHome: root });
    const runtimeInput = {
      paths,
      owner: { type: "expert-session" as const, ownerId: "session-1", contextId: "root" },
      systemSessionId: "runtime-1",
      agentId: "expert-1",
      runtime: { id: "test", kind: "test", displayName: "Test runtime" },
      workspace: root,
    };
    await createRuntimeSessionRecord(runtimeInput);
    await expect(createRuntimeSessionRecord(runtimeInput)).rejects.toThrow("already owned");

    const missionId = "00000000-0000-4000-8000-000000000301";
    const controllerStore = createMissionControllerStore({ missionsPath: join(root, "missions") });
    const controller = createDesktopMissionController({
      controller: controllerStore,
      leaseMs: 1_000,
    });
    const guard = await controller.acquire(missionId);
    let releaseLowerLevel!: () => void;
    const lowerLevelStarted = new Promise<void>((resolve) => {
      releaseLowerLevel = resolve;
    });
    const release = controller.releaseAfterLowerLevel(missionId, async () => {
      await sessions.releaseLease("session-1", "session-owner-a");
      releaseLowerLevel();
      await new Promise<void>((resolve) => {
        releaseLowerLevel = resolve;
      });
    });
    await lowerLevelStarted;
    await expect(controllerStore.readSnapshot({ missionId })).resolves.toMatchObject({
      snapshot: { lease: expect.any(Object) },
    });
    releaseLowerLevel();
    await release;
    await expect(sessions.claimLease("session-1", "session-owner-b", 1_000)).resolves.toBe(true);
    const successor = await createDesktopMissionController({ controller: controllerStore }).acquire(
      missionId,
    );
    expect(successor.fencingToken).not.toBe(guard.fencingToken);
    await expect(controllerStore.assertWriteGuard({ missionId, guard })).rejects.toMatchObject({
      code: "MISSION_FENCING_REJECTED",
    });
  });
});

function command(
  missionId: string,
  kind:
    "send" | "steer" | "respond" | "interrupt" | "queue.remove" | "queue.resume" | "queue.steer",
  sequence: number,
  target?: {
    readonly executionId?: string;
    readonly turnId?: string;
    readonly interactionId?: string;
  },
  targetFencingToken?: string,
  queuedRequestId?: string,
) {
  const requestId = `00000000-0000-4000-8000-${String(110 + sequence).padStart(12, "0")}`;
  return {
    missionId,
    kind,
    request: {
      schemaVersion: "pragma.integration-request/v1" as const,
      requestId,
      payloadHash: `sha256:${String(sequence).padStart(64, "0")}`,
      requestedAt: "2026-08-24T00:00:00.000Z",
      client: {
        surface: "desktop" as const,
        version: "test",
        instanceId: "00000000-0000-4000-8000-000000000199",
      },
    },
    ...(target === undefined ? {} : { target }),
    ...(targetFencingToken === undefined ? {} : { targetFencingToken }),
    payload:
      kind === "send" || kind === "steer"
        ? { kind, input: { prompt: `prompt-${sequence}` } }
        : kind === "respond"
          ? { kind, response: { decision: "approved" } }
          : kind === "interrupt"
            ? { kind, reason: "user-request" }
            : kind === "queue.remove"
              ? { kind, requestId: queuedRequestId! }
              : kind === "queue.resume"
                ? { kind }
                : { kind, input: { prompt: `prompt-${sequence}` }, requestId: queuedRequestId! },
  };
}

function consumerCommands(calls: string[]) {
  return {
    send: async (input: { readonly prompt: string; readonly mode: "enqueue" | "steer" }) => {
      calls.push(`${input.mode}:${input.prompt}`);
      return {};
    },
    respond: async () => ({}),
    interrupt: async () => ({}),
    removeQueued: async () => ({}),
    resumeQueue: async () => ({}),
    steerQueued: async () => ({}),
  };
}

function expertFixture(): PragmaExpertResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id: "v2vt1v01vzz6j24q",
      avatarId: "pragma.avatar.expert.default",
      name: "Mission controller test expert",
      description: "A test Expert.",
      tags: [],
    },
    spec: {
      scope: "Test.",
      instructions: "Test.",
      runtime: { ref: "runtime-profile:9a20pvstre59317h" },
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}

function flowFixture(): PragmaFlowResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Flow",
    metadata: {
      id: "ffdfk2cczgqjda7q",
      name: "Strict target flow",
      description: "Flow commands cannot use an Expert turn target.",
      tags: [],
    },
    spec: {
      limits: { maxNodeVisits: 1 },
      graph: {
        start: "step",
        steps: {
          step: {
            expert: { ref: "expert:1xddvess309a6gme" },
            prompt: { segments: [{ text: "noop" }] },
          },
        },
        loops: {},
        transitions: { step: { end: true } },
      },
    },
  };
}
