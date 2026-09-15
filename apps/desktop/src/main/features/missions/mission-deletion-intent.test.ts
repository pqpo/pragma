import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  hasMissionDeletionIntent,
  persistMissionDeletionIntent,
} from "./mission-deletion-intent.ts";

const missionId = "00000000-0000-4000-8000-000000000001";
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Mission deletion intent", () => {
  it("persists one idempotent owner-validated intent before cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-deletion-intent-"));
    temporaryPaths.push(root);
    expect(await hasMissionDeletionIntent(root, missionId)).toBe(false);

    await persistMissionDeletionIntent(root, missionId);
    const first = await readFile(join(root, "deletion-intent.json"), "utf8");
    await persistMissionDeletionIntent(root, missionId);

    expect(await readFile(join(root, "deletion-intent.json"), "utf8")).toBe(first);
    expect(await hasMissionDeletionIntent(root, missionId)).toBe(true);
    await expect(
      hasMissionDeletionIntent(root, "00000000-0000-4000-8000-000000000002"),
    ).rejects.toThrow("owner does not match");
  });

  it("fails closed for an unsupported persisted intent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-deletion-intent-future-"));
    temporaryPaths.push(root);
    await writeFile(
      join(root, "deletion-intent.json"),
      JSON.stringify({
        schemaVersion: "pragma.desktop-mission-deletion-intent/v2",
        deletionId: "00000000-0000-4000-8000-000000000003",
        missionId,
        requestedAt: "2026-09-15T00:00:00.000Z",
      }),
    );

    await expect(hasMissionDeletionIntent(root, missionId)).rejects.toThrow();
  });
});
