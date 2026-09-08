import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/core";
import type { ContextStoreDraftOverlay } from "@pragma/built-in-agents/contracts";

import {
  ContextStoreEditorDraftSchema,
  ContextStoreSnapshotSchema,
  type ContextStore,
  type ContextStoreContent,
  type ContextStoreContentMetadata,
  type ContextStoreEditorDraft,
  type ContextStoreEntry,
  type ContextStoreSnapshot,
} from "../../../shared/contracts/index.ts";
import {
  contextStoreDraftFileRevision,
  contextStoreOverlayBetween,
  materializeDraftSnapshot,
} from "./context-store-draft-store.ts";
import { hashSnapshotContent, type ContextStoreStore } from "./context-store-store.ts";

export interface ContextStoreEditorDraftService {
  get(storeId: string): Promise<ContextStoreEditorDraft | undefined>;
  listEntries(storeId: string): Promise<readonly ContextStoreEntry[]>;
  getContent(storeId: string, id: string): Promise<ContextStoreContent>;
  createFolder(storeId: string, id: string): Promise<void>;
  createFile(
    storeId: string,
    id: string,
    content: string,
    metadata: ContextStoreContentMetadata,
  ): Promise<ContextStoreContent>;
  updateFile(
    storeId: string,
    id: string,
    content: string,
    metadata: ContextStoreContentMetadata,
    expectedRevision: string,
  ): Promise<ContextStoreContent>;
  renameEntry(
    storeId: string,
    id: string,
    nextId: string,
    kind: "file" | "directory",
  ): Promise<void>;
  deleteEntry(storeId: string, id: string, kind: "file" | "directory"): Promise<void>;
  commit(storeId: string, expectedRevision: number): Promise<ContextStore>;
  discard(storeId: string, expectedRevision: number): Promise<void>;
}

