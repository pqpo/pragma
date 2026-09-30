import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  createPragmaManagementTools,
  type PragmaAgentDslProjectPort,
  type PragmaAgentMissionPort,
} from "@pragma/built-in-agents";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createContextStoreStore } from "../context-stores/context-store-store.ts";
import { createHomeProjectStore } from "../missions/home-project-store.ts";
import { createHomeExecutorPreferenceStore } from "../missions/home-executor-preference-store.ts";
import { createWorkspaceHistoryStore } from "../workspaces/workspace-history-store.ts";
import { createDesktopPragmaAgentResourceCatalogPort } from "./pragma-agent-resource-adapter.ts";

vi.mock("electron", () => ({ BrowserWindow: class {}, dialog: {}, ipcMain: {} }));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Pragma resource discovery", () => {
  it("checks only selected projects' stores under revision locks and isolates unavailable owners", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-resource-isolation-"));
    roots.push(root);
    const storesPath = join(root, "knowledge");
    const contextStores = createContextStoreStore({ storesPath });
    const ready = await contextStores.create({ mode: "blank", name: "Ready", description: "" });
    const broken = await contextStores.create({ mode: "blank", name: "Broken", description: "" });
    await writeFile(join(storesPath, broken.id, "store.json"), "invalid JSON");
    const homeProjects = createHomeProjectStore(join(root, "projects.json"));
    const executor = {
      kind: "team" as const,
      avatarId: "pragma.avatar.team.default",
      ref: "team:1h2j3k4m5n6p7q8r",
      name: "Development team",
      description: "Build features",
      members: [],
      origin: "project" as const,
      readOnly: false,
      customized: false,
    };
    const save = async (name: string, storeId: string) =>
      await homeProjects.save({
        name,
        workspace: { path: root, basename: basename(root) },
        executorRef: executor.ref,
        contextStoreIds: [storeId],
      });
    const target = await save("Selected one", ready.id);
    await save("Selected two", ready.id);
    const unrelated = await save("Unrelated", broken.id);
    const list = vi.spyOn(contextStores, "list");
    const locked = new Set<string>();
    const withRevisionLock = contextStores.withRevisionLock.bind(contextStores);
    vi.spyOn(contextStores, "withRevisionLock").mockImplementation(
      async (id, operation) =>
        await withRevisionLock(id, async () => {
          locked.add(id);
          try {
            return await operation();
          } finally {
            locked.delete(id);
          }
        }),
    );
    const read = contextStores.get.bind(contextStores);
    const get = vi.spyOn(contextStores, "get").mockImplementation(async (id) => {
      expect(locked.has(id)).toBe(true);
      return await read(id);
    });
    const resources = createDesktopPragmaAgentResourceCatalogPort({
      homeProjects,
      contextStores,
      executors: { list: async () => [executor] },
      workspaceHistory: { list: async () => [] },
      getDefaultWorkspace: async () => root,
    });
    expect(await resources.getHomeProject(target.id)).toMatchObject({ available: true });
    expect(get.mock.calls).toEqual([[ready.id]]);
    get.mockClear();
    const selected = await resources.listHomeProjects({ query: "Selected", limit: 100 });
    expect(selected.items).toHaveLength(2);
    expect(selected.items.every((project) => project.available)).toBe(true);
    expect(get.mock.calls).toEqual([[ready.id]]);
    get.mockClear();
    expect((await resources.listHomeProjects({ query: "no match", limit: 100 })).items).toEqual([]);
    await expect(resources.getHomeProject("missing")).rejects.toThrow("Home project not found");
    expect(get).not.toHaveBeenCalled();
    expect(await resources.getHomeProject(unrelated.id)).toMatchObject({ available: false });
    const all = await resources.listHomeProjects({ query: executor.name, limit: 100 });
    expect(all.items.map((project) => project.available)).toEqual([true, true, false]);
    expect(list).not.toHaveBeenCalled();
  });

  it("preserves symlink path semantics and merges aliases by their real directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-resource-paths-"));
    roots.push(root);
    const actual = join(root, "actual");
    await mkdir(join(actual, "child"), { recursive: true });
    const alias = join(root, "alias");
    await symlink(join(actual, "child"), alias, "dir");
    const linkedParent = `${alias}/..`;
    const resources = createDesktopPragmaAgentResourceCatalogPort({
      homeProjects: { list: async () => [] },
      contextStores: createContextStoreStore({ storesPath: join(root, "knowledge") }),
      executors: { list: async () => [] },
      workspaceHistory: { list: async () => [actual] },
      getDefaultWorkspace: async () => linkedParent,
    });
    const result = await resources.listWorkspaces({ limit: 100 });
    expect(result.items).toHaveLength(1);
    expect(await realpath(result.items[0]!.workspaceId)).toBe(await realpath(actual));
    expect(result.items[0]!.sources).toEqual(["default", "recent"]);
  });

  it("includes workspaces retained in home favorites and executor usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-resource-favorites-"));
    roots.push(root);
    const preferred = join(root, "favorite");
    const last = join(root, "last");
    await Promise.all([mkdir(preferred), mkdir(last)]);
    const preferences = createHomeExecutorPreferenceStore({
      preferencesPath: join(root, "preferences.json"),
    });
    const ref = "expert:0000000000000001";
    await preferences.update({ ref, favoriteScope: "workspace", favoriteWorkspace: preferred });
    await preferences.recordUsage({ ref, workspace: last });
    const resources = createDesktopPragmaAgentResourceCatalogPort({
      homeProjects: { list: async () => [] },
      contextStores: createContextStoreStore({ storesPath: join(root, "knowledge") }),
      executors: { list: async () => [] },
      workspaceHistory: { list: async () => [] },
      getDefaultWorkspace: async () => root,
      workspacePreferences: preferences,
    });
    const result = await resources.listWorkspaces({ limit: 100 });
    expect(result.items.map((item) => item.workspaceId)).toEqual(
      expect.arrayContaining([await realpath(preferred), await realpath(last)]),
    );
  });

  it("reads saved resources through tools, merges workspace sources, and pages without exposing storage paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-resource-catalog-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const missing = join(root, "missing");
    await mkdir(workspace);
    const homeProjects = createHomeProjectStore(join(root, "home-projects.json"));
    const workspaceHistory = createWorkspaceHistoryStore({
      historyPath: join(root, "history.json"),
    });
    const contextStores = createContextStoreStore({ storesPath: join(root, "knowledge") });
    const knowledge = await contextStores.create({
      mode: "blank",
      name: "Product requirements",
      description: "Product knowledge",
    });
    await workspaceHistory.record(workspace);
    await workspaceHistory.record(missing);
    const executor = {
      kind: "team" as const,
      avatarId: "pragma.avatar.team.default",
      ref: "team:1h2j3k4m5n6p7q8r",
      name: "Development team",
      description: "Build features",
      members: [],
      origin: "project" as const,
      readOnly: false,
      customized: false,
    };
    const project = await homeProjects.save({
      name: "Pragma development",
      workspace: { path: workspace, basename: basename(workspace) },
      executorRef: executor.ref,
      contextStoreIds: [knowledge.id],
    });
    const resources = createDesktopPragmaAgentResourceCatalogPort({
      homeProjects,
      workspaceHistory,
      contextStores,
      executors: { list: async () => [executor] },
      getDefaultWorkspace: async () => workspace,
    });
    const tools = createPragmaManagementTools(
      {
        project: {} as PragmaAgentDslProjectPort,
        missions: {} as PragmaAgentMissionPort,
        resources,
      },
      { missionId: "20000000-0000-4000-8000-000000000001", workspacePath: workspace },
    );
    const call = async (name: string, args: unknown) => {
      const tool = tools.find((item) => item.name === name)!;
      expect(tool.approval?.mode).toBe("none");
      const result = await tool.call(args, undefined, undefined);
      expect(result.isError).not.toBe(true);
      return result;
    };
    const canonicalWorkspace = await realpath(workspace);
    const first = await call("list_workspaces", { limit: 1 });
    expect(first.details).toMatchObject({
      items: [
        {
          workspaceId: canonicalWorkspace,
          available: true,
          sources: ["default", "current", "recent", "home_project"],
        },
      ],
      nextCursor: expect.any(String),
    });
    const cursor = (first.details as { nextCursor: string }).nextCursor;
    const second = await call("list_workspaces", { limit: 1, cursor });
    expect(second.details).toMatchObject({
      items: [{ workspaceId: missing, available: false, unavailableReason: "not_found" }],
    });
    expect((second.details as { nextCursor?: string }).nextCursor).toBeUndefined();
    const listed = await call("list_home_projects", { query: "development" });
    expect(listed.details).toMatchObject({
      items: [
        {
          projectId: project.id,
          executorName: executor.name,
          workspaceId: workspace,
          contextStoreIds: [knowledge.id],
          available: true,
        },
      ],
    });
    const fetched = await call("get_home_project", { projectId: project.id });
    expect(fetched.details).toEqual((listed.details as { items: unknown[] }).items[0]);
    const stores = await call("list_knowledge_stores", { query: "requirements" });
    expect(stores.details).toMatchObject({
      items: [{ storeId: knowledge.id, name: knowledge.name, status: "ready" }],
    });
    expect(stores.text).not.toContain(join(root, "knowledge"));
    await contextStores.remove(knowledge.id);
    const unavailable = await call("get_home_project", { projectId: project.id });
    expect(unavailable.details).toMatchObject({
      available: false,
      contextStoreIds: [knowledge.id],
    });
    const notFound = await tools
      .find((item) => item.name === "get_home_project")!
      .call({ projectId: "20000000-0000-4000-8000-000000000099" }, undefined, undefined);
    expect(notFound).toMatchObject({ isError: true, details: { code: "not_found" } });
  });
});
