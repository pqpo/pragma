import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
