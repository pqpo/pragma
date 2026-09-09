import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyAtomicStateMigration,
  createRuntimeSessionRecord,
  defineStateMigrationChain,
  encodePragmaPathSegment,
  moveOwnedStorageToTrash,
  PragmaPaths,
  readRuntimeSessionRecord,
  recoverAtomicStateMigration,
  StateVersionTooNewError,
} from "../src/index.ts";
import {
  commitRuntimeSessionCatalogDeletion,
  prepareRuntimeSessionCatalogDeletion,
  runtimeSessionCatalogPath,
  withRuntimeSessionCatalogDeletionLock,
} from "../src/storage/migrations/runtime-session-catalog/index.ts";
import { RUNTIME_SESSION_CATALOG_V1_SCHEMA_SQL } from "../src/storage/migrations/runtime-session-catalog/schemas/v1.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("versioned state migrations", () => {
  it("claims Runtime Session ownership atomically in the SQLite catalog", async () => {
    const home = await temporaryRoot("pragma-runtime-session-catalog-");
    const paths = new PragmaPaths({ pragmaHome: home });
    const input = {
      paths,
      owner: { type: "expert-session" as const, ownerId: "owner", contextId: "context" },
      systemSessionId: "system-session",
      agentId: "expert",
      runtime: { id: "runtime", kind: "test", displayName: "Test" },
      workspace: "/workspace",
    };

    await createRuntimeSessionRecord(input);
    await expect(
      createRuntimeSessionRecord({
        ...input,
        owner: { type: "expert-session", ownerId: "other", contextId: "context" },
      }),
    ).rejects.toThrow("already owned");
    await expect(readRuntimeSessionRecord(paths, "owner", "system-session")).resolves.toMatchObject(
      { systemSessionId: "system-session", owner: { ownerId: "owner" } },
    );

    const runtimeRoot = paths.runtimeOwnerRoot("owner");
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(join(runtimeRoot, "native-state"), "state");
    await moveOwnedStorageToTrash({
      paths,
      owner: { type: "mission", id: "mission" },
      sources: [{ label: "runtime-sessions", path: runtimeRoot }],
      runtimeSessionOwnerIds: ["owner"],
    });
    await expect(readRuntimeSessionRecord(paths, "owner", "system-session")).rejects.toThrow(
      "Runtime Session not found",
    );
  });

  it("replays a prepared Runtime Session catalog deletion after a crash", async () => {
    const home = await temporaryRoot("pragma-runtime-session-delete-recovery-");
    const paths = new PragmaPaths({ pragmaHome: home });
    await createRuntimeSessionRecord({
      paths,
      owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
      systemSessionId: "system-session",
      agentId: "expert",
      runtime: { id: "runtime", kind: "test", displayName: "Test" },
      workspace: "/workspace",
    });
    const source = paths.runtimeOwnerRoot("owner");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "native-state"), "state");
    const deletionId = "11111111-2222-4333-8444-555555555555";
    await mkdir(paths.deletionJournalRoot(), { recursive: true });
    await writeJson(join(paths.deletionJournalRoot(), `${deletionId}.json`), {
      schemaVersion: "pragma.storage-deletion/v1",
      deletionId,
      owner: { type: "mission", id: "mission" },
      status: "moving",
      sources: [{ label: "runtime-sessions", path: source }],
      moved: [],
      runtimeSessionOwnerIds: ["owner"],
      startedAt: "2026-09-09T00:00:00.000Z",
    });
    await prepareRuntimeSessionCatalogDeletion(paths, deletionId, ["owner"]);

    await expect(readRuntimeSessionRecord(paths, "owner", "system-session")).rejects.toThrow(
      "Runtime Session not found",
    );
    await expect(
      readFile(join(paths.trashRoot(), deletionId, "runtime-sessions", "native-state"), "utf8"),
    ).resolves.toBe("state");
    await expect(
      readJson(join(paths.deletionJournalRoot(), `${deletionId}.json`)),
    ).resolves.toMatchObject({ status: "trashed" });
  });

  it("does not race recovery against an active catalog deletion", async () => {
    const home = await temporaryRoot("pragma-runtime-session-delete-lock-");
    const paths = new PragmaPaths({ pragmaHome: home });
    await createRuntimeSessionRecord({
      paths,
      owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
      systemSessionId: "system-session",
      agentId: "expert",
      runtime: { id: "runtime", kind: "test", displayName: "Test" },
      workspace: "/workspace",
    });
    const deletionId = "41111111-2222-4333-8444-555555555555";
    await mkdir(paths.deletionJournalRoot(), { recursive: true });
    await writeJson(join(paths.deletionJournalRoot(), `${deletionId}.json`), {
      schemaVersion: "pragma.storage-deletion/v1",
      deletionId,
      owner: { type: "mission", id: "mission" },
      status: "moving",
      sources: [],
      moved: [],
      runtimeSessionOwnerIds: ["owner"],
      startedAt: "2026-09-09T00:00:00.000Z",
    });
    await prepareRuntimeSessionCatalogDeletion(paths, deletionId, ["owner"]);

    let concurrentRead: ReturnType<typeof readRuntimeSessionRecord> | undefined;
    await withRuntimeSessionCatalogDeletionLock(paths, async () => {
      concurrentRead = readRuntimeSessionRecord(paths, "owner", "system-session");
      const outcome = await Promise.race([
        concurrentRead.then(
          () => "settled",
          () => "settled",
        ),
        new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 50)),
      ]);
      expect(outcome).toBe("waiting");
    });

    await expect(concurrentRead).rejects.toThrow("Runtime Session not found");
  });

  it("finishes a committed catalog deletion whose final journal write was interrupted", async () => {
    const home = await temporaryRoot("pragma-runtime-session-delete-commit-");
    const paths = new PragmaPaths({ pragmaHome: home });
    await createRuntimeSessionRecord({
      paths,
      owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
      systemSessionId: "system-session",
      agentId: "expert",
      runtime: { id: "runtime", kind: "test", displayName: "Test" },
      workspace: "/workspace",
    });
    const deletionId = "21111111-2222-4333-8444-555555555555";
    await mkdir(paths.deletionJournalRoot(), { recursive: true });
    await writeJson(join(paths.deletionJournalRoot(), `${deletionId}.json`), {
      schemaVersion: "pragma.storage-deletion/v1",
      deletionId,
      owner: { type: "mission", id: "mission" },
      status: "catalog-pending",
      sources: [],
      moved: [],
      runtimeSessionOwnerIds: ["owner"],
      startedAt: "2026-09-09T00:00:00.000Z",
    });
    await prepareRuntimeSessionCatalogDeletion(paths, deletionId, ["owner"]);
    await commitRuntimeSessionCatalogDeletion(paths, deletionId);

    await expect(readRuntimeSessionRecord(paths, "owner", "system-session")).rejects.toThrow(
      "Runtime Session not found",
    );
    await expect(
      readJson(join(paths.deletionJournalRoot(), `${deletionId}.json`)),
    ).resolves.toMatchObject({ status: "trashed" });
  });

  it("rejects a deletion journal that points outside the Pragma storage root", async () => {
    const home = await temporaryRoot("pragma-runtime-session-delete-unsafe-");
    const outside = await temporaryRoot("pragma-runtime-session-delete-victim-");
    const paths = new PragmaPaths({ pragmaHome: home });
    await createRuntimeSessionRecord({
      paths,
      owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
      systemSessionId: "system-session",
      agentId: "expert",
      runtime: { id: "runtime", kind: "test", displayName: "Test" },
      workspace: "/workspace",
    });
    const victim = join(outside, "session.json");
    await writeFile(victim, "preserve");
    const deletionId = "31111111-2222-4333-8444-555555555555";
    await mkdir(paths.deletionJournalRoot(), { recursive: true });
    await writeJson(join(paths.deletionJournalRoot(), `${deletionId}.json`), {
      schemaVersion: "pragma.storage-deletion/v1",
      deletionId,
      owner: { type: "mission", id: "mission" },
      status: "moving",
      sources: [{ label: "runtime-sessions", path: victim }],
      moved: [],
      runtimeSessionOwnerIds: ["owner"],
      startedAt: "2026-09-09T00:00:00.000Z",
    });
    await prepareRuntimeSessionCatalogDeletion(paths, deletionId, ["owner"]);

    await expect(readRuntimeSessionRecord(paths, "owner", "system-session")).rejects.toThrow(
      "Unsafe storage deletion source",
    );
    await expect(readFile(victim, "utf8")).resolves.toBe("preserve");
  });

  it("rejects a future Runtime Session catalog without modifying it", async () => {
    const home = await temporaryRoot("pragma-runtime-session-catalog-future-");
    const paths = new PragmaPaths({ pragmaHome: home });
    const catalog = runtimeSessionCatalogPath(paths);
    await mkdir(dirname(catalog), { recursive: true });
    const database = new DatabaseSync(catalog);
    database.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    database.prepare("INSERT INTO metadata(key, value) VALUES ('schema_version', '99')").run();
    database.close();
    const before = await readFile(catalog);

    await expect(readRuntimeSessionRecord(paths, "owner", "system-session")).rejects.toThrow(
      "unsupported-state-version",
    );
    expect(await readFile(catalog)).toEqual(before);
  });

  it("opens a current Runtime Session catalog as a no-op", async () => {
    const home = await temporaryRoot("pragma-runtime-session-catalog-current-");
    const paths = new PragmaPaths({ pragmaHome: home });
    const catalog = runtimeSessionCatalogPath(paths);
    await mkdir(dirname(catalog), { recursive: true });
    const database = new DatabaseSync(catalog);
    database.exec(RUNTIME_SESSION_CATALOG_V1_SCHEMA_SQL);
    database.prepare("INSERT INTO metadata(key, value) VALUES ('schema_version', '1')").run();
    database.prepare("INSERT INTO metadata(key, value) VALUES ('legacy_imported', 'true')").run();
    database.close();

    await expect(readRuntimeSessionRecord(paths, "owner", "missing")).rejects.toThrow(
      "Runtime Session not found",
    );
    const reopened = new DatabaseSync(catalog, { readOnly: true });
    expect(
      reopened.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get(),
    ).toEqual({ value: "1" });
    reopened.close();
  });

  it("applies an explicit adjacent migration chain to the current schema", () => {
    const chain = defineStateMigrationChain({
      family: "pragma.example",
      currentVersion: 3,
      currentSchema: z.object({
        schemaVersion: z.literal("pragma.example/v3"),
        displayName: z.string(),
      }),
      steps: [
        {
          fromVersion: 1,
          toVersion: 2,
          inputSchema: z.object({
            schemaVersion: z.literal("pragma.example/v1"),
            name: z.string(),
          }),
          migrate(value) {
            const record = value as { readonly name: string };
            return { schemaVersion: "pragma.example/v2", label: record.name };
          },
        },
        {
          fromVersion: 2,
          toVersion: 3,
          inputSchema: z.object({
            schemaVersion: z.literal("pragma.example/v2"),
            label: z.string(),
          }),
          migrate(value) {
            const record = value as { readonly label: string };
            return { schemaVersion: "pragma.example/v3", displayName: record.label };
          },
        },
      ],
    });

    expect(chain.upgrade({ schemaVersion: "pragma.example/v1", name: "Pragma" })).toEqual({
      value: { schemaVersion: "pragma.example/v3", displayName: "Pragma" },
      fromVersion: 1,
      toVersion: 3,
      migrated: true,
    });
  });

  it("rejects state written by a newer application without changing it", () => {
    const chain = defineStateMigrationChain({
      family: "pragma.example",
      currentVersion: 2,
      currentSchema: z.object({ schemaVersion: z.literal("pragma.example/v2") }),
    });

    expect(() => chain.upgrade({ schemaVersion: "pragma.example/v3" })).toThrow(
      StateVersionTooNewError,
    );
  });

  it("replays a partially applied multi-document migration journal", async () => {
    const root = await temporaryRoot("pragma-state-migration-");
    const journalFile = join(root, "state-migration.json");
    const documents = {
      "record.json": { schemaVersion: "pragma.example/v2", value: "new" },
      "children.json": [{ id: "child", output: { type: "inline", value: "done" } }],
    };
    const validateDocuments = (value: Readonly<Record<string, unknown>>) => {
      z.object({ schemaVersion: z.literal("pragma.example/v2"), value: z.string() }).parse(
        value["record.json"],
      );
      z.array(
        z.object({
          id: z.string(),
          output: z.object({ type: z.literal("inline"), value: z.unknown() }),
        }),
      ).parse(value["children.json"]);
    };
    await mkdir(root, { recursive: true });
    await writeJson(join(root, "record.json"), documents["record.json"]);
    await writeJson(join(root, "children.json"), [{ id: "child", output: "old" }]);
    await writeJson(journalFile, {
      schemaVersion: "pragma.state-migration/v1",
      resource: { family: "pragma.example", id: "example" },
      fromVersion: 1,
      toVersion: 2,
      documents,
    });

    await expect(
      recoverAtomicStateMigration({
        aggregateRoot: root,
        journalFile,
        resource: { family: "pragma.example", id: "example" },
        validateDocuments,
      }),
    ).resolves.toBe(true);

    await expect(readJson(join(root, "record.json"))).resolves.toEqual(documents["record.json"]);
    await expect(readJson(join(root, "children.json"))).resolves.toEqual(
      documents["children.json"],
    );
    await expect(readFile(journalFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates every document before publishing the migration journal", async () => {
    const root = await temporaryRoot("pragma-state-validation-");
    const journalFile = join(root, "state-migration.json");

    await expect(
      applyAtomicStateMigration({
        aggregateRoot: root,
        journalFile,
        resource: { family: "pragma.example", id: "example" },
        fromVersion: 1,
        toVersion: 2,
        documents: {
          "record.json": { schemaVersion: "pragma.example/v2" },
          "../escaped.json": {},
        },
        validateDocuments() {},
      }),
    ).rejects.toThrow("escapes its aggregate root");
    await expect(readFile(journalFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "..", "escaped.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("registers Runtime Session state with the same fail-closed version policy", async () => {
    const home = await temporaryRoot("pragma-runtime-session-future-");
    const paths = new PragmaPaths({ pragmaHome: home });
    const file = paths.ownedSystemSessionManifest("owner", "runtime-session");
    await mkdir(dirname(file), { recursive: true });
    await writeJson(file, {
      schemaVersion: "pragma.runtime-session/v4",
      owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
      systemSessionId: "runtime-session",
    });
    const before = await readFile(file, "utf8");

    await expect(readRuntimeSessionRecord(paths, "owner", "runtime-session")).rejects.toThrow(
      "unsupported-state-version",
    );

    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("upgrades Runtime Session v2 records with an empty context-window snapshot", async () => {
    const home = await temporaryRoot("pragma-runtime-session-v2-");
    const paths = new PragmaPaths({ pragmaHome: home });
    const file = paths.ownedSystemSessionManifest("owner", "runtime-session");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      await readFile(new URL("./fixtures/runtime-session-v2.json", import.meta.url)),
    );
    const matchingClaim = join(
      paths.runtimeSessionOwnersRoot(),
      `${encodePragmaPathSegment("runtime-session")}.json`,
    );
    const unrelatedClaim = join(paths.runtimeSessionOwnersRoot(), "unrelated.json");
    await mkdir(paths.runtimeSessionOwnersRoot(), { recursive: true });
    await Promise.all([
      writeJson(matchingClaim, {
        schemaVersion: "pragma.runtime-session-owner/v1",
        systemSessionId: "runtime-session",
        owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
      }),
      writeJson(unrelatedClaim, { systemSessionId: "unrelated" }),
    ]);

    const upgraded = await readRuntimeSessionRecord(paths, "owner", "runtime-session");
    expect(upgraded).toEqual(
      expect.objectContaining({ schemaVersion: "pragma.runtime-session/v3" }),
    );
    expect(upgraded).not.toHaveProperty("contextWindowUsage");
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(matchingClaim, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(unrelatedClaim, "utf8")).resolves.toContain("unrelated");
    await expect(
      readFile(join(paths.runtimeSessionsRoot(), "catalog.sqlite")),
    ).resolves.toBeInstanceOf(Buffer);
    const backup = await readFile(
      join(
        paths.archivesRoot(),
        "storage-migrations",
        "runtime-session-catalog-v1",
        "records.jsonl",
      ),
      "utf8",
    );
    expect(backup).toContain('\\"schemaVersion\\": \\"pragma.runtime-session/v2\\"');
    expect(backup).toContain('\\"schemaVersion\\": \\"pragma.runtime-session-owner/v1\\"');
  });

  it("rejects a legacy ownership claim that disagrees with its Session manifest", async () => {
    const home = await temporaryRoot("pragma-runtime-session-claim-mismatch-");
    const paths = new PragmaPaths({ pragmaHome: home });
    const fixture = await readFile(
      new URL("./fixtures/runtime-session-v2.json", import.meta.url),
      "utf8",
    );
    const manifest = paths.ownedSystemSessionManifest("owner", "runtime-session");
    const claim = join(
      paths.runtimeSessionOwnersRoot(),
      `${encodePragmaPathSegment("runtime-session")}.json`,
    );
    await mkdir(dirname(manifest), { recursive: true });
    await mkdir(dirname(claim), { recursive: true });
    await writeFile(manifest, fixture);
    await writeJson(claim, {
      schemaVersion: "pragma.runtime-session-owner/v1",
      systemSessionId: "runtime-session",
      owner: { type: "expert-session", ownerId: "different-owner", contextId: "context" },
    });

    await expect(readRuntimeSessionRecord(paths, "owner", "runtime-session")).rejects.toThrow(
      "unsupported-state-version",
    );
    await expect(readFile(manifest, "utf8")).resolves.toBe(fixture);
    await expect(readFile(claim, "utf8")).resolves.toContain("different-owner");
  });

  it("reads current Runtime Session context-window snapshots without rewriting them", async () => {
    const home = await temporaryRoot("pragma-runtime-session-v3-");
    const paths = new PragmaPaths({ pragmaHome: home });
    const file = paths.ownedSystemSessionManifest("owner", "runtime-session");
    await mkdir(dirname(file), { recursive: true });
    await writeJson(file, {
      schemaVersion: "pragma.runtime-session/v3",
      owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
      systemSessionId: "runtime-session",
      expertId: "expert",
      runtime: { id: "runtime", kind: "test" },
      runtimeSessionRef: { type: "test", id: "native-session" },
      contextWindowUsage: {
        usedTokens: 32_000,
        contextWindowTokens: 128_000,
        percent: 25,
        measurement: "estimated",
        observedAt: "2026-07-24T00:00:00.000Z",
      },
      currentWorkspace: "/workspace",
      workspaceHistory: ["/workspace"],
      processState: "stopped",
      retentionState: "retained",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    });
    await expect(
      readRuntimeSessionRecord(paths, "owner", "runtime-session"),
    ).resolves.toMatchObject({ contextWindowUsage: { usedTokens: 32_000, percent: 25 } });
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}
