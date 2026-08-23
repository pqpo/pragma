import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";

import type { RuntimeResolver } from "@pragma/core";
import {
  createIntegrationError,
  WorkspaceSelectionSchema,
  type IntegrationCapability,
  type WorkspaceSelection,
} from "@pragma/shared/integration";

export const LOCAL_HOST_APPLICATION_PROTOCOL = "pragma.local-host/v1" as const;
export const LOCAL_HOST_SHARED_BOARD_STORE_ID = "mission-board" as const;
export const LOCAL_HOST_SHARED_BOARD_SCOPE_ID = "mission-board:shared" as const;

export * from "./missions/controller/mission-controller-store.ts";
export * from "./missions/controller/schemas.ts";
export * from "./missions/controller/migrations/index.ts";

export interface WorkspaceFilesystemPort {
  readonly stat: (path: string) => Promise<{ readonly isDirectory: () => boolean }>;
  readonly access: (path: string, mode: "read" | "write") => Promise<void>;
  readonly realpath: (path: string) => Promise<string>;
}

export interface LocalHostSharedBoardListRequest {
  readonly missionId: string;
  readonly storeId: typeof LOCAL_HOST_SHARED_BOARD_STORE_ID;
  readonly scopeId: typeof LOCAL_HOST_SHARED_BOARD_SCOPE_ID;
}

export interface LocalHostSharedBoardReadRequest extends LocalHostSharedBoardListRequest {
  readonly id: string;
  readonly start: number;
  readonly maxBytes: number;
}

export interface LocalHostSharedBoardSearchRequest extends LocalHostSharedBoardListRequest {
  readonly query: string;
  readonly maxResults: number;
  readonly contextLines: number;
}

/**
 * The small, explicitly composed Local Host surface. Desktop Main and the CLI
 * inject their storage, filesystem and Runtime ports here; this is deliberately
 * not a general service locator.
 */
export interface LocalHostApplicationPort<
  TMissionSummary = unknown,
  TMission = unknown,
  TExecutor = unknown,
  TProject = unknown,
  TRevision = unknown,
  TBoardList = unknown,
  TBoardRead = unknown,
  TBoardSearch = unknown,
> {
  readonly protocol: typeof LOCAL_HOST_APPLICATION_PROTOCOL;
  integrationCapability(): Promise<IntegrationCapability>;
  listProjects(): Promise<readonly TProject[]>;
  getProjectRevision(projectId: string, revision: number): Promise<TRevision | undefined>;
  listExecutors(): Promise<readonly TExecutor[]>;
  getMission(id: string): Promise<TMission>;
  listMissions(): Promise<readonly TMissionSummary[]>;
  resolveWorkspace(requestedPath: string): Promise<WorkspaceSelection>;
  listSharedBoard(missionId: string): Promise<TBoardList>;
  readSharedBoard(
    missionId: string,
    id: string,
    start: number,
    maxBytes: number,
  ): Promise<TBoardRead>;
  searchSharedBoard(missionId: string, query: string, maxResults: number): Promise<TBoardSearch>;
  /** Runtime adapter selection is supplied by the Host composition root, never imported here. */
  runtimeResolver(): RuntimeResolver;
}

export interface LocalHostApplicationPorts<
  TMissionSummary,
  TMission,
  TExecutor,
  TProject,
  TRevision,
  TBoardList,
  TBoardRead,
  TBoardSearch,
> {
  readonly integrationCapability: () => Promise<IntegrationCapability>;
  readonly catalog: {
    readonly listProjects: () => Promise<readonly TProject[]>;
    readonly getProjectRevision: (
      projectId: string,
      revision: number,
    ) => Promise<TRevision | undefined>;
    readonly listExecutors: () => Promise<readonly TExecutor[]>;
  };
  readonly missions: {
    readonly get: (id: string) => Promise<TMission>;
    readonly list: () => Promise<readonly TMissionSummary[]>;
  };
  /** Desktop and CLI inject raw filesystem operations; Local Host owns the resolution policy. */
  readonly workspace: WorkspaceFilesystemPort;
  /** A generic read-only store adapter. Local Host fixes this use case to the shared Board scope. */
  readonly board: {
    readonly list: (input: LocalHostSharedBoardListRequest) => Promise<TBoardList>;
    readonly read: (input: LocalHostSharedBoardReadRequest) => Promise<TBoardRead>;
    readonly search: (input: LocalHostSharedBoardSearchRequest) => Promise<TBoardSearch>;
  };
  readonly runtime: { readonly resolver: RuntimeResolver };
}

