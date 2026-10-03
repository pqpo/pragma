import type {
  ExecutionStore,
  ExpertSession,
  ExpertSessionStore,
  RuntimeResolver,
} from "@pragma/core";
import { SteerNotDispatchedError } from "@pragma/core";
import { MissionCommandSchema, type MissionCommand } from "@pragma/shared/integration";
import { describe, expect, it, vi } from "vitest";
import { createLocalHostCoreMissionControlAdapter, MissionExecutionOwner } from "../src/index.ts";

const missionId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const guard = { claimId: "00000000-0000-4000-8000-000000000003", fencingToken: "1" };
function command(
  kind: MissionCommand["kind"],
  payload: MissionCommand["payload"],
  target?: MissionCommand["target"],
) {
  return MissionCommandSchema.parse({
    schemaVersion: "pragma.mission-command/v2",
    commandId: "00000000-0000-4000-8000-000000000004",
    request: {
      schemaVersion: "pragma.integration-request/v1",
      requestId,
      payloadHash: `sha256:${"a".repeat(64)}`,
      requestedAt: "2026-10-02T00:00:00.000Z",
      client: {
        surface: "desktop",
        version: "test",
        instanceId: "00000000-0000-4000-8000-000000000005",
      },
    },
    missionId,
    kind,
    payload,
    target,
    targetFencingToken: kind === "steer" || kind === "queue.steer" ? "1" : undefined,
    state: "accepted",
    createdAt: "2026-10-02T00:00:00.000Z",
  });
}
function fixture(supportsSteer = true) {
  let activeExecutionId: string | undefined = "10000000-0000-4000-8000-000000000001";
  const prompt = vi.fn(async () => ({ executionId: activeExecutionId, requestId }));
  const abort = vi.fn(async () => undefined);
  const cancelPromptQueue = vi.fn(async () => undefined);
  const abortExecution = vi.fn(async () => undefined);
  const removeQueuedPrompt = vi.fn(async () => undefined);
  const resumePromptQueue = vi.fn(async () => undefined);
  const steerQueuedPrompt = vi.fn(async () => ({ executionId: activeExecutionId, requestId }));
  const attemptQueuedPromptSteer = vi.fn(async () => ({
    outcome: "retained",
    reason: "no_active_turn",
  }));
  const state = () => ({
    activeExecutionId,
    executionIds: ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"],
    rootContextId: "root",
    contexts: { root: { runtime: { runtimeId: "fake" } } },
  });
  const persistedPrompts = vi.fn(async (): Promise<readonly unknown[]> =>
    activeExecutionId === undefined
      ? []
      : [
          {
            executionId: activeExecutionId,
            requestId: "root-turn",
            status: "running",
            mode: "enqueue",
          },
        ],
  );
  const session = {
    prompt,
    abort,
    cancelPromptQueue,
    abortExecution,
    removeQueuedPrompt,
    resumePromptQueue,
    steerQueuedPrompt,
    attemptQueuedPromptSteer,
    getState: async () => state(),
    getPromptQueue: async () => [],
    getPromptQueueState: async () => ({ state: "paused", pendingCount: 1 }),
  } as unknown as ExpertSession;
  const resolveExecutor = vi.fn(async () => undefined);
  const owner = new MissionExecutionOwner();
  const adapter = createLocalHostCoreMissionControlAdapter({
    ownerAccess: owner,
    runtimes: {
      resolve: async () => ({
        adapter: {
          features: { steering: { status: supportsSteer ? "supported" : "unsupported" } },
          canUse: async () => ({ usable: true }),
        },
      }),
    } as unknown as RuntimeResolver,
    executions: { get: async () => undefined } as unknown as ExecutionStore,
    sessions: {
      get: async () => state(),
      listPrompts: persistedPrompts,
    } as unknown as ExpertSessionStore,
    mission: { controller: {} as never, append: async () => undefined },
    executors: resolveExecutor,
    resolveMissionBinding: async () => undefined,
    resolveActiveOwner: async () => ({ kind: "session", session, executor: {} as never }),
  });
  return {
    adapter,
    persistedPrompts,
    owner,
    prompt,
    abort,
    cancelPromptQueue,
    abortExecution,
    removeQueuedPrompt,
    resumePromptQueue,
    steerQueuedPrompt,
    attemptQueuedPromptSteer,
    resolveExecutor,
    changeTarget: (id: string | undefined) => {
      activeExecutionId = id;
    },
  };
}
describe("shared Mission command rules", () => {
  it("clears the whole prompt queue on Mission stop and preserves native stop uncertainty", async () => {
    const f = fixture();
    f.cancelPromptQueue.mockRejectedValueOnce(new Error("native stop unconfirmed"));
    await f.adapter.consumer.apply({
      signal: new AbortController().signal,
      deadlineAt: "2026-10-02T01:00:00.000Z",
      guard,
      command: command(
        "interrupt",
        { kind: "interrupt", reason: "stop" },
        { executionId: "10000000-0000-4000-8000-000000000001" },
      ),
    });
    expect(f.cancelPromptQueue).toHaveBeenCalledWith("stop");
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.owner.controlIssue(missionId)).toMatchObject({
      state: "interrupt_uncertain",
      reasonCode: "MISSION_INTERRUPT_UNCERTAIN",
    });
  });

  it("rejects a strict target changed after reservation without delivering a prompt", async () => {
    const f = fixture();
    const target = await f.adapter.resolveStrictTarget({ missionId });
    expect(target).toEqual({
      executionId: "10000000-0000-4000-8000-000000000001",
      turnId: "root-turn",
    });
    f.changeTarget("10000000-0000-4000-8000-000000000002");
    await expect(
      f.adapter.consumer.apply({
        signal: new AbortController().signal,
        deadlineAt: "2026-10-02T01:00:00.000Z",
        guard,
        command: command(
          "steer",
          { kind: "steer", input: { prompt: "stop", attachments: [] } },
          target,
        ),
      }),
    ).rejects.toMatchObject({ code: "STEER_TARGET_CHANGED" });
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it.each(["steer", "queue.steer"] as const)(
    "validates confirmed %s receipt replay after the original target ends",
    async (kind) => {
      const f = fixture();
      const target = await f.adapter.resolveStrictTarget({ missionId });
      f.persistedPrompts.mockResolvedValue([
        {
          requestId,
          executionId: target!.executionId,
          mode: kind === "steer" ? "steer" : "enqueue",
          status: "succeeded",
          deliveryAttempt: {
            state: "confirmed",
            kind: kind === "steer" ? "strict_steer" : "queue_steer",
            targetExecutionId: target!.executionId,
          },
        },
      ]);
      f.changeTarget(undefined);
      await expect(
        f.adapter.consumer.validateStrictTarget!({
          guard,
          command: command(
            kind,
            kind === "steer"
              ? { kind, input: { prompt: "stop", attachments: [] } }
              : { kind, requestId },
            target,
          ),
        }),
      ).resolves.toBeUndefined();
      expect(f.resolveExecutor).not.toHaveBeenCalled();
      expect(f.prompt).not.toHaveBeenCalled();
      expect(f.steerQueuedPrompt).not.toHaveBeenCalled();
    },
  );
  it("rejects unsupported steering without compiling or reopening a warm owner", async () => {
    const f = fixture(false);
    await expect(f.adapter.resolveStrictTarget({ missionId })).rejects.toMatchObject({
      code: "COMMAND_REJECTED",
      details: { reason: "steer_not_supported" },
    });
    expect(f.resolveExecutor).not.toHaveBeenCalled();
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it("forwards queue try-steer fallback without converting it to enqueue", async () => {
    const f = fixture();
    await expect(
      f.adapter.consumer.apply({
        signal: new AbortController().signal,
        deadlineAt: "2026-10-02T01:00:00.000Z",
        guard,
        command: command("queue.try-steer", { kind: "queue.try-steer", requestId }),
      }),
    ).resolves.toMatchObject({
      result: { queueSteer: { outcome: "retained", reason: "no_active_turn" } },
    });
    expect(f.attemptQueuedPromptSteer).toHaveBeenCalledWith(requestId);
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it("maps strict queued steer target races to the shared conflict", async () => {
    const f = fixture();
    f.steerQueuedPrompt.mockRejectedValueOnce(
      new SteerNotDispatchedError("target_changed", "changed"),
    );
    await expect(
      f.adapter.consumer.apply({
        signal: new AbortController().signal,
        deadlineAt: "2026-10-02T01:00:00.000Z",
        guard,
        command: command(
          "queue.steer",
          { kind: "queue.steer", requestId },
          { executionId: "10000000-0000-4000-8000-000000000001", turnId: "root-turn" },
        ),
      }),
    ).rejects.toMatchObject({ code: "STEER_TARGET_CHANGED" });
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it("preserves queue recovery and removal rejection", async () => {
    const f = fixture();
    f.removeQueuedPrompt.mockRejectedValueOnce(new Error("running"));
    await expect(
      f.adapter.consumer.apply({
        signal: new AbortController().signal,
        deadlineAt: "2026-10-02T01:00:00.000Z",
        guard,
        command: command("queue.remove", { kind: "queue.remove", requestId }),
      }),
    ).rejects.toMatchObject({
      code: "COMMAND_REJECTED",
      details: { reason: "queue_item_not_queued" },
    });
    await f.adapter.consumer.apply({
      signal: new AbortController().signal,
      deadlineAt: "2026-10-02T01:00:00.000Z",
      guard,
      command: command("queue.resume", { kind: "queue.resume", recovery: "abandon" }),
    });
    expect(f.resumePromptQueue).toHaveBeenCalledWith({ recovery: "abandon" });
  });
  it("interrupts the captured completed turn during Session release without aborting a later turn", async () => {
    const f = fixture();
    f.changeTarget(undefined);
    await f.adapter.consumer.apply({
      signal: new AbortController().signal,
      deadlineAt: "2026-10-02T01:00:00.000Z",
      guard,
      command: command(
        "interrupt",
        { kind: "interrupt", reason: "stop" },
        { executionId: "10000000-0000-4000-8000-000000000001" },
      ),
    });
    expect(f.cancelPromptQueue).toHaveBeenCalledWith("stop");
    expect(f.abort).not.toHaveBeenCalled();
    f.changeTarget("10000000-0000-4000-8000-000000000002");
    await expect(
      f.adapter.consumer.apply({
        signal: new AbortController().signal,
        deadlineAt: "2026-10-02T01:00:00.000Z",
        guard,
        command: command(
          "interrupt",
          { kind: "interrupt", reason: "stop" },
          { executionId: "10000000-0000-4000-8000-000000000001" },
        ),
      }),
    ).rejects.toMatchObject({
      code: "COMMAND_REJECTED",
      details: { reason: "execution_target_changed" },
    });
    expect(f.abort).not.toHaveBeenCalled();
  });
});
