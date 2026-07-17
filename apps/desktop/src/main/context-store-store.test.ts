import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ContextStoreStoreError, createContextStoreStore } from "./context-store-store.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "pragma-context-stores-"));
  directories.push(directory);
  const storesPath = join(directory, ".pragma", "context-stores");
  return { directory, storesPath, store: createContextStoreStore({ storesPath }) };
}

describe("context store store", () => {
  it("persists a file store as a reusable configured source", async () => {
    const { storesPath, store } = await createStore();

    const created = await store.create({
      type: "file",
      name: "Product documentation",
      description: "Central product docs and guides.",
      source: { path: "/Users/alex/Workspace/acme/docs", updateBehavior: "watch" },
    });

    expect(created).toMatchObject({
      type: "file",
      status: "configured",
      source: { updateBehavior: "watch" },
    });
    await expect(store.list()).resolves.toEqual([created]);
    expect(await readFile(join(storesPath, created.id, "store.json"), "utf8")).toContain(
      "Product documentation",
    );
  });

  it("persists context notes without using memory terminology", async () => {
    const { storesPath, store } = await createStore();

    const created = await store.create({
      type: "note",
      name: "Review rules",
      description: "Rules for code review experts.",
    });
    const bindingBefore = await store.resolve(created.id);

    const updated = await store.addNoteEntry(created.id, {
      id: "architecture",
      description: "Architecture rules for code review.",
      content: "Prefer clear boundaries over compatibility layers.",
      trigger: "always_on",
    });

    expect(updated).toMatchObject({ type: "note", status: "ready" });
    expect(updated.type === "note" ? updated.entries : []).toHaveLength(1);
    expect((await store.resolve(created.id)).revision).toBe(bindingBefore.revision);
    expect(JSON.stringify(updated)).not.toMatch(/memory/i);
    expect(
      JSON.parse(await readFile(join(storesPath, created.id, "contexts.json"), "utf8")),
    ).toMatchObject({
      schemaVersion: "pragma.context-json-store/v1",
      items: [{ id: "architecture", metadata: { trigger: "always_on" } }],
    });
    await expect(
      store.addNoteEntry(created.id, {
        id: "architecture",
        description: "Duplicate",
        content: "Duplicate",
        trigger: "manual",
      }),
    ).rejects.toMatchObject({ code: "entry_exists" });

    await expect(store.listContents(created.id)).resolves.toEqual([
      {
        id: "architecture",
        metadata: {
          description: "Architecture rules for code review.",
          trigger: "always_on",
          priority: "normal",
        },
        revision: expect.any(String),
        sizeBytes: 50,
      },
    ]);
    await expect(store.getContent(created.id, "architecture")).resolves.toMatchObject({
      id: "architecture",
      content: "Prefer clear boundaries over compatibility layers.",
      truncated: false,
    });
  });

  it("lists file content metadata and reads selected content", async () => {
    const { directory, store } = await createStore();
    const sourcePath = join(directory, "docs");
    await mkdir(join(sourcePath, "guides"), { recursive: true });
    await writeFile(
      join(sourcePath, "guides", "review.md"),
      [
        "---",
        "description: Review guidance",
        "trigger: model_decision",
        "trustLevel: workspace",
        "sensitivity: internal",
        "priority: high",
        "---",
        "Review the architecture boundaries.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(sourcePath, "ignored.txt"), "Not indexed", "utf8");
    const created = await store.create({
      type: "file",
      name: "Product documentation",
      description: "Central product docs and guides.",
      source: { path: sourcePath, updateBehavior: "watch" },
    });

    await expect(store.listContents(created.id)).resolves.toEqual([
      expect.objectContaining({
        id: "guides/review.md",
        metadata: {
          description: "Review guidance",
          trigger: "model_decision",
          trustLevel: "workspace",
          sensitivity: "internal",
          priority: "high",
        },
      }),
    ]);
    await expect(store.getContent(created.id, "guides/review.md")).resolves.toMatchObject({
      id: "guides/review.md",
      content: "Review the architecture boundaries.",
      truncated: false,
    });
  });

  it("atomically migrates legacy note entries, including an empty legacy directory", async () => {
    const { storesPath, store } = await createStore();
    const populated = await store.create({
      type: "note",
      name: "Legacy notes",
      description: "Migrated notes.",
    });
    const populatedPath = join(storesPath, populated.id);
    await rm(join(populatedPath, "contexts.json"));
    await mkdir(join(populatedPath, "entries"));
    await writeFile(
      join(populatedPath, "entries", "rule.json"),
      JSON.stringify({
        id: "rule",
        description: "Legacy rule",
        content: "Keep this.",
        trigger: "manual",
      }),
    );

    await expect(store.getContent(populated.id, "rule")).resolves.toMatchObject({
      content: "Keep this.",
    });
    await expect(readFile(join(populatedPath, "contexts.json"), "utf8")).resolves.toContain(
      '"rule"',
    );
    await expect(
      readFile(join(populatedPath, "entries", "rule.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const empty = await store.create({
      type: "note",
      name: "Empty legacy notes",
      description: "Migrated empty notes.",
    });
    const emptyPath = join(storesPath, empty.id);
    await rm(join(emptyPath, "contexts.json"));
    await mkdir(join(emptyPath, "entries"));
    await expect(store.listContents(empty.id)).resolves.toEqual([]);
    await expect(readFile(join(emptyPath, "contexts.json"), "utf8")).resolves.toContain(
      '"items": []',
    );
  });

  it("rejects corrupt persisted data", async () => {
    const { storesPath, store } = await createStore();
    const storePath = join(storesPath, "broken-store");
    await mkdir(storePath, { recursive: true });
    await writeFile(join(storePath, "store.json"), "not-json", "utf8");

    await expect(store.list()).rejects.toMatchObject({
      code: "config_invalid",
    } satisfies Partial<ContextStoreStoreError>);
  });

  it("leaves all legacy note data untouched when migration validation fails", async () => {
    const { storesPath, store } = await createStore();
    const created = await store.create({
      type: "note",
      name: "Broken legacy notes",
      description: "Must not be partially migrated.",
    });
    const path = join(storesPath, created.id);
    await rm(join(path, "contexts.json"));
    await mkdir(join(path, "entries"));
    await writeFile(join(path, "entries", "broken.json"), "{broken");

    await expect(store.listContents(created.id)).rejects.toMatchObject({ code: "config_invalid" });
    await expect(readFile(join(path, "entries", "broken.json"), "utf8")).resolves.toBe("{broken");
    await expect(readFile(join(path, "contexts.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
