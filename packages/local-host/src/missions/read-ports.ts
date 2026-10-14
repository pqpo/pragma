import { decodePragmaPathSegment, PragmaPaths, withFileLock } from "@pragma/core";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ZodError } from "zod";
import type { Mission } from "@pragma/shared";
import {
  createIntegrationError,
  IntegrationErrorSchema,
  MissionIdSchema,
  type IntegrationError,
  type IntegrationWarning,
} from "@pragma/shared/integration";
import {
  LOCAL_HOST_SHARED_BOARD_STORE_ID,
  type LocalHostSharedBoardListRequest,
  type LocalHostSharedBoardReadRequest,
  type LocalHostSharedBoardSearchRequest,
  type LocalHostMissionListResult,
} from "../index.ts";
import { createLocalHostMissionBoardBindings } from "../mission-board.ts";
import type { MissionControllerStore } from "./controller/mission-controller-store.ts";
import { createMissionQuery, projectMissionSummary, type MissionQueryPort } from "./query.ts";
import { createMissionWatchApplication, type MissionWatchPort } from "./controller/watch.ts";
import { MissionStoreError, type MissionStore } from "./repository/mission-store.ts";
import { readMissionDeletionRecord } from "./deletion.ts";
import { hasMissionDeletionIntent } from "./repository/mission-deletion-intent.ts";
import { MissionSemanticWriteTransactionSchema } from "./controller/schemas.ts";
import { missionAggregateLockPath } from "./controller/storage-locks.ts";

/** Both hosts read the same sparse controller facts and real full envelopes. */
export function createLocalHostMissionReadPorts(options: {
  readonly pragmaHome: string;
  readonly repository: MissionStore;
  readonly controller: MissionControllerStore;
  readonly query?: MissionQueryPort | undefined;
  readonly watch?: MissionWatchPort | undefined;
}) {
  const readEnvelope = async (id: string): Promise<Mission | undefined> => {
    try {
      return await options.repository.get(id);
    } catch (error) {
      if (error instanceof MissionStoreError && error.code === "mission_not_found")
        return undefined;
      throw error;
    }
  };
  const assertMission = async (id: string): Promise<void> => {
    const envelope = await readEnvelope(id);
    if (envelope !== undefined) return;
    const snapshot = await options.controller.readSnapshot({ missionId: id });
    if (!snapshot.events.some((event) => event.type === "mission.created")) {
      throw createIntegrationError({
        code: "MISSION_NOT_FOUND",
        category: "not_found",
        message: `Mission not found: ${id}.`,
        details: { missionId: id },
      });
    }
  };
  const query =
    options.query ??
    createMissionQuery({ controller: options.controller, readMission: readEnvelope });
  const watch = options.watch ?? createMissionWatchApplication({ controller: options.controller });
  return {
    readEnvelope,
    assertMission,
    missions: {
      get: async (id: string) => {
        await assertMission(id);
        return await options.controller.readSnapshot({ missionId: id });
      },
      listDiagnostics: async () =>
        await listMissionSnapshots(options.controller, options.repository, options.pragmaHome),
      list: async () => {
        const result = await listMissionSnapshots(
          options.controller,
          options.repository,
          options.pragmaHome,
        );
        const error = result.diagnostics[0];
        if (error !== undefined)
          throw IntegrationErrorSchema.parse({
            ...error,
            details: {
              ...error.details,
              availableMissionIds: result.items.map((item) => String(item["missionId"])),
              diagnostics: result.diagnostics.map((issue) => ({
                code: issue.code,
                message: issue.message,
                ...issue.details,
              })),
            },
          });
        return result.items;
      },
      query: query.queryMission,
    },
    watch: {
      watch: async (input: Parameters<MissionWatchPort["watch"]>[0]) => {
        await assertMission(input.missionId);
        return await watch.watch(input);
      },
    },
    board: {
      list: async (input: LocalHostSharedBoardListRequest) =>
        await readProductionSharedBoardList(
          options.controller,
          options.pragmaHome,
          input.missionId,
          (await readEnvelope(input.missionId)) !== undefined,
        ),
      read: async (input: LocalHostSharedBoardReadRequest) =>
        await readProductionSharedBoardItem(
          options.controller,
          options.pragmaHome,
          input.missionId,
          input.id,
          input.start,
          input.maxBytes,
          (await readEnvelope(input.missionId)) !== undefined,
        ),
      search: async (input: LocalHostSharedBoardSearchRequest) =>
        await searchProductionSharedBoard(
          options.controller,
          options.pragmaHome,
          input.missionId,
          input.query,
          input.maxResults,
          input.contextLines,
          input.caseSensitive,
          (await readEnvelope(input.missionId)) !== undefined,
        ),
    },
  };
}

