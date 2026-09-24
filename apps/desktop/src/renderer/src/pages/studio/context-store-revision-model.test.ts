import { describe, expect, it } from "vitest";
import type {
  ContextStoreDraft,
  ContextStoreRevisionJob,
  ContextStoreRevisionRecord,
} from "../../../../shared/contracts/index.ts";
import {
  filterRevisionEntries,
  revisionEntries,
  revisionPage,
  snapshotDiffItems,
  unlinkedRevisionDrafts,
} from "./context-store-revision-model.ts";

const record: ContextStoreRevisionRecord = {
  schemaVersion: "pragma.context-store-revision-record/v1",
  storeId: "00000000-0000-4000-8000-000000000001",
  revision: 2,
  parentRevision: 1,
  snapshotHash: "1".repeat(64),
  author: "user",
  summary: "Saved",
  createdAt: "2026-09-15T10:00:00.000Z",
};
const job: ContextStoreRevisionJob = {
  schemaVersion: "pragma.context-store-revision-job/v3",
  id: "10000000-0000-4000-8000-000000000001",
  draftId: "20000000-0000-4000-8000-000000000001",
  revision: 1,
  request: {
    schemaVersion: "pragma.context-store-revision-request/v2",
    operation: "revise" as const,
    storeId: record.storeId,
    prompt: "Update",
    source: "user",
  },
  state: "pending_review",
  createdAt: "2026-09-15T08:00:00.000Z",
  updatedAt: "2026-09-15T11:00:00.000Z",
};

