import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createContextStoreEditorDraftService } from "./context-store-editor-draft-service.ts";
import { createContextStoreStore } from "./context-store-store.ts";

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
