import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createContextStoreEditorDraftService } from "./context-store-editor-draft-service.ts";
import { createContextStoreStore } from "@pragma/local-host/deployment";
import { ContentAddressedStore } from "@pragma/core";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pragma-editor-draft-"));
  roots.push(root);
  const stores = createContextStoreStore({ storesPath: join(root, "stores") });
  const drafts = createContextStoreEditorDraftService({
    draftsPath: join(root, "state", "editor-drafts"),
    stores,
  });
  const store = await stores.create({ mode: "blank", name: "Draft", description: "" });
  return { stores, drafts, store };
}

describe("context store editor drafts", () => {
  it("browses and edits imported nested files whose snapshot omitted parent directories", async () => {
    const { stores, drafts } = await setup();
    const imported = await stores.createFromSnapshot({
      name: "Nested import",
      description: "",
      author: "import",
      summary: "Import nested content",
      files: [
        {
          id: "guides/nested/a.md",
          content: "Imported",
          metadata: { trigger: "manual", priority: "normal" },
        },
      ],
    });
    await expect(drafts.listEntries(imported.id, "")).resolves.toEqual([
      { id: "guides", kind: "directory" },
    ]);
    await expect(drafts.listEntries(imported.id, "guides")).resolves.toEqual([
      { id: "guides/nested", kind: "directory" },
    ]);
    await drafts.renameEntry(imported.id, "guides", "renamed", "directory");
    await expect(drafts.listEntries(imported.id, "")).resolves.toEqual([
      { id: "renamed", kind: "directory" },
    ]);
    await expect(drafts.getContent(imported.id, "renamed/nested/a.md")).resolves.toMatchObject({
      content: "Imported",
    });
    await drafts.deleteEntry(imported.id, "renamed", "directory");
    await expect(drafts.listEntries(imported.id, "")).resolves.toEqual([]);
    await drafts.commit(imported.id, (await drafts.get(imported.id))!.revision);
    await expect(drafts.listEntries(imported.id, "")).resolves.toEqual([]);
  });

  it("reads published snapshots rather than unpublished filesystem changes", async () => {
    const { stores, drafts, store } = await setup();
    await stores.createFile(store.id, "a.md", "Published");
    const root = await stores.filesPath(store.id);
    await writeFile(join(root, "a.md"), "Unpublished disk change");
    await writeFile(join(root, "unpublished.md"), "Not in the snapshot");
    await expect(drafts.getContent(store.id, "a.md")).resolves.toMatchObject({
      content: "Published",
    });
    expect((await drafts.listEntries(store.id, "")).map((entry) => entry.id)).toEqual(["a.md"]);
  });

  it("lists and reads sparse draft entries without restoring every base file", async () => {
    const { stores, drafts, store } = await setup();
    await stores.createFolder(store.id, "guides");
    await stores.createFile(store.id, "guides/base.md", "Base");
    await stores.createFolder(store.id, "hidden");
    await stores.createFile(store.id, "hidden/unopened.md", "Unopened");
    await drafts.createFile(store.id, "guides/draft.md", "Draft", {
      trigger: "manual",
      priority: "normal",
    });
    const fullSnapshot = vi
      .spyOn(stores, "getSnapshot")
      .mockRejectedValue(new Error("Unexpected full snapshot read"));
    const blobs = vi.spyOn(ContentAddressedStore.prototype, "readBlob");
    try {
      await expect(drafts.listEntries(store.id, "")).resolves.toEqual([
        { id: "guides", kind: "directory" },
        { id: "hidden", kind: "directory" },
      ]);
      expect(blobs).not.toHaveBeenCalled();
      expect((await drafts.listEntries(store.id, "guides")).map((entry) => entry.id)).toEqual([
        "guides/base.md",
        "guides/draft.md",
      ]);
      expect(blobs).toHaveBeenCalledTimes(1);
      await expect(drafts.getContent(store.id, "guides/base.md")).resolves.toMatchObject({
        content: "Base",
      });
      await expect(drafts.getContent(store.id, "guides/draft.md")).resolves.toMatchObject({
        content: "Draft",
      });
      expect(blobs).toHaveBeenCalledTimes(2);
      expect(fullSnapshot).not.toHaveBeenCalled();
    } finally {
      blobs.mockRestore();
      fullSnapshot.mockRestore();
    }
  });

  it("lists one directory at a time before and after staged edits, preserving revision conflicts", async () => {
    const { stores, drafts, store } = await setup();
    await stores.createFolder(store.id, "guides");
    await stores.createFolder(store.id, "guides/nested");
    await stores.createFile(store.id, "guides/a.md", "Original");
    await expect(drafts.listEntries(store.id, "")).resolves.toEqual([
      { id: "guides", kind: "directory" },
    ]);
    const original = await drafts.getContent(store.id, "guides/a.md");
    await drafts.updateFile(store.id, original.id, "Edited", original.metadata, original.revision!);
    await expect(
      drafts.updateFile(store.id, original.id, "Stale", original.metadata, original.revision!),
    ).rejects.toThrow("revision conflict");
    await drafts.createFile(store.id, "guides/nested/b.md", "Nested", original.metadata);
    await expect(drafts.listEntries(store.id, "guides")).resolves.toEqual([
      expect.objectContaining({ id: "guides/a.md", kind: "file" }),
      { id: "guides/nested", kind: "directory" },
    ]);
    await expect(drafts.listEntries(store.id, "guides/nested")).resolves.toEqual([
      expect.objectContaining({ id: "guides/nested/b.md", kind: "file" }),
    ]);
    await expect(drafts.getContent(store.id, original.id)).resolves.toMatchObject({
      content: "Edited",
    });
  });

  it("hides historical .git entries in the editor and rejects direct reads", async () => {
    const { stores, drafts, store } = await setup();
    const root = await stores.filesPath(store.id);
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "internal.md"), "# Internal\n");
    await stores.createFile(store.id, "visible.md", "# Visible\n");
    await drafts.createFile(store.id, "draft.md", "# Draft\n", {
      trigger: "manual",
      priority: "normal",
    });

    expect((await drafts.listEntries(store.id)).map((entry) => entry.id)).toEqual([
      "draft.md",
      "visible.md",
    ]);
    await expect(drafts.getContent(store.id, ".git/internal.md")).rejects.toThrow();
    await expect(
      drafts.createFile(store.id, ".git/new.md", "Hidden", {
        trigger: "manual",
        priority: "normal",
      }),
    ).rejects.toThrow();
  });

  it("backs up multiple edits without publishing and commits them as one revision", async () => {
    const { stores, drafts, store } = await setup();

    const first = await drafts.createFile(store.id, "a.md", "First", {
      trigger: "manual",
      priority: "normal",
    });
    await drafts.createFile(store.id, "b.md", "Second", {
      trigger: "always_on",
      priority: "high",
    });
    await drafts.updateFile(store.id, "a.md", "First revised", first.metadata, first.revision!);

    await expect(stores.history(store.id)).resolves.toHaveLength(1);
    await expect(drafts.listEntries(store.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "a.md", kind: "file" }),
        expect.objectContaining({ id: "b.md", kind: "file" }),
      ]),
    );

    const editorDraft = await drafts.get(store.id);
    expect(editorDraft?.overlay.files).toHaveLength(2);
    const committed = await drafts.commit(store.id, editorDraft!.revision);

    expect(committed.contentRevision).toBe(2);
    await expect(stores.history(store.id)).resolves.toEqual([
      expect.objectContaining({
        revision: 2,
        author: "user",
        parentRevision: 1,
        summary: "Manual save (2 changed entries).",
      }),
      expect.objectContaining({ revision: 1, parentRevision: null }),
    ]);
    await expect(stores.getContent(store.id, "a.md")).resolves.toMatchObject({
      content: "First revised",
    });
    await expect(drafts.get(store.id)).resolves.toBeUndefined();
  });

  it("restores and discards a persisted sparse draft without changing formal knowledge", async () => {
    const { stores, drafts, store } = await setup();
    await drafts.createFolder(store.id, "notes");
    await drafts.createFile(store.id, "notes/draft.md", "Unsaved", {
      trigger: "manual",
      priority: "normal",
    });

    const restored = createContextStoreEditorDraftService({
      draftsPath: join(roots[0]!, "state", "editor-drafts"),
      stores,
    });
    const editorDraft = await restored.get(store.id);
    await expect(restored.getContent(store.id, "notes/draft.md")).resolves.toMatchObject({
      content: "Unsaved",
    });
    await restored.discard(store.id, editorDraft!.revision);

    await expect(restored.get(store.id)).resolves.toBeUndefined();
    await expect(stores.listEntries(store.id)).resolves.toEqual([]);
    await expect(stores.history(store.id)).resolves.toHaveLength(1);
  });

  it("rebases non-overlapping formal changes before publishing", async () => {
    const { stores, drafts, store } = await setup();
    await drafts.createFile(store.id, "draft.md", "From editor", {
      trigger: "manual",
      priority: "normal",
    });
    await stores.createFile(store.id, "external.md", "From another writer");

    const editorDraft = await drafts.get(store.id);
    const committed = await drafts.commit(store.id, editorDraft!.revision);

    expect(committed.contentRevision).toBe(3);
    await expect(stores.getContent(store.id, "draft.md")).resolves.toMatchObject({
      content: "From editor",
    });
    await expect(stores.getContent(store.id, "external.md")).resolves.toMatchObject({
      content: "From another writer",
    });
  });

  it("retains the draft when the same file changed in the formal revision", async () => {
    const { stores, drafts, store } = await setup();
    const original = await stores.createFile(store.id, "shared.md", "Original");
    const editorCopy = await drafts.getContent(store.id, "shared.md");
    await drafts.updateFile(
      store.id,
      "shared.md",
      "Editor change",
      editorCopy.metadata,
      editorCopy.revision!,
    );
    await stores.updateFile(
      store.id,
      "shared.md",
      "External change",
      original.metadata,
      original.revision!,
    );

    const editorDraft = await drafts.get(store.id);
    await expect(drafts.commit(store.id, editorDraft!.revision)).rejects.toThrow(
      "Knowledge draft conflicts with newer changes: shared.md",
    );
    await expect(drafts.get(store.id)).resolves.toMatchObject({ revision: editorDraft!.revision });
    await expect(stores.getContent(store.id, "shared.md")).resolves.toMatchObject({
      content: "External change",
    });
  });
});