describe("revision activity", () => {
  it("interleaves manual saves and jobs by modification time and excludes initialization and agent commits", () => {
    const entries = revisionEntries(
      [job, { ...job, id: "older", updatedAt: "2026-09-15T09:00:00.000Z" }],
      [
        record,
        { ...record, revision: 1, parentRevision: null },
        { ...record, revision: 3, author: "store-revision-agent" },
      ],
    );
    expect(entries.map((entry) => entry.kind)).toEqual(["job", "manual", "job"]);
    const tied = [
      { ...job, id: "b" },
      { ...job, id: "a" },
    ];
    expect(revisionEntries(tied, []).map((entry) => entry.key)).toEqual(
      revisionEntries(tied.toReversed(), []).map((entry) => entry.key),
    );
  });

  it("combines source and actionable status with paused drafts taking precedence over errors", () => {
    const jobs = [
      "editing",
      "running",
      "pending_review",
      "merging",
      "merged",
      "rejected",
      "needs_rebase",
      "needs_attention",
    ].map((state, index) => ({
      ...job,
      id: String(index),
      state: state as ContextStoreRevisionJob["state"],
    }));
    jobs.push({
      ...job,
      id: "paused",
      state: "needs_attention",
      error: { code: "draft_not_submitted", message: "Paused" },
    } as ContextStoreRevisionJob);
    const entries = revisionEntries(jobs, [record]);
    expect(
      filterRevisionEntries(entries, "actionable", "")
        .map((entry) => entry.state)
        .sort(),
    ).toEqual(["awaiting_confirmation", "needs_attention", "needs_rebase", "pending_review"]);
    expect(filterRevisionEntries(entries, "actionable", "manual")).toHaveLength(0);
    expect(filterRevisionEntries(entries, "merged", "manual")).toHaveLength(1);
    expect(filterRevisionEntries(entries, "needs_attention", "user")).toHaveLength(1);
    expect(
      revisionEntries([{ ...job, state: "editing", missionId: "mission" }], [])[0]?.state,
    ).toBe("awaiting_confirmation");
  });

  it("never displays a previous knowledge base's jobs or manual saves under the new filter", () => {
    const otherStoreId = "00000000-0000-4000-8000-000000000002";
    const oldEntries = revisionEntries([job], [record]);
    expect(filterRevisionEntries(oldEntries, "", "", otherStoreId)).toEqual([]);
    const mixedEntries = revisionEntries(
      [job, { ...job, id: "other-job", request: { ...job.request, storeId: otherStoreId } }],
      [record, { ...record, storeId: otherStoreId }],
    );
    const selected = filterRevisionEntries(mixedEntries, "", "", otherStoreId);
    expect(selected).toHaveLength(2);
    expect(selected.map((entry) => entry.kind)).toEqual(["job", "manual"]);
    expect(
      filterRevisionEntries(mixedEntries, "pending_review", "user", otherStoreId),
    ).toHaveLength(1);
  });

  it("scopes unlinked drafts by Store while preserving the all-stores view", () => {
    const otherStoreId = "00000000-0000-4000-8000-000000000002";
    const draft = (id: string, storeId: string, state: ContextStoreDraft["state"]) =>
      ({
        schemaVersion: "pragma.context-store-draft/v2",
        operation: "revise",
        id,
        revision: 1,
        name: "Draft",
        storeId,
        baseRevision: 1,
        baseSnapshotHash: "0".repeat(64),
        state,
        overlay: { files: [], deletedFiles: [], directories: [], deletedDirectories: [] },
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      }) satisfies ContextStoreDraft;
    const linked = draft(job.draftId, record.storeId, "editing");
    const orphan = draft("20000000-0000-4000-8000-000000000002", record.storeId, "editing");
    const foreign = draft("20000000-0000-4000-8000-000000000003", otherStoreId, "editing");
    const merged = draft("20000000-0000-4000-8000-000000000004", record.storeId, "merged");

    const drafts = [linked, orphan, foreign, merged];
    expect(unlinkedRevisionDrafts(drafts, [job], record.storeId)).toEqual([orphan]);
    expect(unlinkedRevisionDrafts(drafts, [job], "")).toEqual([orphan, foreign]);
  });

  it("paginates filtered records and clamps empty or deleted last pages", () => {
    const entries = Array.from({ length: 41 }, (_, index) => index);
    expect(revisionPage(entries, 2, 20).items).toEqual(entries.slice(20, 40));
    expect(revisionPage(entries.slice(0, 40), 3, 20)).toMatchObject({
      currentPage: 2,
      pageCount: 2,
    });
    expect(revisionPage([], 5, 20)).toEqual({ currentPage: 1, pageCount: 1, items: [] });
  });

  it("shows content, metadata-only edits, empty files, directories and renames without inventing unchanged content", () => {
    const metadata = { trigger: "manual" as const, priority: "normal" as const };
    const snapshot = {
      schemaVersion: "pragma.context-store-snapshot/v1" as const,
      storeId: record.storeId,
      revision: 1,
      snapshotHash: record.snapshotHash,
      createdAt: record.createdAt,
      directories: ["old"],
      files: [
        { id: "a.md", content: "same", metadata },
        { id: "old.md", content: "renamed", metadata },
      ],
    };
    const items = snapshotDiffItems({
      before: snapshot,
      after: {
        ...snapshot,
        revision: 2,
        directories: ["new"],
        files: [
          { id: "a.md", content: "same", metadata: { ...metadata, priority: "high" } },
          { id: "new.md", content: "renamed", metadata },
          { id: "empty.md", content: "", metadata },
        ],
      },
    });
    expect(items).toContainEqual(
      expect.objectContaining({ id: "a.md", kind: "metadata", operation: "modification" }),
    );
    expect(items).not.toContainEqual(expect.objectContaining({ id: "a.md", kind: "file" }));
    expect(items).toContainEqual(
      expect.objectContaining({
        id: "old.md",
        kind: "file",
        operation: "deletion",
        before: "renamed",
      }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        id: "new.md",
        kind: "file",
        operation: "addition",
        after: "renamed",
      }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({ id: "empty.md", kind: "file", operation: "addition" }),
    );
    expect(items.filter((item) => item.kind === "directory")).toHaveLength(2);
    expect(snapshotDiffItems({ before: snapshot, after: snapshot })).toEqual([]);
  });
});
