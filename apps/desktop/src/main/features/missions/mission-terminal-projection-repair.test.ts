import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMissionControllerStore, createMissionOwnerScope } from "@pragma/local-host";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MissionSchema } from "../../../shared/contracts/index.ts";
import {
  createMissionTerminalProjectionRepair,
  type MissionProjectionMismatch,
} from "./mission-terminal-projection-repair.ts";

const missionId = "22222222-2222-4222-8222-222222222222";
const executionId = "44444444-4444-4444-8444-444444444444";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

function mismatch(): MissionProjectionMismatch {
  return {
    mission: MissionSchema.parse({
      schemaVersion: "pragma.mission/v10",
      id: missionId,
      title: "Repair terminal",
      goal: "Repair independently",
      initialMessageId: "55555555-5555-4555-8555-555555555555",
      toolPermissionMode: "request-approval",
      workspace: { path: "/tmp/workspace", basename: "workspace" },
      project: { id: "studio", revision: 1 },
      executor: { kind: "expert", ref: "expert:v2vt1v01vzz6j24q", name: "Expert" },
      execution: {
        id: executionId,
        inputMessageId: "66666666-6666-4666-8666-666666666666",
        status: "running",
        startedAt: "2026-09-16T00:00:00.000Z",
      },
      lifecycleStatus: "active",
      contextMounts: [],
      origin: { type: "user" },
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
    }),
    executionId,
    status: "succeeded",
    finishedAt: "2026-09-16T00:01:00.000Z",
  };
}

function ownerScope() {
  const guard = { claimId: "77777777-7777-4777-8777-777777777777", fencingToken: "1" };
  return {
    currentGuard: vi.fn(() => guard),
    acquire: vi.fn(async () => guard),
    runWithGuard: vi.fn(async (_missionId, _guard, operation: () => Promise<void>) => {
      await operation();
    }),
    release: vi.fn(async () => undefined),
  } as never;
}

function controller() {
  return {
    claim: vi.fn(async (input: { readonly claimId: string }) => ({
      claimId: input.claimId,
      fencingToken: "2",
      acquiredAt: "2026-09-16T00:00:00.000Z",
      renewedAt: "2026-09-16T00:00:00.000Z",
      expiresAt: "2026-09-16T00:00:05.000Z",
    })),
    release: vi.fn(async () => undefined),
  };
}

describe("Mission terminal projection repair", () => {
  it("repairs the terminal event even when the v10 snapshot remains unavailable", async () => {
    const terminal = vi.fn(async () => undefined);
    const updateExecution = vi.fn(async () => await Promise.reject(new Error("snapshot failed")));
    const reporter = {
      eventFailure: vi.fn(),
      snapshotFailure: vi.fn(),
      rebuilt: vi.fn(),
    };
    const repair = createMissionTerminalProjectionRepair({
      ownerScope: ownerScope(),
      controller: controller(),
      missions: { updateExecution } as never,
      events: { terminal },
      reporter,
    });

    await expect(repair(mismatch())).rejects.toBeInstanceOf(AggregateError);
    expect(terminal).toHaveBeenCalledOnce();
    expect(updateExecution).toHaveBeenCalledTimes(3);
    expect(reporter.rebuilt).toHaveBeenCalledOnce();
  });

  it("repairs the v10 snapshot even when the terminal event remains unavailable", async () => {
    const terminal = vi.fn(async () => await Promise.reject(new Error("event failed")));
    const updateExecution = vi.fn(async () => mismatch().mission);
    const reporter = {
      eventFailure: vi.fn(),
      snapshotFailure: vi.fn(),
      rebuilt: vi.fn(),
    };
    const repair = createMissionTerminalProjectionRepair({
      ownerScope: ownerScope(),
      controller: controller(),
      missions: { updateExecution } as never,
      events: { terminal },
      reporter,
    });

    await expect(repair(mismatch())).rejects.toBeInstanceOf(AggregateError);
    expect(terminal).toHaveBeenCalledTimes(3);
    expect(updateExecution).toHaveBeenCalledOnce();
    expect(reporter.eventFailure).toHaveBeenCalledOnce();
    expect(reporter.rebuilt).not.toHaveBeenCalled();
  });

  it("releases only the exact repair claim when no operation guard is in scope", async () => {
    const scope = {
      currentGuard: vi.fn(() => undefined),
      runWithGuard: vi.fn(async (_missionId, _guard, operation: () => Promise<void>) => {
        await operation();
      }),
    } as never;
    const control = controller();
    const repair = createMissionTerminalProjectionRepair({
      ownerScope: scope,
      controller: control,
      missions: { updateExecution: vi.fn(async () => mismatch().mission) } as never,
      events: { terminal: vi.fn(async () => undefined) },
      reporter: { eventFailure: vi.fn(), snapshotFailure: vi.fn(), rebuilt: vi.fn() },
    });

    await repair(mismatch());

    const claimedGuard = control.claim.mock.results[0]?.value;
    const resolvedGuard = await claimedGuard;
    expect(control.release).toHaveBeenCalledWith({ missionId, guard: resolvedGuard });
  });

  it("never borrows or releases a live owner while using the real controller fence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-terminal-repair-fence-"));
    roots.push(root);
    const controller = createMissionControllerStore({ missionsPath: root });
    const scope = createMissionOwnerScope({ controller, leaseMs: 30_000 });
    const liveGuard = await scope.acquire(missionId);
    const terminal = vi.fn(
      async (input: { readonly guard?: typeof liveGuard | undefined }) => {
        await controller.write({
          missionId,
          guard: input.guard!,
          operation: async ({ appendEvent }) => {
            await appendEvent(
              "run.succeeded",
              { executionId },
              "99999999-9999-4999-8999-999999999999",
            );
          },
        });
      },
    );
    const repair = createMissionTerminalProjectionRepair({
      ownerScope: scope,
      controller,
      missions: { updateExecution: vi.fn(async () => mismatch().mission) } as never,
      events: { terminal },
      reporter: { eventFailure: vi.fn(), snapshotFailure: vi.fn(), rebuilt: vi.fn() },
    });

    await expect(repair(mismatch())).rejects.toMatchObject({ code: "MISSION_LEASE_HELD" });
    await expect(controller.assertWriteGuard({ missionId, guard: liveGuard })).resolves.toBeUndefined();
    expect(terminal).not.toHaveBeenCalled();

    await scope.release(missionId);
    await expect(repair(mismatch())).resolves.toBeUndefined();
    expect(terminal).toHaveBeenCalledOnce();
    const successor = await controller.claim({
      missionId,
      claimId: "88888888-8888-4888-8888-888888888888",
      leaseMs: 30_000,
    });
    await controller.release({ missionId, guard: successor });
  });
});
