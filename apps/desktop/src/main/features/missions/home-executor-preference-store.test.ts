import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  it("keeps the favorite workspace stable while following the most recently used workspace", async () => {
    const path = await preferencesPath();
    const store = createHomeExecutorPreferenceStore({ preferencesPath: path });
    const ref = "expert:0000000000000001";

    await store.recordUsage({
      ref,
      workspace: "/work/first",
      usedAt: "2026-07-29T08:00:00.000Z",
    });
    await store.update({
      ref,
      favoriteScope: "workspace",
      favoriteWorkspace: "/work/first",
    });
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
        favoriteWorkspace: "/work/first",
        lastWorkspace: "/work/second",
        lastUsedAt: "2026-07-29T09:00:00.000Z",
      },
    ]);
  });

  it("serializes concurrent mutations and clears stale last-workspace bindings independently", async () => {
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

    await store.update({
      ref,
      hidden: false,
      favoriteScope: "workspace",
      favoriteWorkspace: "/work/favorite",
    });
    await store.recordUsage({
      ref: "expert:0000000000000002",
      workspace: "/work/stale",
    });
    await store.prune(new Set([ref]));
    const cleared = await store.update({ ref, clearLastWorkspace: true });
    expect(cleared).toMatchObject({
      favoriteScope: "workspace",
      favoriteWorkspace: "/work/favorite",
      hidden: false,
    });
    expect(cleared).not.toHaveProperty("lastWorkspace");
    expect(await store.list()).toHaveLength(1);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      schemaVersion: "pragma.desktop-home-executor-preferences/v1",
    });
  });

  it("rejects incomplete or contradictory favorite mutations at the store boundary", async () => {
    const path = await preferencesPath();
    const store = createHomeExecutorPreferenceStore({ preferencesPath: path });
    const ref = "expert:0000000000000001";

    await expect(store.update({ ref, favoriteWorkspace: "/work/favorite" })).rejects.toThrow(
      "can only be set for a workspace favorite",
    );
    await expect(store.update({ ref, favoriteScope: "workspace" })).rejects.toThrow(
      "requires a favorite workspace",
    );
    await expect(store.update({ ref, favoriteScope: "global", hidden: true })).rejects.toThrow(
      "cannot also be favorited",
    );
    await expect(store.list()).resolves.toEqual([]);
  });

  it("clears an existing workspace favorite when the executor is hidden", async () => {
    const path = await preferencesPath();
    const store = createHomeExecutorPreferenceStore({ preferencesPath: path });
    const ref = "expert:0000000000000001";
    await store.update({
      ref,
      favoriteScope: "workspace",
      favoriteWorkspace: "/work/favorite",
    });

    const hidden = await store.update({ ref, hidden: true });

    expect(hidden).toMatchObject({
      ref,
      favoriteScope: "none",
      hidden: true,
    });
    expect(hidden).not.toHaveProperty("favoriteWorkspace");
  });

  it("normalizes draft v1 workspace favorites before recording later usage", async () => {
    const path = await preferencesPath();
    const ref = "expert:0000000000000001";
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "pragma.desktop-home-executor-preferences/v1",
        entries: [
          {
            ref,
            favoriteScope: "workspace",
            hidden: false,
            lastWorkspace: "/work/original",
          },
        ],
      })}\n`,
    );
    const store = createHomeExecutorPreferenceStore({ preferencesPath: path });

    await store.recordUsage({ ref, workspace: "/work/later" });

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        ref,
        favoriteWorkspace: "/work/original",
        lastWorkspace: "/work/later",
      }),
    ]);
  });

  it("fails closed when persisted global favorites contain a workspace", async () => {
    const path = await preferencesPath();
    const warnings: unknown[] = [];
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: "pragma.desktop-home-executor-preferences/v1",
        entries: [
          {
            ref: "expert:0000000000000001",
            favoriteScope: "global",
            favoriteWorkspace: "/work/contradictory",
            hidden: false,
          },
        ],
      })}\n`,
    );
    const store = createHomeExecutorPreferenceStore({
      preferencesPath: path,
      warn: (_message, error) => warnings.push(error),
    });

    await expect(store.list()).resolves.toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

async function preferencesPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pragma-home-executor-preferences-"));
  temporaryPaths.push(directory);
  return join(directory, "preferences.json");
}
