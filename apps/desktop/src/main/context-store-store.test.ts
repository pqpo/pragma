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
  return { storesPath, store: createContextStoreStore({ storesPath }) };
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

    const updated = await store.addNoteEntry(created.id, {
      id: "architecture",
      description: "Architecture rules for code review.",
      content: "Prefer clear boundaries over compatibility layers.",
      trigger: "always_on",
    });

    expect(updated).toMatchObject({ type: "note", status: "ready" });
    expect(updated.type === "note" ? updated.entries : []).toHaveLength(1);
    expect(JSON.stringify(updated)).not.toMatch(/memory/i);
    expect(
      JSON.parse(
        await readFile(join(storesPath, created.id, "entries", "architecture.json"), "utf8"),
      ),
    ).toMatchObject({ id: "architecture", trigger: "always_on" });
    await expect(
      store.addNoteEntry(created.id, {
        id: "architecture",
        description: "Duplicate",
        content: "Duplicate",
        trigger: "manual",
      }),
    ).rejects.toMatchObject({ code: "entry_exists" });
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
});
