import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
      schemaVersion: "pragma.context-store/v2",
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
      schemaVersion: "pragma.context-store/v2",
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
      expect.objectContaining({ schemaVersion: "pragma.context-store/v2" }),
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
      expect.objectContaining({ id, schemaVersion: "pragma.context-store/v2" }),
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
});
