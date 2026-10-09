import { realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import type {
  PragmaAgentHomeProject,
  PragmaAgentResourceCatalogPort,
  PragmaAgentResourceQuery,
  PragmaAgentWorkspace,
} from "@pragma/built-in-agents";

import type { ContextStoreStore } from "../context-stores/context-store-store.ts";
import type { HomeProjectStore } from "../missions/home-project-store.ts";
import type { HomeExecutorPreferenceStore } from "../missions/home-executor-preference-store.ts";
import type { MissionExecutorCatalog } from "../missions/mission-executor-catalog.ts";
import type { WorkspaceHistoryStore } from "../workspaces/workspace-history-store.ts";
import { validateHostWorkspace as validateWorkspace } from "@pragma/local-host";
import { paginateManagementItems } from "./management-pagination.ts";

export function createDesktopPragmaAgentResourceCatalogPort(options: {
  readonly homeProjects: Pick<HomeProjectStore, "list">;
  readonly contextStores: Pick<ContextStoreStore, "list" | "get" | "withRevisionLock">;
  readonly executors: Pick<MissionExecutorCatalog, "list">;
  readonly workspaceHistory: Pick<WorkspaceHistoryStore, "list">;
  readonly workspacePreferences?: Pick<HomeExecutorPreferenceStore, "list"> | undefined;
  readonly getDefaultWorkspace: () => Promise<string>;
}): PragmaAgentResourceCatalogPort {
  const page = <T>(items: readonly T[], scope: string, input: PragmaAgentResourceQuery) =>
    paginateManagementItems({
      items,
      scope,
      fingerprintValue: items,
      filters: { query: input.query },
      cursor: input.cursor,
      limit: input.limit,
    });
  const matches = (input: PragmaAgentResourceQuery, values: readonly string[]) => {
    const query = input.query?.toLocaleLowerCase();
    return query === undefined || values.some((value) => value.toLocaleLowerCase().includes(query));
  };

  const homeProjects = async (
    projects: Awaited<ReturnType<HomeProjectStore["list"]>>,
    executors: Awaited<ReturnType<MissionExecutorCatalog["list"]>>,
  ): Promise<PragmaAgentHomeProject[]> => {
    const storeIds = [...new Set(projects.flatMap((project) => project.contextStoreIds))];
    const stores = new Map(
      await Promise.all(
        storeIds.map(async (id) => {
          const ready = await options.contextStores
            .withRevisionLock(
              id,
              async () => (await options.contextStores.get(id)).status === "ready",
            )
            .catch(() => false);
          return [id, ready] as const;
        }),
      ),
    );
    return await Promise.all(
      projects.map(async (project) => {
        const executor = executors.find((item) => item.ref === project.executorRef);
        const workspace = await validateWorkspace(project.workspace.path);
        return {
          projectId: project.id,
          name: project.name,
          workspaceId: project.workspace.path,
          executorRef: project.executorRef,
          ...(executor === undefined ? {} : { executorName: executor.name }),
          contextStoreIds: project.contextStoreIds,
          available:
            workspace.ok &&
            executor !== undefined &&
            project.contextStoreIds.every((id) => stores.get(id) === true),
        };
      }),
    );
  };

  return {
    async listWorkspaces(input) {
      const [defaultPath, recent, projects, preferences] = await Promise.all([
        options.getDefaultWorkspace(),
        options.workspaceHistory.list(),
        options.homeProjects.list(),
        options.workspacePreferences?.list() ?? [],
      ]);
      const candidates: { path: string; source: PragmaAgentWorkspace["sources"][number] }[] = [];
      const add = (path: string, source: PragmaAgentWorkspace["sources"][number]) => {
        candidates.push({ path, source });
      };
      add(defaultPath, "default");
      if (input.currentWorkspacePath !== undefined) add(input.currentWorkspacePath, "current");
      recent.forEach((path) => add(path, "recent"));
      projects.forEach((project) => add(project.workspace.path, "home_project"));
      preferences.forEach((entry) => {
        if (entry.favoriteWorkspace !== undefined) add(entry.favoriteWorkspace, "home_favorite");
        if (entry.lastWorkspace !== undefined) add(entry.lastWorkspace, "executor_history");
      });
      // Resolve through the filesystem before merging: lexical normalization of
      // a symlink followed by '..' can point at a different directory.
      const canonical = await Promise.all(
        candidates.map(async (candidate) => ({
          path: isAbsolute(candidate.path)
            ? await realpath(candidate.path).catch(() => candidate.path)
            : candidate.path,
          source: candidate.source,
        })),
      );
      const paths = new Map<string, Set<PragmaAgentWorkspace["sources"][number]>>();
      for (const { path, source } of canonical) {
        const sources = paths.get(path) ?? new Set();
        sources.add(source);
        paths.set(path, sources);
      }
      const items = await Promise.all(
        [...paths].map(async ([workspaceId, sources]): Promise<PragmaAgentWorkspace> => {
          const validation = await validateWorkspace(workspaceId);
          return {
            workspaceId,
            name: basename(workspaceId) || workspaceId,
            sources: [...sources],
            available: validation.ok,
            ...(validation.ok ? {} : { unavailableReason: validation.reason }),
          };
        }),
      );
      return page(
        items.filter((item) => matches(input, [item.name, item.workspaceId])),
        "list_workspaces",
        input,
      );
    },
    async listHomeProjects(input) {
      const [projects, executors] = await Promise.all([
        options.homeProjects.list(),
        options.executors.list(),
      ]);
      const selected = projects.filter((project) =>
        matches(input, [
          project.name,
          project.workspace.path,
          executors.find((item) => item.ref === project.executorRef)?.name ?? "",
        ]),
      );
      return page(await homeProjects(selected, executors), "list_home_projects", input);
    },
    async getHomeProject(projectId) {
      const project = (await options.homeProjects.list()).find((item) => item.id === projectId);
      if (project === undefined) throw new Error(`Home project not found: ${projectId}`);
      return (await homeProjects([project], await options.executors.list()))[0]!;
    },
    async listKnowledgeStores(input) {
      const items = (await options.contextStores.list()).map((store) => ({
        storeId: store.id,
        name: store.name,
        description: store.description,
        status: store.status,
      }));
      return page(
        items.filter((item) => matches(input, [item.name, item.description])),
        "list_knowledge_stores",
        input,
      );
    },
  };
}
