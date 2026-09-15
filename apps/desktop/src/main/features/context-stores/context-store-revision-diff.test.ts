import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContextStoreStore } from "./context-store-store.ts";
import { getContextStoreRevisionDiff } from "./context-store-revision-diff.ts";

const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("historical revision diff", () => {
  it("reads real persisted parent and target snapshots after subsequent edits and refuses unavailable history", async () => {
    const path = await mkdtemp(join(tmpdir(), "pragma-revision-diff-"));
    paths.push(path);
    const store = createContextStoreStore({ storesPath: join(path, "stores") });
    const created = await store.create({ mode: "blank", name: "Knowledge", description: "" });
    const file = await store.createFile(created.id, "guide.md", "Before");
    const updated = await store.updateFile(
      created.id,
      "guide.md",
      "After",
      { ...file.metadata, priority: "high" },
      file.revision!,
    );
    const target = await store.getSnapshot(created.id);
    const original = await getContextStoreRevisionDiff(store, {
      storeId: created.id,
      revision: target.revision,
    });
    expect(original.before.revision).toBe(target.revision - 1);
    expect(original.before.files[0]?.content).toBe("Before");
    expect(original.after.files[0]).toMatchObject({
      content: "After",
      metadata: { priority: "high" },
    });
    await store.updateFile(created.id, "guide.md", "Later", updated.metadata, updated.revision!);
    expect(
      await getContextStoreRevisionDiff(store, { storeId: created.id, revision: target.revision }),
    ).toEqual(original);
    const addition = await getContextStoreRevisionDiff(store, { storeId: created.id, revision: 2 });
    expect(addition.before.files).toEqual([]);
    expect(addition.after.files[0]?.content).toBe("Before");
    await store.createFolder(created.id, "empty");
    const folderRevision = await store.getSnapshot(created.id);
    const folderDiff = await getContextStoreRevisionDiff(store, {
      storeId: created.id,
      revision: folderRevision.revision,
    });
    expect(folderDiff.before.directories).not.toContain("empty");
    expect(folderDiff.after.directories).toContain("empty");
    await store.deleteEntry(created.id, "guide.md", "file");
    const deletionRevision = await store.getSnapshot(created.id);
    const deletion = await getContextStoreRevisionDiff(store, {
      storeId: created.id,
      revision: deletionRevision.revision,
    });
    expect(deletion.before.files[0]?.content).toBe("Later");
    expect(deletion.after.files).toEqual([]);
    await expect(
      getContextStoreRevisionDiff(store, { storeId: created.id, revision: 1 }),
    ).rejects.toThrow();
    await expect(
      getContextStoreRevisionDiff(store, { storeId: "../escape", revision: 2 }),
    ).rejects.toThrow();
    await expect(
      getContextStoreRevisionDiff(store, { storeId: created.id, revision: 999 }),
    ).rejects.toMatchObject({ code: "content_not_found" });
  });
});
