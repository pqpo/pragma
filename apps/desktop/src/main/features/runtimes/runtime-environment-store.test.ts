import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { PragmaPaths, StateVersionTooNewError } from "@pragma/core";
import { describe, expect, it } from "vitest";

import { RuntimeEnvironmentCatalogSchema } from "../../../shared/contracts/index.ts";
import {
  RuntimeEnvironmentCatalogV1Schema,
  runtimeEnvironmentCatalogMigrationChain,
} from "./migrations/index.ts";
import { createRuntimeEnvironmentStore } from "./runtime-environment-store.ts";

const catalogV1Fixture = new URL("./fixtures/runtime-environment-catalog-v1.json", import.meta.url);
const piRevisionV1Fixture = new URL(
  "./fixtures/runtime-environment-revision-v1-pi.json",
  import.meta.url,
);

describe("RuntimeEnvironmentStore", () => {
  it("keeps immutable revisions, a fixed PI default, and deletion tombstones", async () => {
    const pragmaHome = await temporaryHome("pragma-runtime-environments-");
    const store = createRuntimeEnvironmentStore({ pragmaHome });
    await store.initialize();

    expect(await store.getDefaultRuntimeId()).toBe("pi");
    expect((await store.listHeads()).map((head) => head.entry.runtimeId)).toEqual([
      "pi",
      "codex",
      "claude-code",
      "qodercli",
      "antigravity",
    ]);

    const original = (await store.getRevision("pi"))!;
    const updated = await store.update({
      expectedRevision: original.revision,
      definition: { ...original.definition, displayName: "PI Updated" },
    });
    expect(updated.revision).toBe(2);
    expect((await store.getRevision("pi", 1))?.definition.displayName).toBe("Built-in Runtime");
    expect((await store.getRevision("pi"))?.definition.displayName).toBe("PI Updated");

    await expect(store.delete({ runtimeId: "pi", expectedRevision: 2 })).rejects.toThrow(
      "cannot be deleted",
    );
    const deleted = await store.delete({ runtimeId: "codex", expectedRevision: 1 });
    expect(deleted).toMatchObject({ revision: 2, status: "deleted" });
  });

  it("reconciles newly added built-ins without replacing existing revisions", async () => {
    const pragmaHome = await temporaryHome("pragma-runtime-reconcile-");
    const original = createRuntimeEnvironmentStore({
      pragmaHome,
      builtIns: [
        definition("pi", "PI Runtime", "pragma.runtime.pi"),
        definition("codex", "Codex", "pragma.runtime.codex"),
      ],
    });
    await original.initialize();
    const codex = (await original.getRevision("codex"))!;
    await original.update({
      expectedRevision: codex.revision,
      definition: { ...codex.definition, displayName: "Codex Custom" },
    });

    const reconciled = createRuntimeEnvironmentStore({ pragmaHome });
    await reconciled.initialize();

    expect(await reconciled.getDefaultRuntimeId()).toBe("pi");
    expect((await reconciled.listHeads()).map((head) => head.entry.runtimeId)).toEqual([
      "pi",
      "codex",
      "claude-code",
      "qodercli",
      "antigravity",
    ]);
    expect((await reconciled.getRevision("codex"))?.definition.displayName).toBe("Codex Custom");
    expect((await reconciled.getRevision("qodercli"))?.definition.adapter.id).toBe(
      "pragma.runtime.qodercli",
    );
    expect((await reconciled.getRevision("antigravity"))?.definition.adapter.id).toBe(
      "pragma.runtime.antigravity",
    );
  });

  it("upgrades a real v1 catalog fixture, preserves a backup, and fixes the default to PI", async () => {
    const pragmaHome = await temporaryHome("pragma-runtime-migrate-");
    const { paths, source } = await installV1Fixture(pragmaHome);
    const store = createRuntimeEnvironmentStore({ pragmaHome });

    await store.initialize();

    expect(await store.getDefaultRuntimeId()).toBe("pi");
    expect(
      RuntimeEnvironmentCatalogSchema.parse(await readJson(paths.runtimeEnvironmentCatalog())),
    ).toMatchObject({
      schemaVersion: "pragma.runtime-environment-catalog/v2",
      entries: expect.arrayContaining([
        { runtimeId: "pi", latestRevision: 1 },
        { runtimeId: "codex", latestRevision: 1 },
      ]),
    });
    expect(await readJson(join(paths.runtimeEnvironmentsRoot(), "catalog.v1-backup.json"))).toEqual(
      source,
    );
  });

  it("replays an interrupted catalog migration journal", async () => {
    const pragmaHome = await temporaryHome("pragma-runtime-recover-");
    const { paths, source } = await installV1Fixture(pragmaHome);
    const journalPath = join(paths.runtimeEnvironmentsRoot(), ".catalog.v1-to-v2.journal.json");
    await writeJson(journalPath, {
      schemaVersion: "pragma.state-migration/v1",
      resource: { family: "pragma.runtime-environment-catalog", id: "desktop" },
      fromVersion: 1,
      toVersion: 2,
      documents: {
        "catalog.v1-backup.json": source,
        "catalog.json": {
          schemaVersion: "pragma.runtime-environment-catalog/v2",
          entries: source.entries,
        },
      },
    });

    await createRuntimeEnvironmentStore({ pragmaHome }).initialize();

    expect(
      RuntimeEnvironmentCatalogSchema.parse(await readJson(paths.runtimeEnvironmentCatalog())),
    ).toMatchObject({ schemaVersion: "pragma.runtime-environment-catalog/v2" });
    await expect(access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps v2 catalogs as a no-op and rejects future versions", async () => {
    expect(
      runtimeEnvironmentCatalogMigrationChain.upgrade({
        schemaVersion: "pragma.runtime-environment-catalog/v2",
        entries: [],
      }),
    ).toMatchObject({ fromVersion: 2, toVersion: 2, migrated: false });

    const pragmaHome = await temporaryHome("pragma-runtime-future-");
    const paths = new PragmaPaths({ pragmaHome });
    await writeJson(paths.runtimeEnvironmentCatalog(), {
      schemaVersion: "pragma.runtime-environment-catalog/v3",
      entries: [],
    });
    await expect(createRuntimeEnvironmentStore({ pragmaHome }).initialize()).rejects.toBeInstanceOf(
      StateVersionTooNewError,
    );
  });
});

async function temporaryHome(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function installV1Fixture(pragmaHome: string) {
  const paths = new PragmaPaths({ pragmaHome });
  await mkdir(dirname(paths.runtimeEnvironmentCatalog()), { recursive: true });
  await copyFile(catalogV1Fixture, paths.runtimeEnvironmentCatalog());
  const piRevisionPath = paths.runtimeEnvironmentRevision("pi", 1);
  await mkdir(dirname(piRevisionPath), { recursive: true });
  await copyFile(piRevisionV1Fixture, piRevisionPath);
  return {
    paths,
    source: RuntimeEnvironmentCatalogV1Schema.parse(
      JSON.parse(await readFile(catalogV1Fixture, "utf8")) as unknown,
    ),
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function definition(id: string, displayName: string, adapterId: string) {
  return {
    schemaVersion: "pragma.runtime-environment/v1" as const,
    id,
    adapter: { id: adapterId, version: "v1" },
    displayName,
    origin: "built-in" as const,
    config: {},
  };
}
