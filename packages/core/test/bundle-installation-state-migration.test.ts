import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyAtomicStateMigration,
  BundleInstallationsCatalogV5Schema,
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
      toVersion: 5,
      migrated: true,
      value: {
        schemaVersion: "pragma.bundle-installations/v5",
        installations: [
          {
            schemaVersion: "pragma.bundle-installation/v5",
            bundleVersion: "pragma.desktop-bundle/v1",
            id: "00000000-0000-4000-8000-000000000001",
            rootName: "Writer",
            status: "needs_setup",
            conflictResolutions: [],
            resourceMappings: [],
            readiness: [
              {
                id: "runtime:runtime-profile:zdkgs0fde4xt00vr",
                kind: "runtime",
                resourceRef: "runtime-profile:zdkgs0fde4xt00vr",
                name: "Writer Runtime",
                status: "action_required",
                code: "legacy_pending",
                action: "restore_or_replace",
                message: "Choose a compatible Runtime.",
              },
            ],
          },
        ],
      },
    });
  });

  it("applies the adjacent v2 to v5 migration without inventing a portable fingerprint", () => {
    const upgraded = bundleInstallationsMigrationChain.upgrade(v2Catalog());

    expect(upgraded.fromVersion).toBe(2);
    expect(upgraded.toVersion).toBe(5);
    expect(upgraded.migrated).toBe(true);
    expect(upgraded.value.installations[0]).toMatchObject({
      schemaVersion: "pragma.bundle-installation/v5",
      bundleVersion: "pragma.desktop-bundle/v1",
      readiness: [
        {
          id: "runtime:runtime-profile:zdkgs0fde4xt00vr",
          status: "action_required",
          code: "legacy_pending",
          action: "restore_or_replace",
        },
      ],
    });
    expect(upgraded.value.installations[0]).not.toHaveProperty("sourceProjectFingerprint");
  });

  it("upgrades the historical v4 catalog fixture through the adjacent v4 to v5 step", async () => {
    const fixture = JSON.parse(
      await readFile(join(import.meta.dirname, "fixtures", "bundle-installations-v4.json"), "utf8"),
    );
    const upgraded = bundleInstallationsMigrationChain.upgrade(fixture);

    expect(upgraded).toMatchObject({ fromVersion: 4, toVersion: 5, migrated: true });
    expect(upgraded.value.installations[0]).toMatchObject({
      schemaVersion: "pragma.bundle-installation/v5",
      bundleVersion: "pragma.desktop-bundle/v1",
      rootKind: "Expert",
    });
  });

  it("treats current state as a no-op and rejects future state", () => {
    const current = bundleInstallationsMigrationChain.upgrade(v5Catalog());

    expect(current.migrated).toBe(false);
    expect(current.value).toEqual(v5Catalog());
    expect(() =>
      bundleInstallationsMigrationChain.upgrade({
        schemaVersion: "pragma.bundle-installations/v6",
        installations: [],
      }),
    ).toThrow(StateVersionTooNewError);
  });

  it("rejects a partial knowledge-base update baseline", () => {
    const current = v5Catalog();
    const installation = current.installations[0]!;
    expect(() =>
      BundleInstallationsCatalogV5Schema.parse({
        ...current,
        installations: [
          {
            ...installation,
            rootKind: "ContextStore",
            bundleVersion: "pragma.bundle/v2",
            knowledgeBaseUpdate: {
              sourceRef: "context-store:kqh4nx7rx26mb3e7",
              targetRef: "context-store:kqh4nx7rx26mb3e7",
              storeId: "00000000-0000-4000-8000-000000000001",
              baseRevision: 1,
              importedSnapshotHash: "b".repeat(64),
              phase: "prepared",
            },
          },
        ],
      }),
    ).toThrow("baseline revision and snapshot hash must be paired");
  });

  it("replays an interrupted catalog migration journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-bundle-migration-"));
    temporaryRoots.push(root);
    const journalFile = join(root, "state-migration.json");
    const catalogFile = join(root, "installations.json");
    const documents = { "installations.json": v5Catalog() };
    const validateDocuments = (value: Readonly<Record<string, unknown>>) => {
      BundleInstallationsCatalogV5Schema.parse(value["installations.json"]);
    };

    await writeFile(catalogFile, `${JSON.stringify(v1Catalog(), null, 2)}\n`);
    await applyAtomicStateMigration({
      aggregateRoot: root,
      journalFile,
      resource: { family: "pragma.bundle-installations", id: "desktop" },
      fromVersion: 1,
      toVersion: 5,
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
        toVersion: 5,
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
    await expect(readJson(catalogFile)).resolves.toEqual(v5Catalog());
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

function v3Catalog() {
  const previous = v2Catalog();
  return {
    schemaVersion: "pragma.bundle-installations/v3",
    installations: previous.installations.map((installation) => ({
      ...installation,
      schemaVersion: "pragma.bundle-installation/v3",
      bundleVersion: "pragma.desktop-bundle/v1",
    })),
  };
}

function v4Catalog() {
  const previous = v3Catalog();
  return {
    schemaVersion: "pragma.bundle-installations/v4",
    installations: previous.installations.map((installation) => ({
      ...installation,
      schemaVersion: "pragma.bundle-installation/v4",
      readiness: installation.pending.map((dependency) => ({
        id: dependency.id,
        kind: dependency.kind,
        resourceRef: dependency.resourceRef,
        name: dependency.name,
        status: "action_required",
        code: "legacy_pending",
        action: "restore_or_replace",
        message: dependency.message,
      })),
      pending: installation.pending.map((dependency) => ({
        ...dependency,
        status: "action_required",
        code: "legacy_pending",
        action: "restore_or_replace",
      })),
    })),
  };
}

function v5Catalog() {
  const previous = v4Catalog();
  return {
    schemaVersion: "pragma.bundle-installations/v5",
    installations: previous.installations.map((installation) => ({
      ...installation,
      schemaVersion: "pragma.bundle-installation/v5",
    })),
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
