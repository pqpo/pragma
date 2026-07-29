import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHomeExecutorPreferenceStore } from "./home-executor-preference-store.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Home executor preference store", () => {
  it("follows the most recently used workspace while retaining visibility preferences", async () => {
    const path = await preferencesPath();
    const store = createHomeExecutorPreferenceStore({ preferencesPath: path });
    const ref = "expert:0000000000000001";

    await store.recordUsage({
      ref,
      workspace: "/work/first",
      usedAt: "2026-07-29T08:00:00.000Z",
    });
    await store.update({ ref, favoriteScope: "workspace", workspace: "/work/first" });
    await store.recordUsage({
      ref,
      workspace: "/work/second",
      usedAt: "2026-07-29T09:00:00.000Z",
    });

    await expect(store.list()).resolves.toEqual([
      {
        ref,
        favoriteScope: "workspace",
        hidden: false,
        lastWorkspace: "/work/second",
        lastUsedAt: "2026-07-29T09:00:00.000Z",
      },
    ]);
  });

  it("serializes concurrent mutations and clears workspace-scoped favorites with stale bindings", async () => {
    const path = await preferencesPath();
    const store = createHomeExecutorPreferenceStore({ preferencesPath: path });
    const ref = "expert:0000000000000001";
    await store.recordUsage({ ref, workspace: "/work/current" });

    await Promise.all([
      store.update({ ref, favoriteScope: "global" }),
      store.update({ ref, hidden: true }),
    ]);
    const hidden = (await store.list())[0]!;
    expect(hidden.hidden).toBe(true);
    expect(hidden.favoriteScope).toBe("none");

    await store.update({ ref, hidden: false, favoriteScope: "workspace" });
    await store.recordUsage({
      ref: "expert:0000000000000002",
      workspace: "/work/stale",
    });
    await store.prune(new Set([ref]));
    const cleared = await store.update({ ref, clearWorkspace: true });
    expect(cleared).toMatchObject({ favoriteScope: "none", hidden: false });
    expect(cleared).not.toHaveProperty("lastWorkspace");
    expect(await store.list()).toHaveLength(1);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      schemaVersion: "pragma.desktop-home-executor-preferences/v1",
    });
  });
});

async function preferencesPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pragma-home-executor-preferences-"));
  temporaryPaths.push(directory);
  return join(directory, "preferences.json");
}
