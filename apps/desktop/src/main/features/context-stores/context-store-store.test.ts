import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createContextStoreStore } from "./context-store-store.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createStore(isReferenced?: (storeId: string) => Promise<boolean>) {
  const directory = await mkdtemp(join(tmpdir(), "pragma-context-stores-"));
  directories.push(directory);
  const storesPath = join(directory, ".pragma", "data", "context-stores");
  return {
    directory,
    storesPath,
    store: createContextStoreStore({ storesPath, isReferenced }),
  };
}

describe("managed context store", () => {
  it("creates an empty managed Markdown knowledge base", async () => {
    const { storesPath, store } = await createStore();

    const created = await store.create({
      mode: "blank",
      name: "Product documentation",
      description: "Central product docs and guides.",
    });

    expect(created).toMatchObject({
      schemaVersion: "pragma.context-store/v4",
      type: "file",
      status: "ready",
      source: { origin: "created" },
    });
    await expect(stat(join(storesPath, created.id, "files"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(store.list()).resolves.toEqual([created]);
  });

  it("copies only Markdown files and becomes independent from the source", async () => {
    const { directory, storesPath, store } = await createStore();
    const source = join(directory, "source");
    await mkdir(join(source, "guides"), { recursive: true });
    await writeFile(join(source, "README.md"), "# Original\n", "utf8");
    await writeFile(join(source, "guides", "review.md"), "Review boundaries.\n", "utf8");
    await writeFile(join(source, "ignored.txt"), "Ignored", "utf8");

    await expect(store.inspectImport(source)).resolves.toMatchObject({
      markdownFiles: 2,
      ignoredFiles: 1,
    });
    const created = await store.create({
      mode: "import",
      name: "Imported docs",
      description: "",
      sourcePath: source,
    });

    expect(created.source.origin).toBe("copied");
    await writeFile(join(source, "README.md"), "# Changed outside\n", "utf8");
    await expect(
      readFile(join(storesPath, created.id, "files", "README.md"), "utf8"),
    ).resolves.toBe("# Original\n");
    await expect(
      readFile(join(storesPath, created.id, "files", "ignored.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("upgrades valid v2 metadata and leaves over-limit v2 data untouched", async () => {
    const { storesPath, store } = await createStore();
    const validId = "00000000-0000-4000-8000-000000000011";
    const invalidId = "00000000-0000-4000-8000-000000000012";
    const legacy = (id: string, name: string) => ({
      schemaVersion: "pragma.context-store/v2",
      id,
      name,
      description: "Legacy description",
      type: "file",
      status: "ready",
      source: { origin: "created" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    for (const [id, name] of [
      [validId, "Legacy knowledge"],
      [invalidId, "x".repeat(51)],
    ] as const) {
      await mkdir(join(storesPath, id, "files"), { recursive: true });
      await writeFile(join(storesPath, id, "store.json"), JSON.stringify(legacy(id, name)));
    }

    await expect(store.listEntries(validId)).resolves.toEqual([]);
    await expect(readFile(join(storesPath, validId, "store.json"), "utf8")).resolves.toContain(
      "pragma.context-store/v4",
    );
    await expect(store.listEntries(invalidId)).rejects.toMatchObject({
      code: "config_invalid",
      message: expect.stringContaining("name"),
    });
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ id: validId, schemaVersion: "pragma.context-store/v4" }),
    ]);
    await expect(readFile(join(storesPath, invalidId, "store.json"), "utf8")).resolves.toContain(
      "pragma.context-store/v2",
    );
  });

  it("replays an interrupted v2 metadata migration and rejects future schemas", async () => {
    const { storesPath, store } = await createStore();
    const created = await store.create({ mode: "blank", name: "Recovery", description: "Test" });
    const root = join(storesPath, created.id);
    const {
      contentRevision: _contentRevision,
      snapshotHash: _snapshotHash,
      ...withoutRevision
    } = created;
    void _contentRevision;
    void _snapshotHash;
    const legacy = { ...withoutRevision, schemaVersion: "pragma.context-store/v2" };
    const targetManifest = { ...withoutRevision, schemaVersion: "pragma.context-store/v3" };
    await writeFile(join(root, "store.json"), JSON.stringify(legacy));
    await writeFile(
      join(root, "v2-to-v3.json"),
      JSON.stringify({
        schemaVersion: "pragma.context-store-metadata-migration/v1",
        storeId: created.id,
        sourceSchema: "pragma.context-store/v2",
        targetSchema: "pragma.context-store/v3",
        targetManifest,
      }),
    );

    await expect(store.listEntries(created.id)).resolves.toEqual([]);
    await expect(readFile(join(root, "v2-to-v3.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeFile(
      join(root, "store.json"),
      JSON.stringify({ ...created, schemaVersion: "pragma.context-store/v99" }),
    );
    await expect(store.listEntries(created.id)).rejects.toMatchObject({ code: "config_invalid" });
    await expect(readFile(join(root, "store.json"), "utf8")).resolves.toContain(
      "pragma.context-store/v99",
    );
  });

  it("upgrades a historical v3 fixture with non-portable legacy names and replays its journal", async () => {
    const { storesPath, store } = await createStore();
    const id = "00000000-0000-4000-8000-000000000031";
    const root = join(storesPath, id);
    const fixture = new URL("./fixtures/context-store-v3/", import.meta.url);
    await mkdir(storesPath, { recursive: true });
    await cp(fixture, root, { recursive: true });

    const migrated = await store.getSnapshot(id);
    expect(migrated.files).toEqual([expect.objectContaining({ id: "Architecture Notes.md" })]);
    const legacy = JSON.parse(
      await readFile(join(root, "migration-backups", "store.v3.json"), "utf8"),
    );
    expect(legacy).toMatchObject({ schemaVersion: "pragma.context-store/v3", id });

    const targetManifest = JSON.parse(await readFile(join(root, "store.json"), "utf8"));
    const snapshot = JSON.parse(
      await readFile(join(root, "revisions", "00000001", "snapshot.json"), "utf8"),
    );
    const record = JSON.parse(
      await readFile(join(root, "revisions", "00000001", "record.json"), "utf8"),
    );
    await writeFile(join(root, "store.json"), JSON.stringify(legacy), "utf8");
    await rm(join(root, "revisions"), { recursive: true });
    await writeFile(
      join(root, "v3-to-v4.json"),
      JSON.stringify({
        schemaVersion: "pragma.context-store-v4-migration/v1",
        storeId: id,
        sourceSchema: "pragma.context-store/v3",
        targetSchema: "pragma.context-store/v4",
        targetManifest,
        snapshot,
        record,
      }),
      "utf8",
    );

    const recovered = createContextStoreStore({ storesPath });
    await expect(recovered.getSnapshot(id)).resolves.toMatchObject({
      revision: 1,
      snapshotHash: snapshot.snapshotHash,
    });
    await expect(readFile(join(root, "v3-to-v4.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(recovered.history(id)).resolves.toHaveLength(1);
  });

  it("creates, edits, renames, lists, and deletes managed entries", async () => {
    const { storesPath, store } = await createStore();
    const created = await store.create({
      mode: "blank",
      name: "Review rules",
      description: "",
    });

    await store.createFolder(created.id, "guides");
    await store.createFolder(created.id, "guides/nested/deep");
    await expect(
      stat(join(storesPath, created.id, "files", "guides", "nested", "deep")),
    ).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(store.createFolder(created.id, "guides/nested/deep")).rejects.toMatchObject({
      code: "content_exists",
    });
    const file = await store.createFile(created.id, "guides/review.md", "Initial", {
      description: "Review guidance",
      trigger: "manual",
      priority: "normal",
    });
    expect(file.revision).toEqual(expect.any(String));
    await expect(store.listEntries(created.id)).resolves.toEqual([
      { id: "guides", kind: "directory" },
      { id: "guides/nested", kind: "directory" },
      { id: "guides/nested/deep", kind: "directory" },
      expect.objectContaining({ id: "guides/review.md", kind: "file" }),
    ]);

    const updated = await store.updateFile(
      created.id,
      "guides/review.md",
      "Updated",
      { description: "Review guidance", trigger: "model_decision", priority: "high" },
      file.revision!,
    );
    expect(updated).toMatchObject({
      content: "Updated",
      metadata: { trigger: "model_decision", priority: "high" },
    });
    await expect(
      store.updateFile(created.id, "guides/review.md", "Stale", updated.metadata, file.revision!),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    await store.renameEntry(created.id, "guides/review.md", "guides/architecture.md", "file");
    await expect(store.getContent(created.id, "guides/architecture.md")).resolves.toMatchObject({
      content: "Updated",
    });
    await store.deleteEntry(created.id, "guides/architecture.md", "file");
    await expect(
      readFile(join(storesPath, created.id, "files", "guides", "architecture.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates a v1 file store by copying its source into managed storage", async () => {
    const { directory, storesPath, store } = await createStore();
    const source = join(directory, "legacy-source");
    const id = "00000000-0000-4000-8000-000000000001";
    await mkdir(join(storesPath, id), { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "legacy.md"), "Legacy content", "utf8");
    await writeFile(
      join(storesPath, id, "store.json"),
      JSON.stringify({
        schemaVersion: "pragma.context-store/v1",
        id,
        name: "Legacy files",
        description: "",
        type: "file",
        status: "configured",
        source: { path: source, updateBehavior: "watch" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const [migrated] = await store.list();
    expect(migrated).toMatchObject({
      schemaVersion: "pragma.context-store/v4",
      source: { origin: "migrated" },
    });
    await expect(readFile(join(storesPath, id, "files", "legacy.md"), "utf8")).resolves.toBe(
      "Legacy content",
    );
    await expect(readFile(join(source, "legacy.md"), "utf8")).resolves.toBe("Legacy content");
  });

  it("replays a v1 migration after managed files were installed", async () => {
    const { storesPath, store } = await createStore();
    const id = "00000000-0000-4000-8000-000000000003";
    const root = join(storesPath, id);
    await mkdir(join(root, "files"), { recursive: true });
    await writeFile(join(root, "files", "recovered.md"), "Recovered", "utf8");
    await writeFile(
      join(root, "store.json"),
      JSON.stringify({
        schemaVersion: "pragma.context-store/v1",
        id,
        name: "Interrupted migration",
        description: "",
        type: "file",
        status: "configured",
        source: { path: join(root, "missing-source"), updateBehavior: "watch" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await writeFile(
      join(root, "v1-to-v2.json"),
      JSON.stringify({
        schemaVersion: "pragma.context-store-migration/v1",
        storeId: id,
        sourceSchema: "pragma.context-store/v1",
        targetSchema: "pragma.context-store/v2",
        sourcePath: join(root, "missing-source"),
        temporaryFiles: join(root, ".files.interrupted.migration"),
        targetManifest: {
          schemaVersion: "pragma.context-store/v2",
          id,
          name: "Interrupted migration",
          description: "",
          type: "file",
          status: "ready",
          source: { origin: "migrated" },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-07-27T00:00:00.000Z",
        },
      }),
    );
    await writeFile(
      join(root, "files", ".pragma-migration-ready.json"),
      JSON.stringify({
        schemaVersion: "pragma.context-store-migration-ready/v1",
        storeId: id,
      }),
    );

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ schemaVersion: "pragma.context-store/v4" }),
    ]);
    await expect(store.getContent(id, "recovered.md")).resolves.toMatchObject({
      content: "Recovered",
    });
    await expect(readFile(join(root, "v1-to-v2.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("replays a staged v1 migration without reading the source again", async () => {
    const { storesPath, store } = await createStore();
    const id = "00000000-0000-4000-8000-000000000004";
    const root = join(storesPath, id);
    const temporaryFiles = join(root, ".files.recoverable.migration");
    const missingSource = join(root, "source-was-removed");
    await mkdir(temporaryFiles, { recursive: true });
    await writeFile(join(temporaryFiles, "staged.md"), "Staged content", "utf8");
    await writeFile(
      join(temporaryFiles, ".pragma-migration-ready.json"),
      JSON.stringify({
        schemaVersion: "pragma.context-store-migration-ready/v1",
        storeId: id,
      }),
    );
    await writeFile(
      join(root, "store.json"),
      JSON.stringify({
        schemaVersion: "pragma.context-store/v1",
        id,
        name: "Staged migration",
        description: "",
        type: "file",
        source: { path: missingSource, updateBehavior: "watch" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await writeFile(
      join(root, "v1-to-v2.json"),
      JSON.stringify({
        schemaVersion: "pragma.context-store-migration/v1",
        storeId: id,
        sourceSchema: "pragma.context-store/v1",
        targetSchema: "pragma.context-store/v2",
        sourcePath: missingSource,
        temporaryFiles,
        targetManifest: {
          schemaVersion: "pragma.context-store/v2",
          id,
          name: "Staged migration",
          description: "",
          type: "file",
          status: "ready",
          source: { origin: "migrated" },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-07-27T00:00:00.000Z",
        },
      }),
    );

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ id, schemaVersion: "pragma.context-store/v4" }),
    ]);
    await expect(store.getContent(id, "staged.md")).resolves.toMatchObject({
      content: "Staged content",
    });
  });

  it("leaves unsupported v1 note data untouched and omits it from the catalog", async () => {
    const { storesPath, store } = await createStore();
    const id = "00000000-0000-4000-8000-000000000002";
    const notePath = join(storesPath, id);
    await mkdir(notePath, { recursive: true });
    await writeFile(
      join(notePath, "store.json"),
      JSON.stringify({
        schemaVersion: "pragma.context-store/v1",
        id,
        name: "Legacy notes",
        description: "",
        type: "note",
        status: "ready",
        entries: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await writeFile(join(notePath, "contexts.json"), '{"items":[]}', "utf8");

    await expect(store.list()).resolves.toEqual([]);
    await expect(readFile(join(notePath, "contexts.json"), "utf8")).resolves.toBe('{"items":[]}');
  });

  it("isolates a failed legacy migration without hiding healthy knowledge bases", async () => {
    const { storesPath, store } = await createStore();
    const healthy = await store.create({ mode: "blank", name: "Healthy", description: "" });
    const id = "00000000-0000-4000-8000-000000000005";
    await mkdir(join(storesPath, id), { recursive: true });
    await writeFile(
      join(storesPath, id, "store.json"),
      JSON.stringify({
        schemaVersion: "pragma.context-store/v1",
        id,
        name: "Missing source",
        description: "",
        type: "file",
        source: {
          path: join(storesPath, id, "deleted-source"),
          updateBehavior: "watch",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const listed = await store.list();
    expect(listed).toEqual([
      expect.objectContaining({ id: healthy.id, status: "ready" }),
      expect.objectContaining({ id, status: "needs_attention" }),
    ]);
    await expect(store.remove(id)).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ id: healthy.id, status: "ready" }),
    ]);
  });

  it("blocks deletion while a knowledge base is mounted", async () => {
    const referenced = new Set<string>();
    const { storesPath, store } = await createStore(async (storeId) => referenced.has(storeId));
    const created = await store.create({ mode: "blank", name: "Mounted", description: "" });
    referenced.add(created.id);

    await expect(store.remove(created.id)).rejects.toMatchObject({ code: "store_referenced" });
    referenced.clear();
    await expect(store.remove(created.id)).resolves.toBeUndefined();
    await expect(
      readFile(join(storesPath, created.id, "store.json"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects traversal and non-Markdown entries", async () => {
    const { storesPath, store } = await createStore();
    const created = await store.create({ mode: "blank", name: "Safe", description: "" });

    await expect(store.createFile(created.id, "../escape.md", "", undefined)).rejects.toMatchObject(
      {
        code: "invalid_entry",
      },
    );
    await expect(store.createFile(created.id, "notes.txt", "", undefined)).rejects.toMatchObject({
      code: "invalid_entry",
    });
    await expect(store.createFolder(created.id, "two words")).rejects.toMatchObject({
      code: "invalid_entry",
    });
    await expect(
      store.createFile(created.id, `${"a".repeat(101)}.md`, "", undefined),
    ).rejects.toMatchObject({ code: "invalid_entry" });
    await expect(store.createFile(created.id, "CON.md", "", undefined)).rejects.toMatchObject({
      code: "invalid_entry",
    });
    await expect(
      store.createFile(created.id, "C:\\outside.md", "", undefined),
    ).rejects.toMatchObject({
      code: "invalid_entry",
    });
    await expect(
      store.createFile(created.id, "\\\\server\\share\\outside.md", "", undefined),
    ).rejects.toMatchObject({
      code: "invalid_entry",
    });
    const outside = join(storesPath, "outside");
    await mkdir(outside);
    await symlink(outside, join(storesPath, created.id, "files", "linked"));
    await expect(store.createFolder(created.id, "linked/nested")).rejects.toMatchObject({
      code: "invalid_entry",
    });
  });

  it("refuses to open oversized files as truncated editable content", async () => {
    const { storesPath, store } = await createStore();
    const created = await store.create({ mode: "blank", name: "Large", description: "" });
    await writeFile(
      join(storesPath, created.id, "files", "large.md"),
      "x".repeat(1_000_001),
      "utf8",
    );

    await expect(store.getContent(created.id, "large.md")).rejects.toMatchObject({
      code: "source_unavailable",
    });
  });

  it("keeps the binding stable while runtime reads observe the latest files", async () => {
    const { store } = await createStore();
    const created = await store.create({ mode: "blank", name: "Live", description: "" });
    const before = await store.resolve(created.id);
    const file = await store.createFile(created.id, "live.md", "First");
    const afterCreate = await store.resolve(created.id);
    await store.updateFile(created.id, "live.md", "Latest", file.metadata, file.revision!);
    const afterUpdate = await store.resolve(created.id);

    expect(afterCreate.revision).toBe(before.revision);
    expect(afterUpdate.revision).toBe(before.revision);
    await expect(afterUpdate.store.readContext({ id: "live.md" })).resolves.toMatchObject({
      ok: true,
      value: expect.objectContaining({ content: "Latest" }),
    });
  });

  it("records user edits and atomically applies agent changesets with snapshot CAS", async () => {
    const { store } = await createStore();
    const created = await store.createFromSnapshot({
      name: "Memory knowledge",
      description: "Progressively disclosed guidance.",
      author: "memory-initialization",
      summary: "Initialize Memory knowledge.",
      files: [
        {
          id: "guide.md",
          content: "# Guide\n",
          metadata: { description: "Guide", trigger: "always_on", priority: "critical" },
        },
      ],
    });
    const original = await store.getSnapshot(created.id);
    const added = await store.createFile(created.id, "overview.md", "# Overview\n");
    const afterUserEdit = await store.getSnapshot(created.id);

    expect(afterUserEdit.revision).toBe(2);
    await expect(store.history(created.id)).resolves.toEqual([
      expect.objectContaining({ revision: 2, author: "user", parentRevision: 1 }),
      expect.objectContaining({
        revision: 1,
        author: "memory-initialization",
        parentRevision: null,
      }),
    ]);

    await expect(
      store.applyChangeSet(
        {
          schemaVersion: "pragma.context-store-change-set/v1",
          storeId: created.id,
          baseRevision: original.revision,
          baseSnapshotHash: original.snapshotHash,
          summary: "Stale change.",
          operations: [{ operation: "delete", id: "guide.md" }],
        },
        "store-revision-agent",
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    const revised = await store.applyChangeSet(
      {
        schemaVersion: "pragma.context-store-change-set/v1",
        storeId: created.id,
        baseRevision: afterUserEdit.revision,
        baseSnapshotHash: afterUserEdit.snapshotHash,
        summary: "Refine overview.",
        operations: [
          {
            operation: "upsert",
            id: "overview.md",
            content: "# Revised overview\n",
            metadata: added.metadata,
          },
        ],
      },
      "store-revision-agent",
    );

    expect(revised.contentRevision).toBe(3);
    await expect(store.getContent(created.id, "overview.md")).resolves.toMatchObject({
      content: "# Revised overview\n",
    });
    await expect(store.history(created.id)).resolves.toEqual([
      expect.objectContaining({ revision: 3, author: "store-revision-agent", parentRevision: 2 }),
      expect.objectContaining({ revision: 2, author: "user", parentRevision: 1 }),
      expect.objectContaining({
        revision: 1,
        author: "memory-initialization",
        parentRevision: null,
      }),
    ]);
  });

  it("preserves empty directories when an agent revision replaces the live tree", async () => {
    const { store } = await createStore();
    const created = await store.create({ mode: "blank", name: "Folders", description: "" });
    await store.createFolder(created.id, "items/empty");
    const base = await store.getSnapshot(created.id);

    await store.applyChangeSet(
      {
        schemaVersion: "pragma.context-store-change-set/v1",
        storeId: created.id,
        baseRevision: base.revision,
        baseSnapshotHash: base.snapshotHash,
        summary: "Add detail",
        operations: [
          {
            operation: "upsert",
            id: "items/detail.md",
            content: "# Detail\n",
            metadata: { description: "Detail", trigger: "manual", priority: "normal" },
          },
        ],
      },
      "store-revision-agent",
    );

    await expect(store.listEntries(created.id)).resolves.toEqual(
      expect.arrayContaining([{ id: "items/empty", kind: "directory" }]),
    );
  });

  it("serializes user edits with agent revisions without losing the user write", async () => {
    const { store } = await createStore();
    const created = await store.create({ mode: "blank", name: "Concurrent", description: "" });
    const base = await store.getSnapshot(created.id);
    const [userResult, agentResult] = await Promise.allSettled([
      store.createFile(created.id, "user.md", "# User\n"),
      store.applyChangeSet(
        {
          schemaVersion: "pragma.context-store-change-set/v1",
          storeId: created.id,
          baseRevision: base.revision,
          baseSnapshotHash: base.snapshotHash,
          summary: "Agent edit",
          operations: [
            {
              operation: "upsert",
              id: "agent.md",
              content: "# Agent\n",
              metadata: { description: "Agent", trigger: "manual", priority: "normal" },
            },
          ],
        },
        "store-revision-agent",
      ),
    ]);

    expect(userResult.status).toBe("fulfilled");
    await expect(store.getContent(created.id, "user.md")).resolves.toBeDefined();
    if (agentResult.status === "rejected") {
      expect(agentResult.reason).toMatchObject({ code: "revision_conflict" });
    } else {
      await expect(store.getContent(created.id, "agent.md")).resolves.toBeDefined();
    }
  });

  it("refuses to delete a Store with active revision tasks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-context-store-active-revision-"));
    directories.push(directory);
    const storesPath = join(directory, "stores");
    const store = createContextStoreStore({
      storesPath,
      hasActiveRevisions: async () => true,
    });
    const created = await store.create({ mode: "blank", name: "Active", description: "" });

    await expect(store.remove(created.id)).rejects.toMatchObject({ code: "store_referenced" });
    await expect(stat(join(storesPath, created.id))).resolves.toBeDefined();
  });

  it("rejects a persisted snapshot whose declared hash was tampered with", async () => {
    const { storesPath, store } = await createStore();
    const created = await store.create({ mode: "blank", name: "Integrity", description: "" });
    const path = join(storesPath, created.id, "revisions", "00000001", "snapshot.json");
    const snapshot = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...snapshot, snapshotHash: "0".repeat(64) }), "utf8");

    await expect(store.getSnapshot(created.id, 1)).rejects.toMatchObject({
      code: "config_invalid",
    });
  });
});
