import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMissionControlApplication,
  createMissionControllerStore,
  createMissionOwnerScope,
} from "../src/index.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("MissionControlApplication", () => {
  it.each([false, true])(
    "routes strict steer after a delayed heartbeat and fences takeover=%s",
    async (takeover) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-mission-control-heartbeat-"));
      temporaryRoots.push(root);
      let milliseconds = Date.parse("2026-09-30T00:00:00.000Z");
      const now = () => new Date(milliseconds);
      const controller = createMissionControllerStore({
        missionsPath: join(root, "missions"),
        clock: { now },
      });
      const ownerScope = createMissionOwnerScope({ controller });
      const missionId = "22222222-2222-4222-8222-222222222222";
      const requestId = "33333333-3333-4333-8333-333333333333";
      const guard = await ownerScope.acquire(missionId);
      const apply = vi.fn(async () => ({ result: { delivered: true } }));
      const assertAcquisitionAllowed = vi.fn(async () => {
        throw new Error("An existing task must not be treated as a new acquisition.");
      });
      const control = createMissionControlApplication({
        controller,
        // Drive delivery explicitly so takeover can occur between append and consume.
        ownerScope: { ...ownerScope, bindConsumer: () => undefined },
        consumer: { apply },
        assertAcquisitionAllowed,
        resolveStrictTarget: async () => ({ executionId: requestId, turnId: "turn-1" }),
        now,
      });
      try {
        milliseconds += 3 * 24 * 60 * 60 * 1_000;
        const submission = await control.submit({
          missionId,
          requestId,
          kind: "steer",
          payload: {
            kind: "steer",
            input: { prompt: "Continue the long task", attachments: [] },
          },
        });
        expect(submission).toMatchObject({
          owner: "live",
          command: { targetFencingToken: guard.fencingToken },
        });
        expect(assertAcquisitionAllowed).not.toHaveBeenCalled();
        const deliveryGuard = takeover
          ? await controller.claim({
              missionId,
              claimId: "44444444-4444-4444-8444-444444444444",
              leaseMs: 30_000,
            })
          : guard;
        await controller.processNext({ missionId, guard: deliveryGuard, consumer: { apply } });
        expect(await controller.getOperation({ missionId, requestId })).toMatchObject(
          takeover
            ? { state: "rejected", error: { code: "STEER_TARGET_CHANGED" } }
            : { state: "applied", result: { delivered: true } },
        );
        expect(apply).toHaveBeenCalledTimes(takeover ? 0 : 1);
      } finally {
        await ownerScope.stop(missionId);
      }
    },
  );

  it("returns a durable receipt without waiting for owner startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-control-"));
    temporaryRoots.push(root);
    const controller = createMissionControllerStore({ missionsPath: join(root, "missions") });
    const baseOwnerScope = createMissionOwnerScope({ controller, leaseMs: 1_000 });
    let allowOwnerStart = (): void => undefined;
    const ownerStartGate = new Promise<void>((resolve) => {
      allowOwnerStart = resolve;
    });
    const control = createMissionControlApplication({
      controller,
      ownerScope: {
        ...baseOwnerScope,
        acquire: async (...input) => {
          await ownerStartGate;
          return await baseOwnerScope.acquire(...input);
        },
      },
      consumer: { apply: async () => ({ result: { accepted: true } }) },
    });
    const missionId = "22222222-2222-4222-8222-222222222222";
    const requestId = "33333333-3333-4333-8333-333333333333";

    const submission = await control.submit({
      missionId,
      requestId,
      kind: "send",
      payload: { kind: "send", input: { prompt: "slow owner", attachments: [] } },
    });
    expect(submission).toMatchObject({
      owner: "scheduled",
      operation: { state: "queued", requestId },
    });

    allowOwnerStart();
    await expect(
      control.waitForTerminal({ missionId, requestId, timeoutMs: 2_000, pollIntervalMs: 5 }),
    ).resolves.toMatchObject({ state: "applied", result: { accepted: true } });
    await control.stopOwner(missionId);
  });
});
