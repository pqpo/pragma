import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";

import {
  createStaticRuntimeResolver,
  type RuntimeAdapter,
  type RuntimeResolver,
} from "@pragma/core";
import {
  createIntegrationError,
  WorkspaceSelectionSchema,
  type IntegrationCapability,
  type HumanInteractionRequestEnvelope,
  type WorkspaceSelection,
} from "@pragma/shared/integration";
import type { HumanInteractionResponse } from "@pragma/shared";
import type { LocalHostRunApplication } from "./run.ts";
import type { MissionControlApplication } from "./missions/controller/mission-control.ts";
import type { MissionWatchPort } from "./missions/controller/watch.ts";

export {
  CliResultSchema,
  IntegrationErrorSchema,
  integrationErrorExitCode,
} from "@pragma/shared/integration";
export type { IntegrationErrorCode } from "@pragma/shared/integration";

export const LOCAL_HOST_APPLICATION_PROTOCOL = "pragma.local-host/v1" as const;
export const LOCAL_HOST_SHARED_BOARD_STORE_ID = "mission-board" as const;
export const LOCAL_HOST_SHARED_BOARD_SCOPE_ID = "mission-board:shared" as const;

export * from "./missions/controller/mission-controller-store.ts";
export * from "./missions/controller/schemas.ts";
export * from "./missions/controller/pinned-binding.ts";
export * from "./missions/controller/pinned-binding-backfill.ts";
export * from "./missions/controller/owner-scope.ts";
export * from "./missions/controller/prompt-queue.ts";
export * from "./missions/controller/command-payload.ts";
export * from "./missions/controller/retention.ts";
export * from "./missions/controller/watch.ts";
export * from "./missions/controller/mission-control.ts";
export * from "./missions/controller/migrations/index.ts";
export * from "./run-payload.ts";
export * from "./run.ts";
export * from "./core-run.ts";
export * from "./core-control-adapter.ts";
export * from "./built-in-executors.ts";
export * from "./mission-board.ts";
export * from "./redaction.ts";
export * from "./runtime-environment.ts";
export * from "./usage.ts";
export * from "./logger.ts";
export * from "./project-revision.ts";
export * from "./project-catalog.ts";
export * from "./secrets/index.ts";
/** Composition convenience: this is Core's shared counter, not a Host estimator. */
export { createRuntimeTokenCounter } from "@pragma/core";

/**
 * Host composition keeps concrete Runtime adapters at the application edge,
 * while the Core resolver construction remains in this Node-only adapter.
 */
export function createLocalHostRuntimeResolver(options: {
  readonly runtimes: readonly RuntimeAdapter[];
  readonly defaultRuntimeId: string;
  /** Logical IDs retained by published project revisions. */
  readonly runtimeAliases?: Readonly<Record<string, string>> | undefined;
}): RuntimeResolver {
  const delegate = createStaticRuntimeResolver(options);
  const aliases = options.runtimeAliases ?? {};
  const resolveRuntimeId = (runtimeId: string): string => aliases[runtimeId] ?? runtimeId;
  const restoreBindingId = <T extends { readonly runtimeId: string }>(
    binding: T,
    runtimeId: string,
  ): T => ({ ...binding, runtimeId });
  return {
    getDefaultRuntimeId: async () => await delegate.getDefaultRuntimeId(),
    bind: async (request = {}) => {
      const runtimeId = request.runtimeId;
      const resolved = await delegate.bind({
        ...(runtimeId === undefined ? {} : { runtimeId: resolveRuntimeId(runtimeId) }),
        ...(request.modelSelection === undefined ? {} : { modelSelection: request.modelSelection }),
      });
      return runtimeId === undefined
        ? resolved
        : { ...resolved, binding: restoreBindingId(resolved.binding, runtimeId) };
    },
    resolve: async ({ binding, modelSelection }) => {
      const resolved = await delegate.resolve({
        binding: { ...binding, runtimeId: resolveRuntimeId(binding.runtimeId) },
        ...(modelSelection === undefined ? {} : { modelSelection }),
      });
      return {
        ...resolved,
        binding: restoreBindingId(resolved.binding, binding.runtimeId),
      };
    },
  };
}

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
  readonly caseSensitive?: boolean;
}

