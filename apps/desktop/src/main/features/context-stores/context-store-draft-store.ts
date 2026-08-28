import { createHash } from "node:crypto";

import {
  InMemoryContextStore,
  error,
  type ExpertAgentContextResult,
  type ExpertAgentContextStore,
  type ExpertAgentStoredContextItem,
  type ExpertAgentStoredContextItemDeleteInput,
  type ExpertAgentStoredContextItemEditInput,
  type ExpertAgentStoredContextItemEditResult,
  type ExpertAgentStoredContextItemReadInput,
  type ExpertAgentStoredContextItemReadResult,
  type ExpertAgentStoredContextItemSearchInput,
  type ExpertAgentContextItemListInput,
  type ExpertAgentContextItemSearchMatch,
  type ExpertAgentContextItemSummary,
  type ExpertAgentStoredContextRegisterInput,
} from "@pragma/core";
import {
  ContextStoreDraftOverlaySchema,
  ContextStoreDraftSchema,
  type ContextStoreDraft,
  type ContextStoreDraftOverlay,
} from "@pragma/built-in-agents/contracts";

import type { ContextStoreSnapshot } from "../../../shared/contracts/index.ts";

export interface ContextStoreDraftPersistence {
  read(draftId: string): Promise<ContextStoreDraft>;
  readBase(draft: ContextStoreDraft): Promise<ContextStoreSnapshot>;
  mutate(
    draftId: string,
    expectedRevision: number,
    update: (draft: ContextStoreDraft) => ContextStoreDraftOverlay,
  ): Promise<ContextStoreDraft>;
}

/**
 * A copy-on-write Context Store. The immutable base snapshot remains authoritative for every path
 * absent from the overlay; only changed files and deletion tombstones are persisted with the draft.
 */
export class SparseContextStoreDraft implements ExpertAgentContextStore {
  constructor(
    readonly draftId: string,
    private readonly persistence: ContextStoreDraftPersistence,
  ) {}