async function openProductionSharedBoardStore(
  controller: MissionControllerStore,
  pragmaHome: string,
  missionId: string,
  hasEnvelope: boolean,
) {
  let snapshot;
  try {
    snapshot = await controller.readSnapshot({ missionId });
  } catch (error) {
    return rethrowBoardStorageError(error);
  }
  if (!hasEnvelope && !snapshot.events.some((event) => event.type === "mission.created")) {
    throw createIntegrationError({
      code: "MISSION_NOT_FOUND",
      category: "not_found",
      message: `Mission not found: ${missionId}.`,
      details: { missionId },
    });
  }
  let bindings;
  try {
    bindings = await createLocalHostMissionBoardBindings({ pragmaHome, missionId });
  } catch (error) {
    return rethrowBoardStorageError(error);
  }
  const shared = bindings.find((binding) => binding.namespace === LOCAL_HOST_SHARED_BOARD_STORE_ID);
  if (shared?.store === undefined) {
    throw createIntegrationError({
      code: "DEPENDENCY_UNAVAILABLE",
      category: "dependency",
      message: "The Local Host shared Mission Board is unavailable.",
    });
  }
  return shared.store;
}

async function readProductionSharedBoardList(
  controller: MissionControllerStore,
  pragmaHome: string,
  missionId: string,
  hasEnvelope: boolean,
) {
  const store = await openProductionSharedBoardStore(
    controller,
    pragmaHome,
    missionId,
    hasEnvelope,
  );
  const result = await store.listContext({});
  return unwrapBoardContextResult(result).map((item) => ({
    ...item,
    namespace: LOCAL_HOST_SHARED_BOARD_STORE_ID,
  }));
}

async function readProductionSharedBoardItem(
  controller: MissionControllerStore,
  pragmaHome: string,
  missionId: string,
  id: string,
  start: number,
  maxBytes: number,
  hasEnvelope: boolean,
) {
  const store = await openProductionSharedBoardStore(
    controller,
    pragmaHome,
    missionId,
    hasEnvelope,
  );
  const result = await store.readContext({ id, start, offset: maxBytes });
  return { ...unwrapBoardContextResult(result), namespace: LOCAL_HOST_SHARED_BOARD_STORE_ID };
}

async function searchProductionSharedBoard(
  controller: MissionControllerStore,
  pragmaHome: string,
  missionId: string,
  query: string,
  maxResults: number,
  contextLines: number,
  caseSensitive: boolean | undefined,
  hasEnvelope: boolean,
) {
  const store = await openProductionSharedBoardStore(
    controller,
    pragmaHome,
    missionId,
    hasEnvelope,
  );
  const [searchResult, listResult] = await Promise.all([
    store.searchContext({ query, maxResults, contextLines, caseSensitive }),
    store.listContext({}),
  ]);
  const summaries = unwrapBoardContextResult(listResult);
  const summariesById = new Map(
    summaries.map((item) => [item.id, { ...item, namespace: LOCAL_HOST_SHARED_BOARD_STORE_ID }]),
  );
  return unwrapBoardContextResult(searchResult).map((match) => ({
    ...match,
    item: summariesById.get(match.id) ?? {
      id: match.id,
      namespace: LOCAL_HOST_SHARED_BOARD_STORE_ID,
      metadata: { trigger: "manual" as const, priority: "normal" as const },
      revision: "unknown",
      sizeBytes: 0,
    },
  }));
}

