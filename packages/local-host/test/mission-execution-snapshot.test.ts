import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  missionExecutionSnapshotsReference,
  readMissionExecutionSnapshot,
  writeMissionExecutionSnapshot,
  type MissionExecutionSnapshot,
} from "../src/missions/execution-snapshot.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pragma-mission-snapshot-"));
  roots.push(root);
  const path = join(root, "mission-owner", "execution-snapshot.json");
  const snapshot: MissionExecutionSnapshot = {
    schemaVersion: "pragma.mission-execution-snapshot/v1",
    missionId: "mission",
    project: { id: "studio", revision: 1 },
    executorRef: "expert:0000000000pragma",
    resources: [],
    fingerprints: [],
    capabilities: [{ capabilityId: "skill", resolvedRevision: 10, fingerprint: "a".repeat(64) }],
    pluginRefs: ["plugin:original@1.0.0"],
    sources: {},
  };
  await writeMissionExecutionSnapshot(path, snapshot);
  return { root, path, snapshot };
}

it("retains pinned library references until the owning Mission is deleted", async () => {
  const f = await fixture();
  expect(await missionExecutionSnapshotsReference(f.root, { capabilityId: "skill" })).toBe(true);
  expect(
    await missionExecutionSnapshotsReference(f.root, { pluginRef: "plugin:original@1.0.0" }),
  ).toBe(true);
  expect(await missionExecutionSnapshotsReference(f.root, { capabilityId: "unrelated" })).toBe(
    false,
  );
  await rm(join(f.root, "mission-owner"), { recursive: true });
  expect(await missionExecutionSnapshotsReference(f.root, { capabilityId: "skill" })).toBe(false);
});

it("ignores an uncommitted temporary write and refuses future/corrupt snapshots without changing them", async () => {
  const f = await fixture();
  await writeFile(`${f.path}.interrupted.tmp`, '{"schemaVersion":');
  expect(await readMissionExecutionSnapshot(f.path)).toEqual(f.snapshot);
  const future = JSON.stringify({
    ...f.snapshot,
    schemaVersion: "pragma.mission-execution-snapshot/v999",
  });
  await writeFile(f.path, future);
  await expect(readMissionExecutionSnapshot(f.path)).rejects.toThrow();
  expect(await readFile(f.path, "utf8")).toBe(future);
  // Deletion must not silently skip a damaged strong reference.
  await expect(
    missionExecutionSnapshotsReference(f.root, { capabilityId: "skill" }),
  ).rejects.toThrow();
  await writeFile(f.path, '{"schemaVersion":');
  await expect(readMissionExecutionSnapshot(f.path)).rejects.toThrow();
  expect(await readFile(f.path, "utf8")).toBe('{"schemaVersion":');
});
