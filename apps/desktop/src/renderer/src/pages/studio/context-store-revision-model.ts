import type {
  ContextStoreDraft,
  ContextStoreRevisionJob,
  ContextStoreRevisionRecord,
  ContextStoreRevisionDiff,
} from "../../../../shared/contracts/index.ts";

export function unlinkedRevisionDrafts(
  drafts: readonly ContextStoreDraft[],
  jobs: readonly ContextStoreRevisionJob[],
  storeId: string,
): ContextStoreDraft[] {
  const linkedDraftIds = new Set(jobs.map((job) => job.draftId));
  return drafts.filter(
    (draft) =>
      (storeId === "" || draft.storeId === storeId) &&
      draft.state !== "merged" &&
      !linkedDraftIds.has(draft.id),
  );
}

export type RevisionEntry =
  | {
      kind: "manual";
      key: string;
      updatedAt: string;
      source: "manual";
      state: "merged";
      record: ContextStoreRevisionRecord;
    }
  | {
      kind: "job";
      key: string;
      updatedAt: string;
      source: ContextStoreRevisionJob["request"]["source"];
      state: ContextStoreRevisionJob["state"] | "awaiting_confirmation";
      job: ContextStoreRevisionJob;
    };

export function isDraftAwaitingConfirmation(job: ContextStoreRevisionJob): boolean {
  return (
    (job.state === "editing" && job.missionId !== undefined) ||
    (job.state === "needs_attention" && job.error?.code === "draft_not_submitted")
  );
}

export function revisionEntries(
  jobs: readonly ContextStoreRevisionJob[],
  records: readonly ContextStoreRevisionRecord[],
): RevisionEntry[] {
  return [
    ...records
      .filter((record) => record.author === "user" && record.parentRevision !== null)
      .map((record): RevisionEntry => ({
        kind: "manual",
        key: `manual:${record.storeId}:${record.revision}`,
        updatedAt: record.createdAt,
        source: "manual",
        state: "merged",
        record,
      })),
    ...jobs.map((job): RevisionEntry => ({
      kind: "job",
      key: `job:${job.id}`,
      updatedAt: job.updatedAt,
      source: job.request.source,
      state: isDraftAwaitingConfirmation(job) ? "awaiting_confirmation" : job.state,
      job,
    })),
  ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.key.localeCompare(b.key));
}

export function filterRevisionEntries(
  entries: readonly RevisionEntry[],
  state: string,
  source: string,
  storeId = "",
): RevisionEntry[] {
  return entries.filter(
    (entry) =>
      (storeId === "" ||
        (entry.kind === "manual" ? entry.record.storeId : entry.job.request.storeId) === storeId) &&
      (source === "" || entry.source === source) &&
      (state === "" ||
        (state === "actionable"
          ? ["pending_review", "needs_rebase", "needs_attention", "awaiting_confirmation"].includes(
              entry.state,
            )
          : entry.state === state)),
  );
}

export function revisionPage<T>(entries: readonly T[], page: number, pageSize: number) {
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
  const currentPage = Math.max(1, Math.min(page, pageCount));
  return {
    pageCount,
    currentPage,
    items: entries.slice((currentPage - 1) * pageSize, currentPage * pageSize),
  };
}

export interface SnapshotDiffItem {
  readonly id: string;
  readonly kind: "file" | "metadata" | "directory";
  readonly before: string;
  readonly after: string;
  readonly operation: "addition" | "deletion" | "modification";
}

export function snapshotDiffItems({ before, after }: ContextStoreRevisionDiff): SnapshotDiffItem[] {
  const items: SnapshotDiffItem[] = [];
  const previous = new Map(before.files.map((file) => [file.id, file]));
  const next = new Map(after.files.map((file) => [file.id, file]));
  for (const id of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
    const oldFile = previous.get(id);
    const newFile = next.get(id);
    const operation =
      oldFile === undefined ? "addition" : newFile === undefined ? "deletion" : "modification";
    if (oldFile === undefined || newFile === undefined || oldFile.content !== newFile.content) {
      items.push({
        id,
        kind: "file",
        before: oldFile?.content ?? "",
        after: newFile?.content ?? "",
        operation,
      });
    }
    const oldMetadata = metadataText(oldFile?.metadata);
    const newMetadata = metadataText(newFile?.metadata);
    if (oldMetadata !== newMetadata)
      items.push({ id, kind: "metadata", before: oldMetadata, after: newMetadata, operation });
  }
  for (const id of [...new Set([...before.directories, ...after.directories])].sort()) {
    const existed = before.directories.includes(id);
    const exists = after.directories.includes(id);
    if (existed !== exists)
      items.push({
        id,
        kind: "directory",
        before: existed ? `${id}/` : "",
        after: exists ? `${id}/` : "",
        operation: exists ? "addition" : "deletion",
      });
  }
  return items;
}

function metadataText(
  metadata: ContextStoreRevisionDiff["before"]["files"][number]["metadata"] | undefined,
): string {
  return metadata === undefined ? "" : JSON.stringify(metadata, Object.keys(metadata).sort(), 2);
}