function unwrapBoardContextResult<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string } },
): T {
  if (result.ok) return result.value;
  switch (result.error.code) {
    case "context_not_found":
      throw createIntegrationError({
        code: "BOARD_ITEM_NOT_FOUND",
        category: "not_found",
        message: "Mission Board item not found.",
      });
    case "permission_denied":
      throw createIntegrationError({
        code: "PERMISSION_DENIED",
        category: "permission",
        message: "Private Mission Board namespaces are not readable.",
      });
    case "invalid_input":
    case "context_too_large":
    case "context_budget_exceeded":
      throw createIntegrationError({
        code: "INVALID_ARGUMENT",
        category: "usage",
        message: "The Mission Board request is invalid.",
      });
    case "store_unavailable":
      throw createIntegrationError({
        code: "DEPENDENCY_UNAVAILABLE",
        category: "dependency",
        message: "The Mission Board storage is unavailable.",
      });
    case "store_error":
    default:
      throw createIntegrationError({
        code: "STORAGE_CORRUPTED",
        category: "protocol",
        message: "The Mission Board storage is corrupted.",
      });
  }
}

function rethrowBoardStorageError(error: unknown): never {
  const parsed = IntegrationErrorSchema.safeParse(error);
  if (parsed.success) throw parsed.data;
  throw createIntegrationError({
    code: "STORAGE_CORRUPTED",
    category: "protocol",
    message: "The Mission Board storage is corrupted.",
  });
}

