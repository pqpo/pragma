import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  availableRecentWorkspaces,
  createWorkspaceHistoryStore,
} from "./workspace-history-store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("workspace history store", () => {
  it("keeps the five most recently used unique workspaces", async () => {
    const historyPath = await temporaryHistoryPath();
    const store = createWorkspaceHistoryStore({ historyPath });

    for (const path of ["/work/one", "/work/two", "/work/three", "/work/four", "/work/five"]) {
      await store.record(path);
    }
    await store.record("/work/two");
    await store.record("/work/six");

    await expect(store.list()).resolves.toEqual([
      "/work/six",
      "/work/two",
      "/work/five",
      "/work/four",
      "/work/three",
    ]);
    expect(JSON.parse(await readFile(historyPath, "utf8"))).toEqual({
      schemaVersion: 1,
      recentWorkspaces: ["/work/six", "/work/two", "/work/five", "/work/four", "/work/three"],
    });
  });

  it("keeps only available recent workspaces and excludes the current default", async () => {
    await expect(
      availableRecentWorkspaces(
        ["/work/current", "/work/missing", "/work/recent"],
        "/work/current",
        async (path) => path !== "/work/missing",
      ),
    ).resolves.toEqual(["/work/recent"]);
  });

  it("warns and returns an empty history when the stored file is invalid", async () => {
    const historyPath = await temporaryHistoryPath();
    await writeFile(historyPath, "not json");
    const warn = vi.fn();
    const store = createWorkspaceHistoryStore({ historyPath, warn });

    await expect(store.list()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });
});

async function temporaryHistoryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pragma-workspace-history-"));
  temporaryDirectories.push(directory);
  return join(directory, "workspace-history.json");
}
