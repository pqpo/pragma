import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { PragmaPaths } from "./pragma-paths.ts";

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
}): Promise<StorageDeletionResult> {
  const deletionId = randomUUID();
  const journal = input.paths.deletionJournalRoot();
  const journalPath = join(journal, `${deletionId}.json`);
  const trash = join(input.paths.trashRoot(), deletionId);
  const startedAt = new Date().toISOString();
  await mkdir(journal, { recursive: true, mode: 0o700 });
  await mkdir(trash, { recursive: true, mode: 0o700 });
  await writeJournal(journalPath, {
    schemaVersion: "pragma.storage-deletion/v1",
    deletionId,
    owner: input.owner,
    status: "moving",
    sources: input.sources,
    moved: [],
    startedAt,
  });

  const moved: string[] = [];
  for (const source of input.sources) {
    assertLabel(source.label);
    const target = join(trash, source.label);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await rename(source.path, target);
      moved.push(source.label);
      await writeJournal(journalPath, {
        schemaVersion: "pragma.storage-deletion/v1",
        deletionId,
        owner: input.owner,
        status: "moving",
        sources: input.sources,
        moved,
        startedAt,
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  await writeJournal(journalPath, {
    schemaVersion: "pragma.storage-deletion/v1",
    deletionId,
    owner: input.owner,
    status: "trashed",
    sources: input.sources,
    moved,
    startedAt,
    completedAt: new Date().toISOString(),
  });
  return { deletionId, moved };
}

export async function runtimeSessionDeletionSources(
  paths: PragmaPaths,
  ownerId: string,
): Promise<StorageDeletionSource[]> {
  const ownerRoot = paths.runtimeOwnerRoot(ownerId);
  const sources: StorageDeletionSource[] = [{ label: "runtime-sessions", path: ownerRoot }];
  let children;
  try {
    children = await readdir(ownerRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return sources;
    throw error;
  }
  for (const child of children) {
    if (!child.isDirectory()) continue;
    try {
      const manifest = JSON.parse(
        await readFile(join(ownerRoot, child.name, "session.json"), "utf8"),
      ) as { readonly systemSessionId?: unknown };
      if (typeof manifest.systemSessionId === "string") {
        sources.push({
          label: join("runtime-session-owners", `${child.name}.json`),
          path: paths.runtimeSessionOwner(manifest.systemSessionId),
        });
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return sources;
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
