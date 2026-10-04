import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SteerNotDispatchedError, type ExpertSession, type ExpertTurn } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";
import { createLocalHostMissionCommandAdmission } from "../src/mission-command-admission.ts";
import { MissionExecutionOwner } from "../src/missions/execution-owner.ts";
import { createMissionControllerStore, MissionSemanticWritePendingError } from "../src/index.ts";

const missionId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
function fixture() {
  const owner = new MissionExecutionOwner();
  const turns = new Map<string, ExpertTurn>();
  const dispatch = vi.fn();
  const prompt = vi.fn(async (_content: string, options: { requestId: string }) => {
    const existing = turns.get(options.requestId);
    if (existing !== undefined) return existing;
    const turn = {
      executionId: requestId,
      requestId: options.requestId,
      effectiveMode: "enqueue",
    } as ExpertTurn;
    turns.set(options.requestId, turn);
    dispatch();
    return turn;
  });
  const session = {
    prompt,
    getPromptQueue: async () => [],
    close: async () => undefined,
  } as unknown as ExpertSession;
  owner.setSession(missionId, session);
  const open = vi.fn(async () => session);
  let mission = {
    id: missionId,
    lifecycleStatus: "active",
    executor: { kind: "expert" },
    execution: { id: requestId },
  };
  const project = vi.fn(async () => ({ missionId, requestId }));
  const options = {
    executionKernel: {
      preparePromptSession: async () => ({ session, replaced: false }),
      receiptStatus: async () => undefined,
    },
    getMission: async () => mission,
    admit: <T>(id: string, operation: () => Promise<T>) => owner.admit(id, operation),
    withController: async <T>(_id: string, operation: () => Promise<T>) => await operation(),
    settleTerminal: async () => false,
    contextBindingsChanging: () => false,
    successorRequired: () => false,
    hasActive: () => false,
    session: () => session,
    assertReady: async () => undefined,
    startInitialRun: async () => undefined,
    prepare: async () => ({
      session,
      definitionChanged: false,
      contextStoresChanged: false,
      subject: { missionId, request: { requestId } },
      rememberSession: () => undefined,
    }),
    forgetSession: () => undefined,
    projectAccepted: project,
  };
  return {
    options,
    owner,
    session,
    prompt,
    dispatch,
    open,
    project,
    setLifecycle: (status: string) => {
      mission = { ...mission, lifecycleStatus: status };
    },
  };
}
describe("Local Host message admission", () => {
  it("rolls back optional resources when Core rejects without masking the original error", async () => {
    const f = fixture();
    const coreFailure = new Error("Core rejected the prompt");
    const rollbackFailure = new Error("Memory rollback degraded");
    f.prompt.mockRejectedValueOnce(coreFailure);
    const rollback = vi.fn(async () => {
      throw rollbackFailure;
    });
    const onPromptAdmitting = vi.fn(async () => rollback);
    const onPromptAdmissionError = vi.fn();
    const send = createLocalHostMissionCommandAdmission({
      ...f.options,
      onPromptAdmitting,
      onPromptAdmissionError,
    });
    await expect(send({ id: missionId, requestId, content: "Refused" })).rejects.toBe(coreFailure);
    expect(onPromptAdmitting).toHaveBeenCalledWith(missionId, requestId);
    expect(rollback).toHaveBeenCalledOnce();
    expect(onPromptAdmissionError).toHaveBeenCalledWith(rollbackFailure);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("continues Core admission when optional Memory admission is unavailable", async () => {
    const f = fixture();
    const unavailable = new Error("Memory unavailable");
    const onPromptAdmitting = vi.fn(async () => {
      throw unavailable;
    });
    const onPromptAdmissionError = vi.fn();
    const send = createLocalHostMissionCommandAdmission({
      ...f.options,
      onPromptAdmitting,
      onPromptAdmissionError,
    });
    await send({ id: missionId, requestId, content: "Run" });
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(onPromptAdmissionError).toHaveBeenCalledWith(unavailable);
  });

  it("rechecks the captured steer target after preparation before dispatch", async () => {
    const f = fixture();
    let activeExecutionId = "10000000-0000-4000-8000-000000000001";
    const activeRequestId = "root-turn";
    Object.assign(f.session, {
      getState: async () => ({ activeExecutionId }),
      getPromptQueue: async () => [
        {
          executionId: activeExecutionId,
          requestId: activeRequestId,
          mode: "enqueue",
          status: "running",
        },
      ],
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepare = vi.fn(async () => {
      await blocked;
      return await f.options.prepare();
    });
    const send = createLocalHostMissionCommandAdmission({ ...f.options, prepare });
    const sending = send({
      id: missionId,
      requestId,
      content: "steer original",
      mode: "steer",
      target: { executionId: activeExecutionId, turnId: activeRequestId },
    });
    const rejected = expect(sending).rejects.toMatchObject({ code: "STEER_TARGET_CHANGED" });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    activeExecutionId = "10000000-0000-4000-8000-000000000002";
    release();
    await rejected;
    expect(f.prompt).not.toHaveBeenCalled();
  });

  it("maps a Core CAS target change to the stable Mission conflict", async () => {
    const f = fixture();
    Object.assign(f.session, {
      getState: async () => ({ activeExecutionId: requestId }),
      getPromptQueue: async () => [
        { executionId: requestId, requestId: "original", mode: "enqueue", status: "running" },
      ],
    });
    f.prompt.mockRejectedValueOnce(
      new SteerNotDispatchedError("target_changed", "Core target CAS changed"),
    );
    const send = createLocalHostMissionCommandAdmission(f.options);
    await expect(
      send({
        id: missionId,
        requestId,
        content: "steer",
        mode: "steer",
        target: { executionId: requestId, turnId: "original" },
      }),
    ).rejects.toMatchObject({ code: "STEER_TARGET_CHANGED", category: "conflict" });
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("uses a retained Session for later commands without opening another owner", async () => {
    const f = fixture();
    const send = createLocalHostMissionCommandAdmission(f.options);
    await send({ id: missionId, requestId, content: "followup" });
    await send({
      id: missionId,
      requestId: "00000000-0000-4000-8000-000000000003",
      content: "next",
    });
    expect(f.prompt).toHaveBeenCalledTimes(2);
    expect(f.open).not.toHaveBeenCalled();
  });
  it("rejects changing Context bindings before delivering to Core", async () => {
    const f = fixture();
    const send = createLocalHostMissionCommandAdmission({
      ...f.options,
      contextBindingsChanging: () => true,
    });
    await expect(send({ id: missionId, requestId, content: "followup" })).rejects.toThrow(
      "Knowledge change",
    );
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it("does not create a successor while its preceding execution is active", async () => {
    const f = fixture();
    const send = createLocalHostMissionCommandAdmission({
      ...f.options,
      successorRequired: () => true,
      hasActive: () => true,
    });
    await expect(send({ id: missionId, requestId, content: "followup" })).rejects.toThrow(
      "current execution",
    );
    expect(f.open).not.toHaveBeenCalled();
    expect(f.prompt).not.toHaveBeenCalled();
  });
  it("failed admission releases its slot for the next request", async () => {
    const f = fixture();
    const send = createLocalHostMissionCommandAdmission(f.options);
    f.setLifecycle("completed");
    await expect(send({ id: missionId, requestId, content: "rejected" })).rejects.toThrow("Reopen");
    f.setLifecycle("active");
    await expect(send({ id: missionId, requestId, content: "allowed" })).resolves.toEqual({
      missionId,
      requestId,
    });
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("keeps Core-accepted work applying and replays the same request after timeline failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-r1-admission-replay-"));
    try {
      const controller = createMissionControllerStore({ missionsPath: join(root, "missions") });
      const guard = await controller.claim({
        missionId,
        claimId: "00000000-0000-4000-8000-000000000004",
        leaseMs: 30_000,
      });
      await controller.appendCommand({
        missionId,
        kind: "send",
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
        payload: { kind: "send", input: { prompt: "accepted", attachments: [] } },
      });
      const f = fixture();
      let fail = true;
      const timeline = new Set<string>();
      const send = createLocalHostMissionCommandAdmission({
        ...f.options,
        projectAccepted: async () => {
          if (fail)
            throw new MissionSemanticWritePendingError({
              cause: new Error("timeline write failed"),
            });
          timeline.add(requestId);
          return { requestId };
        },
      });
      const consumer = {
        apply: async () => ({
          result: await send({ id: missionId, requestId, content: "accepted" }),
        }),
      };
      await expect(controller.processNext({ missionId, guard, consumer })).rejects.toBeInstanceOf(
        MissionSemanticWritePendingError,
      );
      expect(await controller.getOperation({ missionId, requestId })).toMatchObject({
        state: "applying",
      });
      expect(f.dispatch).toHaveBeenCalledOnce();
      fail = false;
      await controller.processNext({ missionId, guard, consumer });
      expect(await controller.getOperation({ missionId, requestId })).toMatchObject({
        state: "applied",
      });
      expect(f.prompt).toHaveBeenCalledTimes(2);
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect([...timeline]).toEqual([requestId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
