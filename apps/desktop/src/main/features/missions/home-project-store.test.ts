import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createHomeProjectStore } from "./home-project-store.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pragma-home-projects-"));
  directories.push(root);
  const path = join(root, "home-projects.json");
  return { path, store: createHomeProjectStore(path) };
}
const input = {
  name: "产品设计",
  executorRef: "team:0000000000000001",
  contextStoreIds: ["11111111-1111-4111-8111-111111111111"],
  workspace: { path: "/work/product", basename: "product" },
};

describe("Home project persistence", () => {
  it("preserves bindings across restart, edit, and independent deletion", async () => {
    const { path, store } = await setup();
    expect(await store.list()).toEqual([]);
    const first = await store.save(input);
    const second = await store.save({
      ...input,
      name: "另一个项目",
      executorRef: "flow:0000000000000002",
      contextStoreIds: [],
    });
    const reopened = createHomeProjectStore(path);
    expect(await reopened.list()).toEqual([first, second]);
    const edited = await reopened.save({
      ...first,
      name: "改名",
      executorRef: "expert:0000000000000003",
    });
    await reopened.delete(second.id);
    expect(await store.list()).toEqual([edited]);
    await expect(store.save(second)).rejects.toThrow("no longer exists");
  });
  it("serializes concurrent writers without losing projects", async () => {
    const { path, store } = await setup();
    await Promise.all([
      store.save(input),
      createHomeProjectStore(path).save({ ...input, name: "并发项目" }),
    ]);
    expect(await store.list()).toHaveLength(2);
  });
  it("persists a complete project order and rejects stale or incomplete orders", async () => {
    const { path, store } = await setup();
    const first = await store.save(input);
    const second = await store.save({ ...input, name: "另一个项目" });
    const third = await store.save({ ...input, name: "第三个项目" });

    await expect(store.reorder([third.id, first.id, second.id])).resolves.toEqual([
      third,
      first,
      second,
    ]);
    await expect(createHomeProjectStore(path).list()).resolves.toEqual([third, first, second]);
    await expect(store.reorder([first.id, second.id])).rejects.toThrow("every current project");
    await expect(
      store.reorder([first.id, second.id, "00000000-0000-4000-8000-000000000099"]),
    ).rejects.toThrow("every current project");
    await expect(store.list()).resolves.toEqual([third, first, second]);
  });
  it("rejects duplicate or malformed project IDs without changing the saved order", async () => {
    const { store } = await setup();
    const first = await store.save(input);
    const second = await store.save({ ...input, name: "另一个项目" });

    await expect(store.reorder([first.id, first.id])).rejects.toThrow();
    await expect(store.reorder([first.id, "invalid"])).rejects.toThrow();
    await expect(store.list()).resolves.toEqual([first, second]);
  });
  it("refuses malformed or future data and preserves the original file", async () => {
    const { path, store } = await setup();
    for (const raw of [
      "{broken",
      JSON.stringify({ schemaVersion: "pragma.desktop-home-projects/v2", projects: [] }),
    ]) {
      await writeFile(path, raw);
      await expect(store.list()).rejects.toThrow();
      await expect(store.save(input)).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(raw);
    }
  });
  it("rejects invalid refs, duplicate knowledge bindings and blank names", async () => {
    const { store } = await setup();
    await expect(store.save({ ...input, name: "  " })).rejects.toThrow();
    await expect(store.save({ ...input, executorRef: "team:invalid" })).rejects.toThrow();
    await expect(
      store.save({
        ...input,
        contextStoreIds: [...input.contextStoreIds, ...input.contextStoreIds],
      }),
    ).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });
});
