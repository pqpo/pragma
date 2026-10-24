import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
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
    schemaVersion: "pragma.mission-execution-snapshot/v2",
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

it("upgrades a real v1 writer snapshot, retains exact backup and replays an interrupted upgrade", async () => {
  const f = await fixture();
  const source = await readFile(
    new URL("./fixtures/expert-permissions/execution-snapshot-v1.json", import.meta.url),
    "utf8",
  );
  await writeFile(f.path, source);
  const upgraded = await readMissionExecutionSnapshot(f.path);
  expect(upgraded?.schemaVersion).toBe("pragma.mission-execution-snapshot/v2");
  expect(upgraded?.resources[0]).toMatchObject({
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    spec: { instructions: "Pinned original instructions" },
  });
  expect(await readFile(`${f.path}.v1.backup.json`, "utf8")).toBe(source);
  const committed = await readFile(f.path, "utf8");
  await readMissionExecutionSnapshot(f.path);
  expect(await readFile(f.path, "utf8")).toBe(committed);
  await writeFile(f.path, source);
  await writeFile(
    `${f.path}.schema-migration.json`,
    JSON.stringify({
      schemaVersion: "pragma.state-migration/v1",
      resource: { family: "pragma.mission-execution-snapshot", id: "execution-snapshot.json" },
      fromVersion: 1,
      toVersion: 2,
      documents: { "execution-snapshot.json": upgraded },
    }),
  );
  expect(await readMissionExecutionSnapshot(f.path)).toEqual(upgraded);
  expect(await readFile(`${f.path}.v1.backup.json`, "utf8")).toBe(source);
});

it("recovers a prepared snapshot upgrade when the target file is missing", async () => {
  const f = await fixture();
  const source = await readFile(
    new URL("./fixtures/expert-permissions/execution-snapshot-v1.json", import.meta.url),
    "utf8",
  );
  await writeFile(f.path, source);
  const target = await readMissionExecutionSnapshot(f.path);
  await writeFile(
    `${f.path}.schema-migration.json`,
    JSON.stringify({
      schemaVersion: "pragma.state-migration/v1",
      resource: { family: "pragma.mission-execution-snapshot", id: "execution-snapshot.json" },
      fromVersion: 1,
      toVersion: 2,
      documents: { "execution-snapshot.json": target },
    }),
  );
  await rm(f.path);
  expect(await readMissionExecutionSnapshot(f.path)).toEqual(target);
});

it.each(["future", "wrong-owner"])(
  "preserves snapshot data and journal on %s replay conflicts",
  async (kind) => {
    const f = await fixture();
    const persisted = JSON.stringify({
      ...f.snapshot,
      ...(kind === "future" ? { schemaVersion: "pragma.mission-execution-snapshot/v999" } : {}),
    });
    await writeFile(f.path, persisted);
    const target = {
      ...f.snapshot,
      ...(kind === "wrong-owner" ? { missionId: "another-mission" } : {}),
    };
    const journal = JSON.stringify({
      schemaVersion: "pragma.state-migration/v1",
      resource: { family: "pragma.mission-execution-snapshot", id: "execution-snapshot.json" },
      fromVersion: 1,
      toVersion: 2,
      documents: { "execution-snapshot.json": target },
    });
    await writeFile(`${f.path}.schema-migration.json`, journal);
    await expect(readMissionExecutionSnapshot(f.path)).rejects.toThrow();
    expect(await readFile(f.path, "utf8")).toBe(persisted);
    expect(await readFile(`${f.path}.schema-migration.json`, "utf8")).toBe(journal);
  },
);