export function createContextStoreEditorDraftService(options: {
  readonly draftsPath: string;
  readonly stores: ContextStoreStore;
}): ContextStoreEditorDraftService {
  const draftRoot = (storeId: string) => join(options.draftsPath, storeId);
  const draftPath = (storeId: string) => join(draftRoot(storeId), "draft.json");
  const lockPath = (storeId: string) => join(options.draftsPath, ".locks", `${storeId}.lock`);

  const readDraft = async (storeId: string): Promise<ContextStoreEditorDraft | undefined> => {
    try {
      const draft = ContextStoreEditorDraftSchema.parse(
        JSON.parse(await readFile(draftPath(storeId), "utf8")) as unknown,
      );
      if (draft.storeId !== storeId) throw new Error("Knowledge editor draft identity mismatch.");
      return draft;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };

  const writeDraft = async (draft: ContextStoreEditorDraft): Promise<void> => {
    const path = draftPath(draft.storeId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  };

  const effectiveSnapshot = async (
    storeId: string,
  ): Promise<{
    draft: ContextStoreEditorDraft | undefined;
    base: ContextStoreSnapshot;
    effective: ContextStoreSnapshot;
  }> => {
    const draft = await readDraft(storeId);
    const base = await options.stores.getSnapshot(storeId, draft?.baseRevision);
    return {
      draft,
      base,
      effective: draft === undefined ? base : materializeDraftSnapshot(draft, base),
    };
  };

  const mutate = async (
    storeId: string,
    update: (snapshot: ContextStoreSnapshot) => Pick<ContextStoreSnapshot, "files" | "directories">,
  ): Promise<{ draft: ContextStoreEditorDraft | undefined; effective: ContextStoreSnapshot }> =>
    await withFileLock(lockPath(storeId), async () => {
      const loaded = await effectiveSnapshot(storeId);
      const next = update(loaded.effective);
      const overlay = contextStoreOverlayBetween(loaded.base, next);
      if (overlayIsEmpty(overlay)) {
        await rm(draftRoot(storeId), { recursive: true, force: true });
        return { draft: undefined, effective: { ...loaded.base, ...next } };
      }
      const timestamp = new Date().toISOString();
      const draft = ContextStoreEditorDraftSchema.parse({
        schemaVersion: "pragma.context-store-editor-draft/v1",
        revision: (loaded.draft?.revision ?? 0) + 1,
        storeId,
        baseRevision: loaded.base.revision,
        baseSnapshotHash: loaded.base.snapshotHash,
        overlay,
        createdAt: loaded.draft?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      await writeDraft(draft);
      return {
        draft,
        effective: ContextStoreSnapshotSchema.parse({ ...loaded.base, ...next }),
      };
    });

  const findFile = (snapshot: ContextStoreSnapshot, id: string) => {
    const file = snapshot.files.find((candidate) => candidate.id === id);
    if (file === undefined) throw new Error(`Entry not found: ${id}`);
    return file;
  };

  return {
    get: readDraft,
    async listEntries(storeId) {
      const { effective } = await effectiveSnapshot(storeId);
      return [
        ...effective.directories.map((id) => ({ id, kind: "directory" as const })),
        ...effective.files.map((file) => ({
          id: file.id,
          kind: "file" as const,
          sizeBytes: Buffer.byteLength(file.content, "utf8"),
          revision: contextStoreDraftFileRevision(file.content, file.metadata),
        })),
      ].toSorted((left, right) => left.id.localeCompare(right.id));
    },
    async getContent(storeId, id) {
      const { effective } = await effectiveSnapshot(storeId);
      return contentResult(findFile(effective, id));
    },
    async createFolder(storeId, id) {
      await mutate(storeId, (snapshot) => {
        if (snapshot.directories.includes(id) || snapshot.files.some((file) => file.id === id)) {
          throw new Error(`Entry already exists: ${id}`);
        }
        return { files: snapshot.files, directories: [...snapshot.directories, id].toSorted() };
      });
    },
    async createFile(storeId, id, content, metadata) {
      const result = await mutate(storeId, (snapshot) => {
        if (snapshot.files.some((file) => file.id === id)) {
          throw new Error(`Entry already exists: ${id}`);
        }
        return {
          directories: snapshot.directories,
          files: [...snapshot.files, { id, content, metadata }].toSorted((a, b) =>
            a.id.localeCompare(b.id),
          ),
        };
      });
      return contentResult(findFile(result.effective, id));
    },
    async updateFile(storeId, id, content, metadata, expectedRevision) {
      const result = await mutate(storeId, (snapshot) => {
        const current = findFile(snapshot, id);
        if (contextStoreDraftFileRevision(current.content, current.metadata) !== expectedRevision) {
          throw new Error(`Context revision conflict: ${id}`);
        }
        return {
          directories: snapshot.directories,
          files: snapshot.files.map((file) => (file.id === id ? { id, content, metadata } : file)),
        };
      });
      return contentResult(findFile(result.effective, id));
    },
    async renameEntry(storeId, id, nextId, kind) {
      await mutate(storeId, (snapshot) => {
        if (
          snapshot.files.some((file) => file.id === nextId) ||
          snapshot.directories.includes(nextId)
        ) {
          throw new Error(`Entry already exists: ${nextId}`);
        }
        const prefix = `${id}/`;
        if (kind === "file") findFile(snapshot, id);
        else if (!snapshot.directories.includes(id)) throw new Error(`Entry not found: ${id}`);
        return {
          files: snapshot.files.map((file) => ({
            ...file,
            id:
              file.id === id
                ? nextId
                : file.id.startsWith(prefix)
                  ? `${nextId}/${file.id.slice(prefix.length)}`
                  : file.id,
          })),
          directories: snapshot.directories.map((directory) =>
            directory === id
              ? nextId
              : directory.startsWith(prefix)
                ? `${nextId}/${directory.slice(prefix.length)}`
                : directory,
          ),
        };
      });
    },
    async deleteEntry(storeId, id, kind) {
      await mutate(storeId, (snapshot) => {
        const prefix = `${id}/`;
        if (kind === "file") findFile(snapshot, id);
        else if (!snapshot.directories.includes(id)) throw new Error(`Entry not found: ${id}`);
        return {
          files: snapshot.files.filter((file) => file.id !== id && !file.id.startsWith(prefix)),
          directories: snapshot.directories.filter(
            (directory) => directory !== id && !directory.startsWith(prefix),
          ),
        };
      });
    },
    async commit(storeId, expectedRevision) {
      return await withFileLock(lockPath(storeId), async () => {
        const loaded = await effectiveSnapshot(storeId);
        if (loaded.draft === undefined) {
          const store = (await options.stores.list()).find((candidate) => candidate.id === storeId);
          if (store === undefined) throw new Error("The knowledge base no longer exists.");
          return store;
        }
        if (loaded.draft.revision !== expectedRevision)
          throw new Error("The editor draft changed. Refresh and try again.");
        const current = await options.stores.getSnapshot(storeId);
        const effective =
          current.revision === loaded.base.revision &&
          current.snapshotHash === loaded.base.snapshotHash
            ? loaded.effective
            : rebaseEditorDraft(loaded.base, loaded.effective, current, loaded.draft.overlay);
        const committed = await options.stores.appendSnapshot(
          {
            storeId,
            baseRevision: current.revision,
            baseSnapshotHash: current.snapshotHash,
            snapshotHash: hashSnapshotContent(effective.files, effective.directories),
            directories: effective.directories,
            files: effective.files,
            summary: summarizeOverlay(loaded.draft.overlay),
          },
          "user",
        );
        await rm(draftRoot(storeId), { recursive: true, force: true });
        return committed;
      });
    },
    async discard(storeId, expectedRevision) {
      await withFileLock(lockPath(storeId), async () => {
        const current = await readDraft(storeId);
        if (current !== undefined && current.revision !== expectedRevision) {
          throw new Error("The editor draft changed. Refresh and try again.");
        }
        await rm(draftRoot(storeId), { recursive: true, force: true });
      });
    },
  };
}

function rebaseEditorDraft(
  base: ContextStoreSnapshot,
  desired: ContextStoreSnapshot,
  current: ContextStoreSnapshot,
  overlay: ContextStoreDraftOverlay,
): ContextStoreSnapshot {
  const baseFiles = new Map(base.files.map((file) => [file.id, file]));
  const desiredFiles = new Map(desired.files.map((file) => [file.id, file]));
  const currentFiles = new Map(current.files.map((file) => [file.id, file]));
  const changedFiles = new Set([...overlay.files.map((file) => file.id), ...overlay.deletedFiles]);
  const conflicts = [...changedFiles].filter((id) => {
    const before = JSON.stringify(baseFiles.get(id));
    const latest = JSON.stringify(currentFiles.get(id));
    const next = JSON.stringify(desiredFiles.get(id));
    return before !== latest && next !== latest;
  });
  for (const directory of overlay.deletedDirectories) {
    const prefix = `${directory}/`;
    const affected = new Set(
      [...base.files, ...current.files]
        .filter((file) => file.id.startsWith(prefix))
        .map((file) => file.id),
    );
    if (
      [...affected].some(
        (id) => JSON.stringify(baseFiles.get(id)) !== JSON.stringify(currentFiles.get(id)),
      )
    ) {
      conflicts.push(directory);
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Knowledge draft conflicts with newer changes: ${conflicts.toSorted().join(", ")}`,
    );
  }

  const mergedFiles = new Map(currentFiles);
  for (const id of changedFiles) {
    const selected = desiredFiles.get(id);
    if (selected === undefined) mergedFiles.delete(id);
    else mergedFiles.set(id, selected);
  }
  for (const directory of overlay.deletedDirectories) {
    const prefix = `${directory}/`;
    for (const id of mergedFiles.keys()) if (id.startsWith(prefix)) mergedFiles.delete(id);
  }
  const directories = new Set(current.directories);
  for (const id of overlay.deletedDirectories) {
    directories.delete(id);
    const prefix = `${id}/`;
    for (const nested of [...directories])
      if (nested.startsWith(prefix)) directories.delete(nested);
  }
  for (const id of overlay.directories) directories.add(id);
  return ContextStoreSnapshotSchema.parse({
    ...current,
    directories: [...directories].toSorted(),
    files: [...mergedFiles.values()].toSorted((left, right) => left.id.localeCompare(right.id)),
  });
}

function contentResult(file: ContextStoreSnapshot["files"][number]): ContextStoreContent {
  const revision = contextStoreDraftFileRevision(file.content, file.metadata);
  return {
    ...file,
    revision,
    etag: revision,
    sizeBytes: Buffer.byteLength(file.content, "utf8"),
    truncated: false,
  };
}

function overlayIsEmpty(overlay: ContextStoreDraftOverlay): boolean {
  return (
    overlay.files.length === 0 &&
    overlay.deletedFiles.length === 0 &&
    overlay.directories.length === 0 &&
    overlay.deletedDirectories.length === 0
  );
}

function summarizeOverlay(overlay: ContextStoreDraftOverlay): string {
  const changes =
    overlay.files.length +
    overlay.deletedFiles.length +
    overlay.directories.length +
    overlay.deletedDirectories.length;
  return `Manual save (${changes} changed ${changes === 1 ? "entry" : "entries"}).`;
}