async function listMissionSnapshots(
  controller: MissionControllerStore,
  repository: MissionStore,
  pragmaHome: string,
): Promise<LocalHostMissionListResult<Record<string, unknown>>> {
  const paths = new PragmaPaths({ pragmaHome });
  const missionsPath = paths.missionsRoot();
  let directories;
  try {
    directories = await readdir(missionsPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { items: [], diagnostics: [], warnings: [] };
    throw error;
  }
  const missionIds = new Set<string>();
  const diagnostics: IntegrationError[] = [];
  const warnings: IntegrationWarning[] = [];
  for (const entry of directories) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    let missionId: string;
    try {
      missionId = MissionIdSchema.parse(decodePragmaPathSegment(entry.name));
    } catch {
      const legacy = MissionIdSchema.safeParse(entry.name);
      if (!legacy.success) continue;
      missionId = legacy.data;
    }
    const ownerPath = join(missionsPath, entry.name);
    try {
      const present = await withFileLock(
        missionAggregateLockPath(missionsPath, missionId),
        async () => {
          const deletion = await readMissionDeletionRecord(paths, missionId).catch(
            (error: unknown) => {
              throw normalizeMissionReadError(error, missionId, "owner.inspect", "deletion-record");
            },
          );
          if (deletion !== undefined)
            throw missionDeletionReadError(
              missionId,
              "deletion-record",
              `deletion_${deletion.phase}`,
            );
          if (
            await hasMissionDeletionIntent(ownerPath, missionId).catch((error: unknown) => {
              throw normalizeMissionReadError(
                error,
                missionId,
                "owner.inspect",
                "deletion-intent.json",
              );
            })
          )
            throw missionDeletionReadError(missionId, "deletion-intent.json", "deletion_pending");
          const controllerDirectory = await missionFileStat(ownerPath, "local-host", missionId);
          const manifest = await missionFileStat(ownerPath, "mission.yaml", missionId);
          if (controllerDirectory === undefined && manifest === undefined) return false;
          if (manifest !== undefined && !manifest.isFile())
            throw localHostStorageError(missionId, "owner.inspect", "mission.yaml", "not_a_file");
          if (controllerDirectory !== undefined) {
            if (!controllerDirectory.isDirectory())
              throw localHostStorageError(
                missionId,
                "owner.inspect",
                "local-host",
                "not_a_directory",
              );
            const aggregate = await missionFileStat(
              ownerPath,
              "local-host/aggregate.json",
              missionId,
            );
            const journalFile = "local-host/.semantic-write-transaction.json";
            const journal = await missionFileStat(ownerPath, journalFile, missionId);
            if (aggregate === undefined || !aggregate.isFile())
              throw localHostStorageError(
                missionId,
                "owner.inspect",
                "local-host/aggregate.json",
                journal !== undefined && manifest === undefined
                  ? "journal_without_aggregate"
                  : aggregate === undefined
                    ? "missing"
                    : "not_a_file",
              );
            if (journal !== undefined) {
              try {
                const transaction = MissionSemanticWriteTransactionSchema.parse(
                  JSON.parse(await readFile(join(ownerPath, journalFile), "utf8")),
                );
                if (transaction.missionId !== missionId)
                  throw localHostStorageError(
                    missionId,
                    "transaction.inspect",
                    journalFile,
                    "owner_mismatch",
                  );
              } catch (error) {
                throw normalizeMissionReadError(
                  error,
                  missionId,
                  "transaction.inspect",
                  journalFile,
                );
              }
              warnings.push({
                code: "MISSION_TRANSACTION_PENDING",
                message: `Mission ${missionId} has a semantic write awaiting completion or recovery.`,
                details: {
                  missionId,
                  stage: "transaction.inspect",
                  file: journalFile,
                  reason: "semantic_write_pending",
                },
              });
            }
          }
          return true;
        },
        { operation: "mission.list-owner-inspect" },
      );
      if (present) missionIds.add(missionId);
    } catch (error) {
      const parsed = IntegrationErrorSchema.safeParse(error);
      if (!parsed.success) throw error;
      diagnostics.push(parsed.data);
    }
  }
  const snapshots: Array<Record<string, unknown> | undefined> = await Promise.all(
    [...missionIds].map(async (missionId) => {
      try {
        let envelope: Mission | undefined;
        try {
          // The repository owns the locked, journaled legacy-path upgrade even
          // when this Mission has only controller facts and no envelope.
          envelope = await repository.get(missionId);
        } catch (error) {
          if (IntegrationErrorSchema.safeParse(error).success) throw error;
          if (!(error instanceof MissionStoreError) || error.code !== "mission_not_found")
            throw normalizeMissionReadError(error, missionId, "repository.read", "mission.yaml");
        }
        let snapshot;
        try {
          snapshot = await controller.readSnapshot({ missionId });
        } catch (error) {
          if (IntegrationErrorSchema.safeParse(error).success) throw error;
          throw normalizeMissionReadError(
            error,
            missionId,
            "controller.read",
            "local-host/aggregate.json",
          );
        }
        const created = snapshot.events.find((event) => event.type === "mission.created");
        if (created === undefined && envelope === undefined) return undefined;
        const latest = snapshot.events.at(-1);
        const envelopeSummary =
          envelope === undefined
            ? undefined
            : projectMissionSummary({ missionId, snapshot, mission: envelope });
        const status =
          envelopeSummary?.status ?? missionStatus(snapshot.events.map((event) => event.type));
        const executor =
          envelope === undefined
            ? created?.data["executor"]
            : {
                kind: envelope.executor.kind,
                id: envelope.executor.ref.slice(envelope.executor.ref.indexOf(":") + 1),
              };
        return {
          id: missionId,
          missionId,
          title: envelope?.title ?? missionId,
          ...(executor === undefined ? {} : { executor }),
          ...(envelope === undefined
            ? created?.data["workspace"] === undefined
              ? {}
              : { workspace: { canonicalPath: created.data["workspace"] } }
            : { workspace: { canonicalPath: envelope.workspace.path } }),
          status,
          lifecycleStatus:
            envelope?.lifecycleStatus ??
            (["succeeded", "failed", "cancelled"].includes(status)
              ? "completed"
              : status === "queued"
                ? "queued"
                : "active"),
          execution:
            envelopeSummary === undefined
              ? executionSummary(snapshot.events)
              : envelopeSummary.execution,
          createdAt: envelope?.createdAt ?? created!.occurredAt,
          updatedAt: envelope?.updatedAt ?? latest?.occurredAt ?? created!.occurredAt,
          eventSequence: snapshot.snapshot.eventSequence,
          cursor: snapshot.cursor,
        };
      } catch (error) {
        const parsed = IntegrationErrorSchema.safeParse(error);
        if (!parsed.success) throw error;
        diagnostics.push(parsed.data);
        return undefined;
      }
    }),
  );
  return {
    items: snapshots
      .filter((snapshot): snapshot is Record<string, unknown> => snapshot !== undefined)
      .toSorted((left, right) =>
        String(right["updatedAt"]).localeCompare(String(left["updatedAt"])),
      ),
    diagnostics: diagnostics.toSorted((a, b) =>
      String(a.details?.["missionId"]).localeCompare(String(b.details?.["missionId"])),
    ),
    warnings,
  };
}

