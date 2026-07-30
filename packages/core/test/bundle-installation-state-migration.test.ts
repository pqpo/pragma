import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyAtomicStateMigration,
  BundleInstallationsCatalogV2Schema,
  bundleInstallationsMigrationChain,
  recoverAtomicStateMigration,
  StateVersionTooNewError,
} from "../src/index.ts";

const temporaryRoots: string[] = [];
const timestamp = "2026-07-29T08:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("Bundle installation state migration", () => {
  it("upgrades a v1 catalog and preserves every installation field", () => {
    const upgraded = bundleInstallationsMigrationChain.upgrade(v1Catalog());

    expect(upgraded).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      migrated: true,
      value: {
        schemaVersion: "pragma.bundle-installations/v2",
        installations: [
          {
            schemaVersion: "pragma.bundle-installation/v2",
            id: "00000000-0000-4000-8000-000000000001",
            rootName: "Writer",
            status: "needs_setup",
            conflictResolutions: [],
            resourceMappings: [],
          },
        ],
      },
    });
  });

  it("treats current state as a no-op and rejects future state", () => {
    const current = bundleInstallationsMigrationChain.upgrade(v2Catalog());

    expect(current.migrated).toBe(false);
    expect(current.value).toEqual(v2Catalog());
    expect(() =>
      bundleInstallationsMigrationChain.upgrade({
        schemaVersion: "pragma.bundle-installations/v3",
        installations: [],
      }),
    ).toThrow(StateVersionTooNewError);
  });

  it("replays an interrupted catalog migration journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-bundle-migration-"));
    temporaryRoots.push(root);
    const journalFile = join(root, "state-migration.json");
    const catalogFile = join(root, "installations.json");
    const documents = { "installations.json": v2Catalog() };
    const validateDocuments = (value: Readonly<Record<string, unknown>>) => {
      BundleInstallationsCatalogV2Schema.parse(value["installations.json"]);
    };

    await writeFile(catalogFile, `${JSON.stringify(v1Catalog(), null, 2)}\n`);
    await applyAtomicStateMigration({
      aggregateRoot: root,
      journalFile,
      resource: { family: "pragma.bundle-installations", id: "desktop" },
      fromVersion: 1,
      toVersion: 2,
      documents,
      validateDocuments,
    });
    await writeFile(catalogFile, `${JSON.stringify(v1Catalog(), null, 2)}\n`);
    await writeFile(
      journalFile,
      `${JSON.stringify({
        schemaVersion: "pragma.state-migration/v1",
        resource: { family: "pragma.bundle-installations", id: "desktop" },
        fromVersion: 1,
        toVersion: 2,
        documents,
      })}\n`,
    );

    await expect(
      recoverAtomicStateMigration({
        aggregateRoot: root,
        journalFile,
        resource: { family: "pragma.bundle-installations", id: "desktop" },
        validateDocuments,
      }),
    ).resolves.toBe(true);
    await expect(readJson(catalogFile)).resolves.toEqual(v2Catalog());
    await expect(readFile(journalFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function v1Catalog() {
  return {
    schemaVersion: "pragma.bundle-installations/v1",
    installations: [
      {
        schemaVersion: "pragma.bundle-installation/v1",
        id: "00000000-0000-4000-8000-000000000001",
        bundleFingerprint: "a".repeat(64),
        projectId: "studio",
        projectRevision: 4,
        sourceRootRef: "expert:1xddvess309a6gme",
        rootRef: "expert:1xddvess309a6gme",
        rootName: "Writer",
        rootKind: "Expert",
        resourceRefs: ["expert:1xddvess309a6gme"],
        createdResourceRefs: ["expert:1xddvess309a6gme"],
        createdCapabilityIds: [],
        createdContextStoreIds: [],
        createdPluginRefs: [],
        status: "needs_setup",
        pending: [
          {
            id: "runtime:runtime-profile:zdkgs0fde4xt00vr",
            kind: "runtime",
            resourceRef: "runtime-profile:zdkgs0fde4xt00vr",
            name: "Writer Runtime",
            message: "Choose a compatible Runtime.",
          },
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
}

function v2Catalog() {
  const legacy = v1Catalog();
  return {
    schemaVersion: "pragma.bundle-installations/v2",
    installations: legacy.installations.map((installation) => ({
      ...installation,
      schemaVersion: "pragma.bundle-installation/v2",
      conflictResolutions: [],
      resourceMappings: [],
    })),
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
