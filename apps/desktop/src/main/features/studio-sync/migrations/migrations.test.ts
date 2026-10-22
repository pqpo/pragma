import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { withFileLock } from "@pragma/core";
import { upgradeAssetSyncOwner } from "../asset-sync-upgrade.ts";
import { settingsMigrationChain, stateMigrationChain, journalMigrationChain } from "./index.ts";

const roots: string[] = [];
const families = [
  ["settings.json", settingsMigrationChain],
  ["state.json", stateMigrationChain],
  ["restore-journal.json", journalMigrationChain],
] as const;
const fixture = async (version: "v1" | "v2" | "v3", name: string): Promise<unknown> =>
  JSON.parse(await readFile(join(import.meta.dirname, "fixtures", version, name), "utf8"));
const currentVersion = (name: string) => (name === "restore-journal.json" ? 3 : 2);
const currentFixture = (name: string) => fixture(currentVersion(name) === 3 ? "v3" : "v2", name);
async function owner(version: "v1" | "v2" = "v1") {
  const root = await mkdtemp(join(tmpdir(), "pragma-sync-upgrade-"));
  roots.push(root);
  for (const [name] of families)
    await writeFile(join(root, name), JSON.stringify(await fixture(version, name)));
  return {
    root,
    upgrade: async () =>
      await withFileLock(
        join(root, "state.json.lock"),
        async () =>
          await upgradeAssetSyncOwner(join(root, "settings.json"), join(root, "state.json")),
      ),
  };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("asset sync owner migrations", () => {
  it.each(families)(
    "upgrades actual historical %s through its adjacent chain",
    async (name, chain) => {
      const old = await fixture("v1", name);
      const target = await currentFixture(name);
      expect(chain.upgrade(old)).toMatchObject({
        value: target,
        fromVersion: 1,
        toVersion: currentVersion(name),
        migrated: true,
      });
      expect(chain.upgrade(target)).toMatchObject({
        value: target,
        fromVersion: currentVersion(name),
        toVersion: currentVersion(name),
        migrated: false,
      });
    },
  );
  it("upgrades all files under one owner lock and backs up the exact original documents", async () => {
    const { root, upgrade } = await owner();
    const original = await Promise.all(
      families.map(([name]) => readFile(join(root, name), "utf8")),
    );
    await upgrade();
    for (const [name] of families)
      expect(JSON.parse(await readFile(join(root, name), "utf8"))).toEqual(
        await currentFixture(name),
      );
    const names = await readdir(join(root, "migrations/backups"));
    const backups = await Promise.all(
      names.map((name) => readFile(join(root, "migrations/backups", name), "utf8")),
    );
    expect(backups.sort()).toEqual(original.sort());
    const current = await Promise.all(families.map(([name]) => readFile(join(root, name), "utf8")));
    await upgrade();
    expect(await Promise.all(families.map(([name]) => readFile(join(root, name), "utf8")))).toEqual(
      current,
    );
    expect(await readdir(join(root, "migrations/backups"))).toEqual(names);
  });
  it("replays a stable journal after only one of the owner documents was replaced", async () => {
    const { root, upgrade } = await owner();
    const documents: Record<string, unknown> = {};
    for (const [name] of families) documents[name] = await fixture("v2", name);
    await writeFile(join(root, "settings.json"), JSON.stringify(documents["settings.json"]));
    await writeFile(
      join(root, "asset-sync.migration.json"),
      JSON.stringify({
        schemaVersion: "pragma.state-migration/v1",
        resource: { family: "pragma.asset-sync-owner", id: "asset-sync" },
        fromVersion: 1,
        toVersion: 2,
        documents,
      }),
    );
    await upgrade();
    for (const [name] of families)
      expect(JSON.parse(await readFile(join(root, name), "utf8"))).toEqual(
        await currentFixture(name),
      );
    await expect(readFile(join(root, "asset-sync.migration.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it.each(families)(
    "rejects future %s without changing any owner document",
    async (name, chain) => {
      const { root, upgrade } = await owner();
      const value = (await currentFixture(name)) as Record<string, unknown>;
      await writeFile(
        join(root, name),
        JSON.stringify({ ...value, schemaVersion: `${chain.family}/v${currentVersion(name) + 1}` }),
      );
      const before = await Promise.all(
        families.map(([file]) => readFile(join(root, file), "utf8")),
      );
      await expect(upgrade()).rejects.toThrow("newer than");
      expect(
        await Promise.all(families.map(([file]) => readFile(join(root, file), "utf8"))),
      ).toEqual(before);
      await expect(readdir(join(root, "migrations/backups"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
  it("rejects invalid embedded journal state and leaves an unrelated owner available", async () => {
    const bad = await owner();
    const good = await owner("v2");
    const journal = (await fixture("v1", "restore-journal.json")) as Record<string, unknown>;
    await writeFile(
      join(bad.root, "restore-journal.json"),
      JSON.stringify({
        ...journal,
        incomingState: { schemaVersion: "pragma.asset-sync-state/v99" },
      }),
    );
    await expect(bad.upgrade()).rejects.toThrow();
    await expect(good.upgrade()).resolves.toBeUndefined();
  });
  it("rejects a future migration operation without replaying its documents", async () => {
    const { root, upgrade } = await owner();
    await writeFile(
      join(root, "asset-sync.migration.json"),
      JSON.stringify({ fromVersion: 3, toVersion: 4, documents: {} }),
    );
    await expect(upgrade()).rejects.toThrow("migration_unsupported_version");
  });

  it("never replays a stale migration journal over newer owner data", async () => {
    const { root, upgrade } = await owner();
    const documents: Record<string, unknown> = {};
    for (const [name] of families) documents[name] = await currentFixture(name);
    await writeFile(
      join(root, "asset-sync.migration.json"),
      JSON.stringify({
        schemaVersion: "pragma.state-migration/v1",
        resource: { family: "pragma.asset-sync-owner", id: "asset-sync" },
        fromVersion: 1,
        toVersion: 2,
        documents,
      }),
    );
    const settings = (await fixture("v2", "settings.json")) as Record<string, unknown>;
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify({ ...settings, schemaVersion: "pragma.asset-sync-settings/v3" }),
    );
    const before = await Promise.all(families.map(([name]) => readFile(join(root, name), "utf8")));
    await expect(upgrade()).rejects.toMatchObject({ code: "asset_sync.upgrade_future_version" });
    expect(await Promise.all(families.map(([name]) => readFile(join(root, name), "utf8")))).toEqual(
      before,
    );
    expect(await readFile(join(root, "asset-sync.migration.json"), "utf8")).toContain(
      "pragma.state-migration/v1",
    );
  });
  it("migrates v2 Skill payloads and every stored fingerprint together", async () => {
    const source = await fixture("v2", "skill-restore-journal.json");
    const before = JSON.stringify(source);
    const target = await fixture("v3", "skill-restore-journal.json");
    expect(journalMigrationChain.upgrade(source)).toMatchObject({
      value: target,
      fromVersion: 2,
      toVersion: 3,
      migrated: true,
    });
    expect(JSON.stringify(source)).toBe(before);
    expect(journalMigrationChain.upgrade(target)).toMatchObject({ value: target, migrated: false });
    const { root, upgrade } = await owner("v2");
    await writeFile(join(root, "restore-journal.json"), before);
    await upgrade();
    expect(JSON.parse(await readFile(join(root, "restore-journal.json"), "utf8"))).toEqual(target);
    const names = await readdir(join(root, "migrations/backups"));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/\.v2\.json$/u);
    expect(await readFile(join(root, "migrations/backups", names[0]!), "utf8")).toBe(before);
    await upgrade();
    expect(await readdir(join(root, "migrations/backups"))).toEqual(names);
  });

  it("replays an interrupted v2-to-v3 Skill journal migration", async () => {
    const { root, upgrade } = await owner("v2");
    const target = await fixture("v3", "skill-restore-journal.json");
    await writeFile(
      join(root, "restore-journal.json"),
      JSON.stringify(await fixture("v2", "skill-restore-journal.json")),
    );
    await writeFile(
      join(root, "asset-sync.migration.json"),
      JSON.stringify({
        schemaVersion: "pragma.state-migration/v1",
        resource: { family: "pragma.asset-sync-owner", id: "asset-sync" },
        fromVersion: 2,
        toVersion: 3,
        documents: { "restore-journal.json": target },
      }),
    );
    await upgrade();
    expect(JSON.parse(await readFile(join(root, "restore-journal.json"), "utf8"))).toEqual(target);
    await expect(readFile(join(root, "asset-sync.migration.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an old owner migration that would overwrite a v3 restore journal", async () => {
    const { root, upgrade } = await owner("v2");
    const target = await fixture("v3", "skill-restore-journal.json");
    await writeFile(join(root, "restore-journal.json"), JSON.stringify(target));
    await writeFile(
      join(root, "asset-sync.migration.json"),
      JSON.stringify({
        schemaVersion: "pragma.state-migration/v1",
        resource: { family: "pragma.asset-sync-owner", id: "asset-sync" },
        fromVersion: 1,
        toVersion: 2,
        documents: { "restore-journal.json": await fixture("v2", "restore-journal.json") },
      }),
    );
    await expect(upgrade()).rejects.toThrow("migration_stale");
    expect(JSON.parse(await readFile(join(root, "restore-journal.json"), "utf8"))).toEqual(target);
  });
});