async function missionFileStat(ownerPath: string, file: string, missionId: string) {
  try {
    return await stat(join(ownerPath, file));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw normalizeMissionReadError(error, missionId, "owner.inspect", file);
  }
}

function normalizeMissionReadError(
  error: unknown,
  missionId: string,
  stage: string,
  file: string,
): IntegrationError {
  const parsed = IntegrationErrorSchema.safeParse(error);
  if (parsed.success)
    return IntegrationErrorSchema.parse({
      ...parsed.data,
      details: { missionId, stage, file, ...parsed.data.details },
    });
  if (error instanceof ZodError || error instanceof SyntaxError)
    return localHostStorageError(missionId, stage, file, "invalid_data");
  if (error instanceof MissionStoreError)
    return localHostStorageError(missionId, stage, file, error.code);
  if (isNodeError(error, "EACCES") || isNodeError(error, "EPERM"))
    return createIntegrationError({
      code: "PERMISSION_DENIED",
      category: "permission",
      message: `Cannot read Mission ${missionId}: ${file} (${error.code}).`,
      details: { missionId, stage, file, reason: error.code },
    });
  if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR") || isNodeError(error, "EISDIR"))
    return localHostStorageError(missionId, stage, file, error.code);
  throw error;
}

function localHostStorageError(
  missionId: string,
  stage: string,
  file: string,
  reason: string,
): IntegrationError {
  return createIntegrationError({
    code: "STORAGE_CORRUPTED",
    category: "protocol",
    message: `Mission ${missionId} is unavailable: ${file} (${reason}).`,
    details: { missionId, stage, file, reason },
  });
}

function missionDeletionReadError(
  missionId: string,
  file: string,
  reason: string,
): IntegrationError {
  return createIntegrationError({
    code: "MISSION_NOT_FOUND",
    category: "not_found",
    message: `Mission ${missionId} is unavailable during deletion (${reason}).`,
    details: { missionId, stage: "owner.inspect", file, reason },
  });
}

function missionStatus(
  eventTypes: readonly string[],
): "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" {
  for (const type of eventTypes.toReversed()) {
    switch (type) {
      case "run.succeeded":
        return "succeeded";
      case "run.failed":
        return "failed";
      case "run.interrupted":
        return "cancelled";
      case "run.input_required":
      case "human.requested":
      case "human.interaction.requested":
        return "waiting";
      case "run.started":
      case "execution.started":
        return "running";
      case "run.accepted":
        return "queued";
    }
  }
  return "queued";
}

function executionSummary(
  events: readonly { readonly type: string; readonly data: Record<string, unknown> }[],
): Record<string, unknown> | undefined {
  const started = events.toReversed().find((event) => event.type === "run.started");
  if (started === undefined) return undefined;
  const executionId = started.data["executionId"];
  const status = missionStatus(events.map((event) => event.type));
  return {
    ...(typeof executionId === "string" ? { id: executionId } : {}),
    status: status === "cancelled" ? "interrupted" : status,
  };
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException & { readonly code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
