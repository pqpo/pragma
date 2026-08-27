import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExecutorDescriptor,
  HumanInteractionRequestEnvelope,
} from "@pragma/shared/integration";
import { describe, expect, it, vi } from "vitest";

import {
  createControllerRunMissionPort,
  createLocalHostRunApplication,
  createMissionControllerStore,
  hashCanonicalRunPayload,
  type LocalHostRunHandle,
  type LocalHostRunRequest,
  type LocalHostRunTerminal,
  type LocalHostRunExecutorPort,
} from "../src/index.ts";

const descriptor: ExecutorDescriptor = {
  schemaVersion: "pragma.integration-executor/v1",
  ref: { kind: "expert", id: "0123456789abcdef" },
  name: "Fixture Expert",
  description: "Fixture",
  source: "project",
  project: {
    projectId: "0123456789abcdef",
    revision: 1,
    fingerprint: "a".repeat(64),
  },
  availability: { status: "ready", blockingCodes: [] },
  workspace: { required: true, allowNonGitDirectory: true },
  capabilities: { interactive: true, resumable: true, steerable: false, supportsQueue: false },
};

describe("Local Host run application", () => {
  it("attaches a Desktop Mission ID and shares the normal run sequence", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-local-run-attached-"));
    try {
      const missionId = "33333333-3333-4333-8333-333333333333";
      const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
      let started = 0;
      const application = createLocalHostRunApplication({
        executors: fakeExecutorPort({ onStart: () => (started += 1) }),
        mission: createControllerRunMissionPort(controller),
      });

      const first = await application.startAttached({ missionId, request: request() });
      await expect(first.outcome).resolves.toMatchObject({
        status: "succeeded",
        missionId,
        executionId: "execution-1",
      });
      expect(first.missionId).toBe(missionId);
      expect(started).toBe(1);

      const snapshot = await controller.readSnapshot({ missionId });
      expect(snapshot.events.map((event) => event.type)).toEqual([
        "mission.created",
        "mission.binding.pinned",
        "run.accepted",
        "run.started",
        "run.progress",
        "run.succeeded",
      ]);
      await expect(
        controller.readRunRequest({ requestId: request().requestId }),
      ).resolves.toMatchObject({ missionId });

      const retry = await application.startAttached({ missionId, request: request() });
      await expect(retry.outcome).resolves.toMatchObject({
        status: "succeeded",
        missionId,
        executionId: "execution-1",
      });
      expect(started).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("revalidates the Host identity after claiming before writing anchors", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-local-run-attach-fence-"));
    try {
      const missionId = "33333333-3333-4333-8333-333333333334";
      const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
      let observedLease = false;
      let started = 0;
      const baseExecutors = fakeExecutorPort({ onStart: () => (started += 1) });
      const application = createLocalHostRunApplication({
        executors: {
          ...baseExecutors,
          assertStartAllowed: async ({ missionId: claimedMissionId }) => {
            const snapshot = await controller.readSnapshot({ missionId: claimedMissionId });
            observedLease = snapshot.snapshot.lease !== undefined;
            throw new Error("Desktop Mission changed after Local Host claim.");
          },
        },
        mission: createControllerRunMissionPort(controller),
      });

      await expect(application.startAttached({ missionId, request: request() })).rejects.toThrow(
        "Desktop Mission changed after Local Host claim.",
      );
      expect(observedLease).toBe(true);
      expect(started).toBe(0);
      await expect(controller.readSnapshot({ missionId })).resolves.toMatchObject({ events: [] });
      await expect(
        controller.readRunRequest({ requestId: request().requestId }),
      ).resolves.toMatchObject({ missionId });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("validates and pins the executor before reserving a Mission", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-local-run-pin-"));
    try {
      let started = 0;
      const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
      const executors = fakeExecutorPort({
        onStart: () => {
          started += 1;
        },
      });
      const application = createLocalHostRunApplication({
        executors,
        mission: createControllerRunMissionPort(controller),
      });
      await expect(
        application.start(request({ expectedFingerprint: "b".repeat(64) })),
      ).rejects.toMatchObject({ code: "EXECUTOR_NOT_FOUND" });
      expect(started).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects an unavailable executor before creating Mission state", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-local-run-unavailable-"));
    try {
      let started = 0;
      const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
      const application = createLocalHostRunApplication({
        executors: fakeExecutorPort({
          onStart: () => {
            started += 1;
          },
          descriptor: {
            ...descriptor,
            availability: { status: "unavailable", blockingCodes: ["RUNTIME_UNAVAILABLE"] },
          },
        }),
        mission: createControllerRunMissionPort(controller),
      });
      await expect(application.start(request())).rejects.toMatchObject({
        code: "RUNTIME_UNAVAILABLE",
      });
      expect(started).toBe(0);
      await expect(
        access(join(home, "missions", ".local-host", "run-request-registry.json")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects an expected fingerprint for a built-in executor as a usage error", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-local-run-built-in-pin-"));
    try {
      const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
      const application = createLocalHostRunApplication({
        executors: fakeExecutorPort({
          descriptor: { ...descriptor, source: "built_in", project: undefined },
        }),
        mission: createControllerRunMissionPort(controller),
      });
      await expect(
        application.start(request({ project: undefined, expectedFingerprint: "a".repeat(64) })),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps an existing unpinned Mission closed until explicit backfill", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-local-run-unpinned-owner-"));
    try {
      const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
      const historicalRequest = request();
      const payloadHash = hashCanonicalRunPayload({
        command: historicalRequest.command,
        executor: descriptor.ref,
        project: descriptor.project!,
        workspace: historicalRequest.workspace,
        prompt: historicalRequest.prompt,
      });
      const reservation = await controller.reserveRunRequest({
        requestId: historicalRequest.requestId,
        payloadHash,
      });
      const guard = await controller.claim({
        missionId: reservation.missionId,
        claimId: "44444444-4444-4444-8444-444444444444",
        leaseMs: 10_000,
      });
      await controller.write({
        missionId: reservation.missionId,
        guard,
        operation: async ({ appendEvent }) => {
          await appendEvent("mission.created", {
            requestId: historicalRequest.requestId,
            payloadHash,
            executor: historicalRequest.executor,
            workspace: historicalRequest.workspace.canonicalPath,
          });
          await appendEvent("run.accepted", {
            requestId: historicalRequest.requestId,
            payloadHash,
          });
        },
      });
      await controller.release({ missionId: reservation.missionId, guard });

      const resolve = vi.fn(async () => ({ descriptor }));
      const application = createLocalHostRunApplication({
        executors: {
          resolve,
          start: async () => {
            throw new Error("old unpinned Mission must not start Core");
          },
        },
        mission: createControllerRunMissionPort(controller),
      });

      await expect(application.start(historicalRequest)).rejects.toMatchObject({
        code: "STORAGE_VERSION_UNSUPPORTED",
        details: {
          reason: "mission_pinned_binding_required",
          missionId: reservation.missionId,
        },
      });
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("lets the original run retry fill the pin after a created-before-pin crash gap", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-local-run-pin-retry-"));
    try {
      const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
      const mission = createControllerRunMissionPort(controller);
      let failPin = true;
      const application = createLocalHostRunApplication({
        executors: fakeExecutorPort(),
        mission: {
          ...mission,
          ensurePinnedBinding: async (input) => {
            if (failPin) {
              failPin = false;
              throw new Error("simulated crash between mission.created and pin");
            }
            return await mission.ensurePinnedBinding(input);
          },
        },
      });

      await expect(application.start(request())).rejects.toThrow(
        "simulated crash between mission.created and pin",
      );
      const firstSnapshot = await controller.readSnapshot({
        missionId: (await controller.readRunRequest({ requestId: request().requestId }))!.missionId,
      });
      expect(firstSnapshot.events.map((event) => event.type)).toEqual(["mission.created"]);

      const retry = await application.start(request());
      await expect(retry.outcome).resolves.toMatchObject({ status: "succeeded" });
      const finalSnapshot = await controller.readSnapshot({ missionId: retry.missionId });
      expect(
        finalSnapshot.events.filter((event) => event.type === "mission.binding.pinned"),
      ).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("renews the CLI owner and consumes the durable Mission Inbox", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-local-run-owner-scope-"));
    let resolveTerminal!: (terminal: LocalHostRunTerminal) => void;
    const release = vi.fn(async () => undefined);
    try {
      const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
      const terminal = new Promise<LocalHostRunTerminal>((resolve) => {
        resolveTerminal = resolve;
      });
      const apply = vi.fn(async () => ({ result: { consumed: true } }));
      const application = createLocalHostRunApplication({
        executors: {
          resolve: async () => ({ descriptor }),
          start: async () => ({
            executionId: "55555555-5555-4555-8555-555555555555",
            result: terminal,
            release,
          }),
        },
        mission: createControllerRunMissionPort(controller, { leaseMs: 500 }),
        commandConsumer: { apply },
      });

      const handle = await application.start(request());
      const beforeRenewal = await controller.readSnapshot({ missionId: handle.missionId });
      await new Promise<void>((resolve) => setTimeout(resolve, 700));
      const afterRenewal = await controller.readSnapshot({ missionId: handle.missionId });
      expect(afterRenewal.snapshot.lease?.renewedAt).not.toBe(
        beforeRenewal.snapshot.lease?.renewedAt,
      );
      expect(afterRenewal.snapshot.lease?.expiresAt).not.toBe(
        beforeRenewal.snapshot.lease?.expiresAt,
      );

      await controller.appendCommand({
        missionId: handle.missionId,
        kind: "send",
        request: {
          schemaVersion: "pragma.integration-request/v1",
          requestId: "66666666-6666-4666-8666-666666666666",
          payloadHash: `sha256:${"d".repeat(64)}`,
          requestedAt: "2026-08-27T00:00:00.000Z",
          client: {
            surface: "cli",
            version: "test",
            instanceId: "77777777-7777-4777-8777-777777777777",
          },
        },
        payload: { kind: "send", input: { prompt: "continue" } },
      });
      await vi.waitFor(
        async () => {
          expect(apply).toHaveBeenCalledTimes(1);
          await expect(
            controller.getOperation({
              missionId: handle.missionId,
              requestId: "66666666-6666-4666-8666-666666666666",
            }),
          ).resolves.toMatchObject({ state: "applied" });
        },
        { timeout: 3_000, interval: 20 },
      );

      resolveTerminal({
        status: "succeeded",
        executionId: "55555555-5555-4555-8555-555555555555",
        result: { done: true },
      });
      await expect(handle.outcome).resolves.toMatchObject({ status: "succeeded" });
      expect(release).toHaveBeenCalledTimes(1);
      const finalSnapshot = await controller.readSnapshot({ missionId: handle.missionId });
      expect(finalSnapshot.snapshot.lease).toBeUndefined();
    } finally {
      resolveTerminal?.({
        status: "interrupted",
        executionId: "55555555-5555-4555-8555-555555555555",
      });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("projects a successful lower-level run and releases the Mission lease", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-local-run-success-"));
    try {
      const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
      const projectedEvents: Array<{
        readonly type: string;
        readonly replayable?: boolean | undefined;
        readonly cursor?: string | undefined;
      }> = [];
      const application = createLocalHostRunApplication({
        executors: fakeExecutorPort(),
        mission: createControllerRunMissionPort(controller),
      });
      const handle = await application.start(request(), {
        onEvent: (event) => projectedEvents.push(event),
      });
      const outcome = await handle.outcome;
      expect(outcome).toMatchObject({ status: "succeeded", result: { answer: 42 } });
      const snapshot = await controller.readSnapshot({ missionId: handle.missionId });
      expect(snapshot.events.map((event) => event.type)).toEqual([
        "mission.created",
        "mission.binding.pinned",
        "run.accepted",
        "run.started",
        "run.progress",
        "run.succeeded",
      ]);
      const progress = projectedEvents.find((event) => event.type === "run.progress");
      expect(progress).toMatchObject({ replayable: true });
      expect(progress?.cursor).toBeDefined();
      expect(progress?.cursor).not.toBe("1");
      await expect(
        controller.readSnapshot({ missionId: handle.missionId, after: progress?.cursor }),
      ).resolves.toMatchObject({ events: [{ type: "run.succeeded" }] });
      expect(snapshot.snapshot.lease).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("projects the durable terminal result for a serial idempotent retry", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-local-run-retry-"));
    try {
      let started = 0;
      const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
      const application = createLocalHostRunApplication({
        executors: fakeExecutorPort({ onStart: () => (started += 1) }),
        mission: createControllerRunMissionPort(controller),
      });
      const first = await application.start(request());
      await first.outcome;
      const second = await application.start(request());
      await expect(second.outcome).resolves.toMatchObject({
        status: "succeeded",
        missionId: first.missionId,
        executionId: "execution-1",
        result: { answer: 42 },
      });
      expect(started).toBe(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects an idempotency retry with a different semantic payload", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-local-run-conflict-"));
    try {
      const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
      const application = createLocalHostRunApplication({
        executors: fakeExecutorPort(),
        mission: createControllerRunMissionPort(controller),
      });
      await (
        await application.start(request())
      ).outcome;
      await expect(application.start(request({ prompt: "different" }))).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("turns a non-interactive human request into a durable input_required outcome", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-local-run-human-"));
    try {
      const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
      const release = vi.fn(async () => undefined);
      const application = createLocalHostRunApplication({
        executors: humanExecutorPort(release),
        mission: createControllerRunMissionPort(controller),
      });
      const handle = await application.start(request(), {
        onHumanInteraction: async () => ({ kind: "checkpoint" as const }),
      });
      await expect(handle.outcome).resolves.toMatchObject({
        status: "input_required",
        interaction: { interactionId: "interaction-1" },
      });
      const snapshot = await controller.readSnapshot({ missionId: handle.missionId });
      expect(snapshot.events.at(-1)?.type).toBe("run.input_required");
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each(["failed", "interrupted"] as const)(
    "releases lower-level resources for a %s terminal outcome",
    async (status) => {
      const home = await mkdtemp(join(tmpdir(), `pragma-local-run-${status}-`));
      try {
        const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
        const release = vi.fn(async () => undefined);
        const application = createLocalHostRunApplication({
          executors: terminalExecutorPort(status, release),
          mission: createControllerRunMissionPort(controller),
        });
        const handle = await application.start(request());

        await expect(handle.outcome).resolves.toMatchObject({ status });
        expect(release).toHaveBeenCalledTimes(1);
        const snapshot = await controller.readSnapshot({ missionId: handle.missionId });
        expect(snapshot.snapshot.lease).toBeUndefined();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});

function request(overrides: Partial<LocalHostRunRequest> = {}): LocalHostRunRequest {
  return {
    requestId: "11111111-1111-4111-8111-111111111111",
    command: "expert.run",
    executor: { kind: "expert", id: "0123456789abcdef" },
    workspace: {
      schemaVersion: "pragma.integration-workspace/v1",
      requestedPath: "/workspace",
      canonicalPath: "/workspace",
      displayName: "workspace",
      identityHash: `sha256:${"c".repeat(64)}`,
      access: { exists: true, readable: true, writable: true },
      source: "explicit",
    },
    prompt: "hello",
    project: { projectId: "0123456789abcdef", revision: 1 },
    detach: false,
    ...overrides,
  };
}

function fakeExecutorPort(
  options: {
    readonly onStart?: () => void;
    readonly descriptor?: ExecutorDescriptor;
  } = {},
): LocalHostRunExecutorPort {
  return {
    resolve: async () => ({ descriptor: options.descriptor ?? descriptor }),
    start: async ({ onEvent }) => {
      options.onStart?.();
      onEvent?.({
        type: "run.progress",
        data: { value: "started" },
        replayable: true,
        cursor: "1",
      });
      return {
        executionId: "execution-1",
        events: [],
        result: Promise.resolve({
          status: "succeeded",
          executionId: "execution-1",
          result: { answer: 42 },
        }),
      } satisfies LocalHostRunHandle;
    },
  };
}

function humanExecutorPort(release: () => Promise<void>): LocalHostRunExecutorPort {
  return {
    resolve: async () => ({ descriptor }),
    start: async ({ missionId, onEvent }) => {
      const envelope: HumanInteractionRequestEnvelope = {
        schemaVersion: "pragma.human-interaction/v1",
        kind: "request",
        missionId,
        executionId: "22222222-2222-4222-8222-222222222222",
        interactionId: "interaction-1",
        sensitive: false,
        interaction: {
          kind: "question",
          title: "Continue",
          questions: [{ header: "Answer", question: "Continue?", kind: "text", options: [] }],
        },
      };
      onEvent?.({
        type: "human.interaction.requested",
        data: envelope,
        replayable: true,
        cursor: "1",
      });
      let resolveResult!: (terminal: LocalHostRunTerminal) => void;
      const result = new Promise<LocalHostRunTerminal>((resolve) => {
        resolveResult = resolve;
      });
      return {
        executionId: "22222222-2222-4222-8222-222222222222",
        result,
        release,
        checkpointWaitingHuman: async () =>
          resolveResult({
            status: "input_required",
            executionId: "execution-human",
            interaction: envelope,
          }),
      } satisfies LocalHostRunHandle;
    },
  };
}

function terminalExecutorPort(
  status: "failed" | "interrupted",
  release: () => Promise<void>,
): LocalHostRunExecutorPort {
  return {
    resolve: async () => ({ descriptor }),
    start: async () => ({
      executionId: "33333333-3333-4333-8333-333333333333",
      result: Promise.resolve({
        status,
        executionId: "33333333-3333-4333-8333-333333333333",
        ...(status === "failed"
          ? {
              error: {
                schemaVersion: "pragma.integration-error/v1" as const,
                code: "EXECUTION_FAILED" as const,
                category: "execution" as const,
                message: "fixture failure",
                retryable: false,
              },
            }
          : {}),
      }),
      release,
    }),
  };
}
