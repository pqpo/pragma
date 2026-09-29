import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodePragmaPathSegment } from "@pragma/core";
import { afterEach, describe, expect, it } from "vitest";

import { createWorkflowLayoutStore } from "./workflow-layout-store.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

async function projectsDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pragma-layout-"));
  directories.push(directory);
  return directory;
}

describe("workflow layout store", () => {
  it("persists layout separately from project revisions", async () => {
    const projectsPath = await projectsDirectory();
    const store = createWorkflowLayoutStore({ projectsPath });
    const layout = {
      schemaVersion: "pragma.desktop-flow-layout/v2" as const,
      projectId: "studio",
      flowId: "t1e73vjvctx49gkq",
      nodes: { review: { x: 120, y: 80 } },
      viewport: { x: 20, y: 10, zoom: 0.9 },
      updatedAt: "2026-07-15T00:00:00.000Z",
    };

    await store.save(layout);

    await expect(store.get({ projectId: "studio", flowId: "t1e73vjvctx49gkq" })).resolves.toEqual(
      layout,
    );
    const stored = JSON.parse(
      await readFile(
        join(
          projectsPath,
          "studio",
          "layouts",
          "flows",
          `${encodePragmaPathSegment("t1e73vjvctx49gkq")}.json`,
        ),
        "utf8",
      ),
    );
    expect(stored.nodes.review).toEqual({ x: 120, y: 80 });
  });

  it("returns null for missing layouts", async () => {
    const projectsPath = await projectsDirectory();
    const store = createWorkflowLayoutStore({ projectsPath });

    await expect(store.get({ projectId: "studio", flowId: "missing" })).resolves.toBeNull();
  });

  it("ignores malformed layout files", async () => {
    const projectsPath = await projectsDirectory();
    const store = createWorkflowLayoutStore({ projectsPath });
    const layoutDirectory = join(projectsPath, "studio", "layouts", "flows");
    await mkdir(layoutDirectory, { recursive: true });
    await writeFile(join(layoutDirectory, `${encodePragmaPathSegment("review")}.json`), "{}");

    await expect(store.get({ projectId: "studio", flowId: "review" })).resolves.toBeNull();
  });

  it("replays Flow deletion after publication and preserves layouts before the CAS commits", async () => {
    const projectsPath = await projectsDirectory();
    const store = createWorkflowLayoutStore({ projectsPath });
    const layout = {
      schemaVersion: "pragma.desktop-flow-layout/v2" as const,
      projectId: "studio",
      flowId: "t1e73vjvctx49gkq",
      nodes: {},
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: "2026-07-15T00:00:00.000Z",
    };
    await store.save(layout);
    await store.prepareRemoval(layout, 1);
    await store.recoverRemovals("studio", async () => ({ revision: 1, flowIds: [layout.flowId] }));
    expect(await store.get(layout)).toEqual(layout);
    const restarted = createWorkflowLayoutStore({ projectsPath });
    await restarted.recoverRemovals("studio", async () => ({ revision: 2, flowIds: [] }));
    expect(await restarted.get(layout)).toBeNull();
    await restarted.recoverRemovals("studio", async () => ({ revision: 2, flowIds: [] }));
    expect(await readdir(join(projectsPath, "studio", "layouts", ".removals"))).toEqual([]);
  });

  it("cancels obsolete deletion intents and rejects future journals without deleting layouts", async () => {
    const projectsPath = await projectsDirectory();
    const store = createWorkflowLayoutStore({ projectsPath });
    const layout = {
      schemaVersion: "pragma.desktop-flow-layout/v2" as const,
      projectId: "studio",
      flowId: "t1e73vjvctx49gkq",
      nodes: {},
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: "2026-07-15T00:00:00.000Z",
    };
    await store.save(layout);
    await store.prepareRemoval(layout, 1);
    await store.recoverRemovals("studio", async () => ({ revision: 2, flowIds: [layout.flowId] }));
    expect(await store.get(layout)).toEqual(layout);
    const journalDirectory = join(projectsPath, "studio", "layouts", ".removals");
    expect(await readdir(journalDirectory)).toEqual([]);
    await store.prepareRemoval(layout, 2);
    const path = join(journalDirectory, (await readdir(journalDirectory))[0]!);
    const journal = JSON.parse(await readFile(path, "utf8"));
    await writeFile(
      path,
      JSON.stringify({ ...journal, schemaVersion: "pragma.desktop-flow-layout-removal/v99" }),
    );
    await expect(
      store.recoverRemovals("studio", async () => ({ revision: 3, flowIds: [] })),
    ).rejects.toThrow();
    expect(await store.get(layout)).toEqual(layout);
  });

  it("removes a saved layout", async () => {
    const projectsPath = await projectsDirectory();
    const store = createWorkflowLayoutStore({ projectsPath });
    const identity = { projectId: "studio", flowId: "t1e73vjvctx49gkq" };
    await store.save({
      schemaVersion: "pragma.desktop-flow-layout/v2",
      ...identity,
      nodes: {},
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: "2026-07-15T00:00:00.000Z",
    });

    await store.remove(identity);

    await expect(store.get(identity)).resolves.toBeNull();
  });
});