  async listContext(
    input: ExpertAgentContextItemListInput = {},
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>> {
    const effective = await this.effectiveStore();
    return await effective.listContext(input);
  }

  async readContext(
    input: ExpertAgentStoredContextItemReadInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult>> {
    const effective = await this.effectiveStore();
    return await effective.readContext(input);
  }

  async searchContext(
    input: ExpertAgentStoredContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    const effective = await this.effectiveStore();
    return await effective.searchContext(input);
  }

  async addContext(
    input: ExpertAgentStoredContextRegisterInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    const loaded = await this.load();
    if (["merging", "merged"].includes(loaded.draft.state)) {
      return error("permission_denied", "Merging and merged knowledge drafts are read-only.");
    }
    const effective = createEffectiveStore(loaded.base, loaded.draft.overlay);
    const result = await effective.addContext(input);
    if (!result.ok) return result;
    try {
      const updated = await this.persistence.mutate(this.draftId, loaded.draft.revision, (draft) =>
        overlayWithFile(draft.overlay, loaded.base, result.value),
      );
      void updated;
      return result;
    } catch (mutationError) {
      return conflict(mutationError);
    }
  }

  async editContext(
    input: ExpertAgentStoredContextItemEditInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemEditResult>> {
    const loaded = await this.load();
    if (["merging", "merged"].includes(loaded.draft.state)) {
      return error("permission_denied", "Merging and merged knowledge drafts are read-only.");
    }
    const effective = createEffectiveStore(loaded.base, loaded.draft.overlay);
    const result = await effective.editContext(input);
    if (!result.ok) return result;
    try {
      const updated = await this.persistence.mutate(this.draftId, loaded.draft.revision, (draft) =>
        overlayWithFile(draft.overlay, loaded.base, result.value),
      );
      void updated;
      return result;
    } catch (mutationError) {
      return conflict(mutationError);
    }
  }

  async deleteContext(
    input: ExpertAgentStoredContextItemDeleteInput,
  ): Promise<ExpertAgentContextResult<{ readonly id: string }>> {
    const loaded = await this.load();
    if (["merging", "merged"].includes(loaded.draft.state)) {
      return error("permission_denied", "Merging and merged knowledge drafts are read-only.");
    }
    const effective = createEffectiveStore(loaded.base, loaded.draft.overlay);
    const result = await effective.deleteContext(input);
    if (!result.ok) return result;
    try {
      await this.persistence.mutate(this.draftId, loaded.draft.revision, (draft) =>
        overlayWithoutFile(draft.overlay, loaded.base, input.id),
      );
      return result;
    } catch (mutationError) {
      return conflict(mutationError);
    }
  }

  async updateFile(input: {
    readonly id: string;
    readonly content: string;
    readonly metadata: ExpertAgentStoredContextItem["metadata"];
    readonly expectedRevision: string;
  }): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    const loaded = await this.load();
    if (["merging", "merged"].includes(loaded.draft.state)) {
      return error("permission_denied", "Merging and merged knowledge drafts are read-only.");
    }
    const effective = createEffectiveStore(loaded.base, loaded.draft.overlay);
    const result = await effective.editContext({
      id: input.id,
      mode: "replace",
      content: input.content,
      expectedRevision: input.expectedRevision,
    });
    if (!result.ok) return result;
    const value = { ...result.value, metadata: input.metadata };
    try {
      await this.persistence.mutate(this.draftId, loaded.draft.revision, (draft) =>
        overlayWithFile(draft.overlay, loaded.base, value),
      );
      return { ok: true, value };
    } catch (mutationError) {
      return conflict(mutationError);
    }
  }

  private async effectiveStore(): Promise<InMemoryContextStore> {
    const loaded = await this.load();
    return createEffectiveStore(loaded.base, loaded.draft.overlay);
  }

  private async load(): Promise<{ draft: ContextStoreDraft; base: ContextStoreSnapshot }> {
    const draft = ContextStoreDraftSchema.parse(await this.persistence.read(this.draftId));
    const base = await this.persistence.readBase(draft);
    if (
      base.storeId !== draft.storeId ||
      base.revision !== draft.baseRevision ||
      base.snapshotHash !== draft.baseSnapshotHash
    ) {
      throw new Error("context_store_draft_base_mismatch");
    }
    return { draft, base };
  }
}

export function materializeDraftSnapshot(
  draft: ContextStoreDraft,
  base: ContextStoreSnapshot,
): ContextStoreSnapshot {
  const deletedFiles = new Set(draft.overlay.deletedFiles);
  const deletedDirectories = new Set(draft.overlay.deletedDirectories);
  const isInsideDeletedDirectory = (id: string) =>
    [...deletedDirectories].some((directory) =>
      id.startsWith(`${directory.replace(/\/+$/gu, "")}/`),
    );
  const byId = new Map(
    base.files
      .filter((file) => !deletedFiles.has(file.id) && !isInsideDeletedDirectory(file.id))
      .map((file) => [file.id, { ...file }] as const),
  );
  for (const file of draft.overlay.files) byId.set(file.id, { ...file });

  const directories = new Set(
    base.directories.filter((directory) => !deletedDirectories.has(directory)),
  );
  for (const directory of draft.overlay.directories) directories.add(directory);

  return {
    schemaVersion: "pragma.context-store-snapshot/v1",
    storeId: draft.storeId,
    revision: draft.baseRevision,
    snapshotHash: draft.baseSnapshotHash,
    createdAt: draft.updatedAt,
    directories: [...directories].toSorted(),
    files: [...byId.values()].toSorted((left, right) => left.id.localeCompare(right.id)),
  };
}

function createEffectiveStore(
  base: ContextStoreSnapshot,
  overlay: ContextStoreDraftOverlay,
): InMemoryContextStore {
  const draft = ContextStoreDraftSchema.parse({
    schemaVersion: "pragma.context-store-draft/v1",
    id: "00000000-0000-4000-8000-000000000000",
    revision: 1,
    name: "effective",
    storeId: base.storeId,
    baseRevision: base.revision,
    baseSnapshotHash: base.snapshotHash,
    state: "editing",
    overlay,
    createdAt: base.createdAt,
    updatedAt: base.createdAt,
  });
  const snapshot = materializeDraftSnapshot(draft, base);
  return new InMemoryContextStore({
    context: snapshot.files.map((file) => ({
      ...file,
      revision: fileRevision(file.content, file.metadata),
      etag: fileRevision(file.content, file.metadata),
    })) as readonly import("@pragma/core").ExpertAgentContextItemSeed[],
  });
}

function overlayWithFile(
  overlay: ContextStoreDraftOverlay,
  base: ContextStoreSnapshot,
  file: ExpertAgentStoredContextItem,
): ContextStoreDraftOverlay {
  const baseFile = base.files.find((candidate) => candidate.id === file.id);
  const files = overlay.files.filter((candidate) => candidate.id !== file.id);
  if (
    baseFile === undefined ||
    baseFile.content !== file.content ||
    JSON.stringify(baseFile.metadata) !== JSON.stringify(file.metadata)
  ) {
    files.push({ id: file.id, content: file.content, metadata: file.metadata });
  }
  return ContextStoreDraftOverlaySchema.parse({
    ...overlay,
    files: files.toSorted((left, right) => left.id.localeCompare(right.id)),
    deletedFiles: overlay.deletedFiles.filter((id) => id !== file.id),
  });
}

function overlayWithoutFile(
  overlay: ContextStoreDraftOverlay,
  base: ContextStoreSnapshot,
  id: string,
): ContextStoreDraftOverlay {
  const deletedFiles = overlay.deletedFiles.filter((candidate) => candidate !== id);
  if (base.files.some((file) => file.id === id)) deletedFiles.push(id);
  return ContextStoreDraftOverlaySchema.parse({
    ...overlay,
    files: overlay.files.filter((file) => file.id !== id),
    deletedFiles: deletedFiles.toSorted(),
  });
}

function fileRevision(content: string, metadata: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([content, metadata]))
    .digest("hex");
}

function conflict<T>(mutationError: unknown): ExpertAgentContextResult<T> {
  return error("context_conflict", "The knowledge draft changed. Read it again and retry.", {
    cause: mutationError instanceof Error ? mutationError.message : String(mutationError),
  });
}
