import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { encodePragmaPathSegment, PragmaPaths } from "./pragma-paths.ts";
import {
  commitRuntimeSessionCatalogDeletion,
  completeRuntimeSessionCatalogDeletion,
  prepareRuntimeSessionCatalogDeletion,
  withRuntimeSessionCatalogDeletionLock,
} from "./migrations/runtime-session-catalog/index.ts";

export class StorageDeletionCommittedError extends Error {
  readonly code = "STORAGE_DELETION_COMMITTED_FINALIZATION_PENDING";
  constructor(cause: unknown) {
    super("Storage deletion committed; finalization needs recovery.", { cause });
  }
}

export interface StorageDeletionSource {
  readonly label: string;
  readonly path: string;
}

export interface StorageDeletionResult {
  readonly deletionId: string;
  readonly moved: readonly string[];
}

export async function moveOwnedStorageToTrash(input: {
  readonly paths: PragmaPaths;
  readonly owner: { readonly type: string; readonly id: string };
  readonly sources: readonly StorageDeletionSource[];
  readonly deletionId?: string | undefined;
  readonly onPhase?:
    ((phase: "file_move" | "catalog_commit", durationMs: number) => void) | undefined;
  readonly onCommitted?: (() => Promise<void>) | undefined;
  readonly runtimeSessionOwnerIds?: readonly string[] | undefined;
}): Promise<StorageDeletionResult> {
  if (input.runtimeSessionOwnerIds !== undefined) {
    return await withRuntimeSessionCatalogDeletionLock(input.paths, () =>
      moveOwnedStorageToTrashUnlocked(input),
    );
  }
  return await moveOwnedStorageToTrashUnlocked(input);
}

async function moveOwnedStorageToTrashUnlocked(input: {
  readonly paths: PragmaPaths;
  readonly owner: { readonly type: string; readonly id: string };
  readonly sources: readonly StorageDeletionSource[];
  readonly deletionId?: string | undefined;
  readonly onPhase?:
    ((phase: "file_move" | "catalog_commit", durationMs: number) => void) | undefined;
  readonly onCommitted?: (() => Promise<void>) | undefined;
  readonly runtimeSessionOwnerIds?: readonly string[] | undefined;
}): Promise<StorageDeletionResult> {
  const deletionId = input.deletionId ?? randomUUID();
  const journal = input.paths.deletionJournalRoot();
  const journalPath = join(journal, `${deletionId}.json`);
  const trash = join(input.paths.trashRoot(), deletionId);
  const startedAt = new Date().toISOString();
  for (const source of input.sources) assertLabel(source.label);
  await mkdir(journal, { recursive: true, mode: 0o700 });
  await mkdir(trash, { recursive: true, mode: 0o700 });
  await writeJournal(journalPath, {
    schemaVersion: "pragma.storage-deletion/v1",
    deletionId,
    owner: input.owner,
    status: "moving",
    sources: input.sources,
    moved: [],
    ...(input.runtimeSessionOwnerIds === undefined
      ? {}
      : { runtimeSessionOwnerIds: [...new Set(input.runtimeSessionOwnerIds)] }),
    startedAt,
  });
  if (input.runtimeSessionOwnerIds !== undefined) {
    await prepareRuntimeSessionCatalogDeletion(
      input.paths,
      deletionId,
      input.runtimeSessionOwnerIds,
    );
  }

  const moved: string[] = [];
  const moveStarted = performance.now();
  // The complete source list is already journaled. Recovery checks source and
  // target for every entry, including a rename whose progress was not written.
  // Rewriting that same full list after each rename adds quadratic I/O.
  for (let offset = 0; offset < input.sources.length; offset += 16) {
    const results = await Promise.allSettled(
      input.sources.slice(offset, offset + 16).map(async (source) => {
        const target = join(trash, source.label);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        try {
          await rename(source.path, target);
          moved.push(source.label);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  input.onPhase?.("file_move", performance.now() - moveStarted);
  if (input.runtimeSessionOwnerIds !== undefined) {
    await writeJournal(journalPath, {
      schemaVersion: "pragma.storage-deletion/v1",
      deletionId,
      owner: input.owner,
      status: "catalog-pending",
      sources: input.sources,
      moved,
      runtimeSessionOwnerIds: [...new Set(input.runtimeSessionOwnerIds)],
      startedAt,
    });
    const catalogStarted = performance.now();
    await commitRuntimeSessionCatalogDeletion(input.paths, deletionId);
    input.onPhase?.("catalog_commit", performance.now() - catalogStarted);
  }
  try {
    await writeJournal(journalPath, {
      schemaVersion: "pragma.storage-deletion/v1",
      deletionId,
      owner: input.owner,
      status: "trashed",
      sources: input.sources,
      moved,
      ...(input.runtimeSessionOwnerIds === undefined
        ? {}
        : { runtimeSessionOwnerIds: [...new Set(input.runtimeSessionOwnerIds)] }),
      startedAt,
      completedAt: new Date().toISOString(),
    });
    if (input.runtimeSessionOwnerIds !== undefined) {
      await completeRuntimeSessionCatalogDeletion(input.paths, deletionId);
    }
    await input.onCommitted?.();
  } catch (error) {
    throw new StorageDeletionCommittedError(error);
  }
  return { deletionId, moved };
}

export async function runtimeSessionDeletionSources(
  paths: PragmaPaths,
  ownerId: string,
): Promise<StorageDeletionSource[]> {
  const ownerRoot = paths.runtimeOwnerRoot(ownerId);
  return [{ label: `runtime-sessions/${encodePragmaPathSegment(ownerId)}`, path: ownerRoot }];
}

async function writeJournal(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function assertLabel(label: string): void {
  if (label === "" || label.startsWith("/") || label.split(/[\\/]/).includes("..")) {
    throw new Error(`Invalid storage deletion label: ${label}`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export { recoverRuntimeSessionDeletion } from "./migrations/runtime-session-catalog/index.ts";