export interface LocalHostMissionResumeRequest {
  readonly missionId: string;
  readonly project?:
    | {
        readonly projectId: string;
        readonly revision: number;
      }
    | undefined;
  readonly expectedFingerprint?: string | undefined;
  readonly requestId?: string | undefined;
  readonly detach?: boolean | undefined;
  /** Optional TTY/UI response path for a recovered human interaction. */
  readonly onHumanInteraction?:
    | ((
        input: HumanInteractionRequestEnvelope,
      ) => Promise<
        | { readonly kind: "respond"; readonly response: HumanInteractionResponse }
        | { readonly kind: "checkpoint" }
      >)
    | undefined;
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
  TQueue = unknown,
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
  searchSharedBoard(
    missionId: string,
    query: string,
    maxResults: number,
    options?: Pick<LocalHostSharedBoardSearchRequest, "caseSensitive" | "contextLines">,
  ): Promise<TBoardSearch>;
  listMissionQueue(missionId: string): Promise<TQueue>;
  /** Read-only Mission event watcher; this port never claims a controller lease. */
  readonly watchMission?: MissionWatchPort["watch"];
  /** Performs only the explicit, proof-based missing-pin repair for one Mission. */
  readonly resumeMission?: (input: LocalHostMissionResumeRequest) => Promise<unknown>;
  /** Durable mutation entry point shared by CLI and Host adapters. */
  readonly missionControl?: MissionControlApplication;
  /** @deprecated Prefer missionControl; retained as a descriptive alias for CLI callers. */
  readonly missionCommands?: MissionControlApplication;
  /** Runtime adapter selection is supplied by the Host composition root, never imported here. */
  runtimeResolver(): RuntimeResolver;
  readonly run?: LocalHostRunApplication | undefined;
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
  TQueue = unknown,
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
  /** Read-only projection of the Core ExpertSession prompt queue. */
  readonly queue?: { readonly list: (missionId: string) => Promise<TQueue> };
  /** Read-only Mission event watcher; this port never claims a controller lease. */
  readonly watch?: MissionWatchPort;
  readonly missionControl?: {
    /** Optional Host recovery command; Desktop exposes commands without CLI resume. */
    readonly resume?: ((input: LocalHostMissionResumeRequest) => Promise<unknown>) | undefined;
    readonly commands?: MissionControlApplication;
  };
  readonly runtime: { readonly resolver: RuntimeResolver };
  readonly run?: LocalHostRunApplication | undefined;
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
  TQueue = unknown,
>(
  ports: LocalHostApplicationPorts<
    TMissionSummary,
    TMission,
    TExecutor,
    TProject,
    TRevision,
    TBoardList,
    TBoardRead,
    TBoardSearch,
    TQueue
  >,
): LocalHostApplicationPort<
  TMissionSummary,
  TMission,
  TExecutor,
  TProject,
  TRevision,
  TBoardList,
  TBoardRead,
  TBoardSearch,
  TQueue
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
    searchSharedBoard: async (missionId, query, maxResults, options) =>
      await ports.board.search({
        missionId,
        storeId: LOCAL_HOST_SHARED_BOARD_STORE_ID,
        scopeId: LOCAL_HOST_SHARED_BOARD_SCOPE_ID,
        query,
        maxResults,
        contextLines: options?.contextLines ?? 2,
        ...(options?.caseSensitive === undefined ? {} : { caseSensitive: options.caseSensitive }),
      }),
    listMissionQueue: async (missionId) => {
      if (ports.queue === undefined) {
        throw createIntegrationError({
          code: "DEPENDENCY_UNAVAILABLE",
          category: "dependency",
          message: "Mission queue queries are unavailable in this Host composition.",
        });
      }
      return await ports.queue.list(missionId);
    },
    ...(ports.watch === undefined ? {} : { watchMission: ports.watch.watch }),
    ...(ports.missionControl?.resume === undefined
      ? {}
      : { resumeMission: ports.missionControl.resume }),
    ...(ports.missionControl?.commands === undefined
      ? {}
      : {
          missionControl: ports.missionControl.commands,
          missionCommands: ports.missionControl.commands,
        }),
    runtimeResolver: () => ports.runtime.resolver,
    ...(ports.run === undefined ? {} : { run: ports.run }),
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
    displayName: basename(canonicalPath) || canonicalPath,
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