export function createLocalHostApplication<
  TMissionSummary,
  TMission,
  TExecutor,
  TProject,
  TRevision,
  TBoardList,
  TBoardRead,
  TBoardSearch,
>(
  ports: LocalHostApplicationPorts<
    TMissionSummary,
    TMission,
    TExecutor,
    TProject,
    TRevision,
    TBoardList,
    TBoardRead,
    TBoardSearch
  >,
): LocalHostApplicationPort<
  TMissionSummary,
  TMission,
  TExecutor,
  TProject,
  TRevision,
  TBoardList,
  TBoardRead,
  TBoardSearch
> {
  return {
    protocol: LOCAL_HOST_APPLICATION_PROTOCOL,
    integrationCapability: ports.integrationCapability,
    listProjects: ports.catalog.listProjects,
    getProjectRevision: ports.catalog.getProjectRevision,
    listExecutors: ports.catalog.listExecutors,
    getMission: ports.missions.get,
    listMissions: ports.missions.list,
    resolveWorkspace: async (requestedPath) =>
      await resolveWorkspace(requestedPath, ports.workspace),
    listSharedBoard: async (missionId) =>
      await ports.board.list({
        missionId,
        storeId: LOCAL_HOST_SHARED_BOARD_STORE_ID,
        scopeId: LOCAL_HOST_SHARED_BOARD_SCOPE_ID,
      }),
    readSharedBoard: async (missionId, id, start, maxBytes) =>
      await ports.board.read({
        missionId,
        storeId: LOCAL_HOST_SHARED_BOARD_STORE_ID,
        scopeId: LOCAL_HOST_SHARED_BOARD_SCOPE_ID,
        id,
        start,
        maxBytes,
      }),
    searchSharedBoard: async (missionId, query, maxResults) =>
      await ports.board.search({
        missionId,
        storeId: LOCAL_HOST_SHARED_BOARD_STORE_ID,
        scopeId: LOCAL_HOST_SHARED_BOARD_SCOPE_ID,
        query,
        maxResults,
        contextLines: 2,
      }),
    runtimeResolver: () => ports.runtime.resolver,
  };
}

async function resolveWorkspace(
  requestedPath: string,
  filesystem: WorkspaceFilesystemPort,
): Promise<WorkspaceSelection> {
  if (!requestedPath || !isAbsolute(requestedPath)) {
    throw workspaceError("INVALID_ARGUMENT", requestedPath, "not_absolute");
  }

  let directory: { readonly isDirectory: () => boolean };
  try {
    directory = await filesystem.stat(requestedPath);
  } catch (error) {
    throw workspaceFilesystemError(requestedPath, "not_found", error);
  }
  if (!directory.isDirectory()) {
    throw workspaceError("INVALID_ARGUMENT", requestedPath, "not_directory");
  }

  for (const mode of ["read", "write"] as const) {
    try {
      await filesystem.access(requestedPath, mode);
    } catch (error) {
      throw workspaceFilesystemError(requestedPath, `not_${mode}able`, error);
    }
  }

  let canonicalPath: string;
  try {
    canonicalPath = await filesystem.realpath(requestedPath);
  } catch (error) {
    throw workspaceFilesystemError(requestedPath, "realpath_failed", error);
  }

  return WorkspaceSelectionSchema.parse({
    schemaVersion: "pragma.integration-workspace/v1",
    requestedPath,
    canonicalPath,
    displayName: basename(canonicalPath),
    identityHash: `sha256:${createHash("sha256").update(canonicalPath).digest("hex")}`,
    access: { exists: true, readable: true, writable: true },
    source: "explicit",
  });
}

function workspaceFilesystemError(requestedPath: string, reason: string, error: unknown) {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return workspaceError(
    code === "ENOENT" ? "WORKSPACE_NOT_FOUND" : "WORKSPACE_ACCESS_DENIED",
    requestedPath,
    reason,
  );
}

function workspaceError(
  code: "INVALID_ARGUMENT" | "WORKSPACE_NOT_FOUND" | "WORKSPACE_ACCESS_DENIED",
  requestedPath: string,
  reason: string,
) {
  return createIntegrationError({
    code,
    category:
      code === "INVALID_ARGUMENT"
        ? "usage"
        : code === "WORKSPACE_NOT_FOUND"
          ? "not_found"
          : "permission",
    message: `Workspace is not available: ${requestedPath || "(empty path)"}.`,
    details: { requestedPath, reason },
  });
}
