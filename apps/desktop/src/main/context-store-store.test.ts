import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ContextStoreStoreError, createContextStoreStore } from "./context-store-store.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "pragma-context-stores-"));
  directories.push(directory);
  const configPath = join(directory, ".pragma", "context-stores.json");
  return { configPath, store: createContextStoreStore({ configPath }) };
}

describe("context store store", () => {
  it("persists a file store as a reusable configured source", async () => {
    const { configPath, store } = await createStore();

    const created = await store.create({
      type: "file",
      name: "Product documentation",
      description: "Central product docs and guides.",
      scope: "personal",
      source: { path: "/Users/alex/Workspace/acme/docs", updateBehavior: "watch" },
    });

    expect(created).toMatchObject({
      type: "file",
      status: "configured",
      source: { updateBehavior: "watch" },
    });
    await expect(store.list()).resolves.toEqual([created]);
    expect(await readFile(configPath, "utf8")).toContain("Product documentation");
  });

  it("persists context notes without using memory terminology", async () => {
    const { store } = await createStore();

    const created = await store.create({
      type: "note",
      name: "Review rules",
      description: "Rules for code review experts.",
      scope: "organization",
      entries: [
        {
          id: "240ac3d2-2dfa-46a6-b568-03f2a29c2bed",
          title: "Architecture",
          description: "Architecture rules for code review.",
          content: "Prefer clear boundaries over compatibility layers.",
          trigger: "always_on",
        },
      ],
    });

    expect(created).toMatchObject({ type: "note", status: "ready" });
    expect(JSON.stringify(created)).not.toMatch(/memory/i);
  });

  it("rejects corrupt persisted data", async () => {
    const { configPath, store } = await createStore();
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, "not-json", "utf8");

    await expect(store.list()).rejects.toMatchObject({
      code: "config_invalid",
    } satisfies Partial<ContextStoreStoreError>);
  });
});
