import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/core";
import {
  assertProgressiveKnowledgeStructure,
  attachContextStoreBaseContent,
  KnowledgeDraftValidationError,
  transitionContextStoreRevisionJob,
  type ContextStoreRevisionEvent,
} from "@pragma/built-in-agents";
import {
  ContextStoreChangeSetSchema,
  ContextStoreDraftRebaseInspectionSchema,
  ContextStoreDraftSchema,
  ContextStoreRevisionJobSchema,
  ContextStoreRevisionProfileSchema,
  ContextStoreRevisionRequestSchema,
  RebaseContextStoreDraftSchema,
  UpdateContextStoreRevisionProfileSchema,
  type ContextStoreChangeSet,
  type ContextStoreDraft,
  type ContextStoreDraftOverlay,
  type ContextStoreDraftRebaseInspection,
  type ContextStoreRevisionJob,
  type ContextStoreRevisionProfile,
  type ContextStoreRevisionRequest,
  type GetContextStoreDraftFile,
  type ListContextStoreDrafts,
  type ListContextStoreRevisionJobs,
  type RebaseContextStoreDraft,
  type UpdateContextStoreDraftFile,
  type UpdateContextStoreRevisionProfile,
} from "@pragma/built-in-agents/contracts";

import type { ContextStoreContent, ContextStoreSnapshot } from "../../../shared/contracts/index.ts";
import { SparseContextStoreDraft, materializeDraftSnapshot } from "./context-store-draft-store.ts";
import { ContextStoreStoreError, type ContextStoreStore } from "./context-store-store.ts";
import {
  ContextStoreRevisionJobV1Schema,
  CONTEXT_STORE_REVISION_JOB_MIGRATIONS,
  overlayFromV1Job,
} from "./revision-migrations/index.ts";
import type { ContextStoreRevisionJobV1 } from "./revision-migrations/schemas/v1.ts";
import { prepareContextStoreRevisionV1 } from "./revision-migrations/prepare-v1.ts";

export interface ContextStoreRevisionExecutor {
  execute(input: {
    readonly jobId: string;
    readonly draftId: string;
    readonly request: ContextStoreRevisionRequest;
    readonly snapshot: ContextStoreSnapshot;
  }): Promise<void>;
}

export interface ContextStoreRevisionService {
  submit(request: ContextStoreRevisionRequest): Promise<ContextStoreRevisionJob>;
  start(
    request: ContextStoreRevisionRequest,
    options?: { readonly draftId?: string | undefined; readonly draftName?: string | undefined },
  ): Promise<ContextStoreRevisionJob>;
  list(filter?: ListContextStoreRevisionJobs): Promise<readonly ContextStoreRevisionJob[]>;
  get(jobId: string): Promise<ContextStoreRevisionJob>;
  approve(jobId: string, expectedRevision: number): Promise<ContextStoreRevisionJob>;
  reject(jobId: string, expectedRevision: number): Promise<ContextStoreRevisionJob>;
  retry(jobId: string, expectedRevision: number): Promise<ContextStoreRevisionJob>;
  delete(jobId: string, expectedRevision: number): Promise<void>;
  createDraft(input: {
    readonly storeId: string;
    readonly name: string;
  }): Promise<ContextStoreDraft>;
  listDrafts(filter?: ListContextStoreDrafts): Promise<readonly ContextStoreDraft[]>;
  getDraft(draftId: string): Promise<ContextStoreDraft>;
  getDraftChangeSet(draftId: string): Promise<ContextStoreChangeSet>;
  getDraftFile(input: GetContextStoreDraftFile): Promise<ContextStoreContent>;
  submitDraft(
    draftId: string,
    expectedRevision: number,
    summary: string,
  ): Promise<ContextStoreDraft>;
  updateDraftFile(input: UpdateContextStoreDraftFile): Promise<ContextStoreDraft>;
  discardDraft(draftId: string, expectedRevision: number): Promise<void>;
  inspectRebase(draftId: string): Promise<ContextStoreDraftRebaseInspection>;
  rebase(input: RebaseContextStoreDraft): Promise<ContextStoreDraft>;
  resolveDraft(draftId: string): Promise<{
    readonly revision: string;
    readonly name: string;
    readonly store: SparseContextStoreDraft;
  }>;
  attachMission(jobId: string, missionId: string): Promise<ContextStoreRevisionJob>;
  detachMission(jobId: string, missionId: string): Promise<ContextStoreRevisionJob>;
  processPending(): Promise<void>;
  scheduleProcessing(): void;
  hasActiveJobs(storeId: string): Promise<boolean>;
  migrateLegacyStoreReferences(
    storeId: string,
    readLegacySnapshot: (revision?: number) => Promise<ContextStoreSnapshot>,
  ): Promise<void>;
  getProfile(): Promise<ContextStoreRevisionProfile>;
  updateProfile(input: UpdateContextStoreRevisionProfile): Promise<ContextStoreRevisionProfile>;
}

export class ContextStoreRevisionServiceError extends Error {
  constructor(
    readonly code:
      | "job_not_found"
      | "draft_not_found"
      | "revision_conflict"
      | "invalid_state"
      | "profile_conflict"
      | "rebase_conflict"
      | "validation_failed",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ContextStoreRevisionServiceError";
  }
}

export function createContextStoreRevisionService(options: {
  readonly statePath: string;
  readonly draftsPath?: string | undefined;
  readonly draftsTrashPath?: string | undefined;
  readonly contextStores: ContextStoreStore;
  readonly executor: ContextStoreRevisionExecutor;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
  readonly onChanged?: ((storeId?: string) => void) | undefined;
  readonly onRevisionDetached?:
    | ((input: {
        readonly missionId: string;
        readonly jobId: string;
        readonly draftId: string;
        readonly storeId: string;
      }) => Promise<void>)
    | undefined;
}): ContextStoreRevisionService {
  const jobsPath = join(options.statePath, "jobs");
  const draftsPath = options.draftsPath ?? join(options.statePath, "drafts");
  const draftsTrashPath = options.draftsTrashPath ?? join(options.statePath, "trash", "drafts");
  const profilePath = join(options.statePath, "profile.json");
  const jobsLockPath = join(options.statePath, ".jobs.lock");
  const jobPath = (id: string) => join(jobsPath, `${id}.json`);
  const draftRoot = (id: string) => join(draftsPath, id);
  const draftPath = (id: string) => join(draftRoot(id), "draft.json");
  let processing: Promise<void> | undefined;
  const notifyChanged = (storeId?: string): void => {
    try {
      options.onChanged?.(storeId);
    } catch (error) {
      options.warn?.("A knowledge revision change notification could not be delivered.", error);
    }
  };
  const notifyRevisionDetached = async (input: {
    readonly missionId: string;
    readonly jobId: string;
    readonly draftId: string;
    readonly storeId: string;
  }): Promise<boolean> => {
    if (options.onRevisionDetached === undefined) return false;
    try {
      await options.onRevisionDetached(input);
      return true;
    } catch (error) {
      options.warn?.(
        "A completed knowledge revision could not restore its Mission Knowledge mount; startup recovery will retry.",
        error,
      );
      return false;
    }
  };

  const readDraft = async (id: string): Promise<ContextStoreDraft> => {
    try {
      return ContextStoreDraftSchema.parse(JSON.parse(await readFile(draftPath(id), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ContextStoreRevisionServiceError("draft_not_found", "Knowledge draft not found.");
      }
      throw error;
    }
  };

  const writeDraft = async (draft: ContextStoreDraft): Promise<void> => {
    await writeJsonAtomic(draftPath(draft.id), ContextStoreDraftSchema.parse(draft));
    notifyChanged(draft.storeId);
  };

  const trashDraft = async (draftId: string): Promise<void> => {
    await mkdir(draftsTrashPath, { recursive: true, mode: 0o700 });
    try {
      await rename(
        draftRoot(draftId),
        join(draftsTrashPath, `${draftId}-${new Date().toISOString().replaceAll(":", "-")}`),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };

  const mutateDraftRecord = async (
    id: string,
    expectedRevision: number,
    update: (draft: ContextStoreDraft) => Partial<ContextStoreDraft>,
  ): Promise<ContextStoreDraft> =>
    await withFileLock(`${draftRoot(id)}.lock`, async () => {
      const current = await readDraft(id);
      if (current.revision !== expectedRevision) throw revisionConflict();
      const next = ContextStoreDraftSchema.parse({
        ...current,
        ...update(current),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      await writeDraft(next);
      return next;
    });

  const mutateDraftOverlay = async (
    id: string,
    expectedRevision: number,
    update: (draft: ContextStoreDraft) => ContextStoreDraftOverlay,
  ): Promise<ContextStoreDraft> => {
    return await mutateDraftRecord(id, expectedRevision, (draft) => {
      if (draft.state !== "editing") {
        throw invalidState("Only an editable knowledge draft can be changed.");
      }
      return { overlay: update(draft) };
    });
  };

  const forceDraftState = async (
    draft: ContextStoreDraft,
    state: ContextStoreDraft["state"],
  ): Promise<ContextStoreDraft> =>
    await mutateDraftRecord(draft.id, draft.revision, () => ({
      state,
      mergeTargetSnapshotHash: state === "merging" ? draft.mergeTargetSnapshotHash : undefined,
      submittedRevision:
        state === "pending_review" || state === "merging" ? draft.revision + 1 : undefined,
    }));

  const createDraft = async (
    storeId: string,
    name: string,
    overlay: ContextStoreDraftOverlay = emptyOverlay(),
  ): Promise<ContextStoreDraft> => {
    const base = await options.contextStores.getSnapshot(storeId);
    const timestamp = new Date().toISOString();
    const draft = ContextStoreDraftSchema.parse({
      schemaVersion: "pragma.context-store-draft/v2",
      id: randomUUID(),
      revision: 1,
      name,
      storeId,
      baseSnapshotHash: base.snapshotHash,
      baseSnapshot: base,
      state: "editing",
      overlay,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await writeDraft(draft);
    return draft;
  };

  const ensureLegacyJobDraft = async (
    legacy: ContextStoreRevisionJobV1,
    draftId: string,
    base: ContextStoreSnapshot,
  ): Promise<ContextStoreDraft> => {
    try {
      return await readDraft(draftId);
    } catch (error) {
      if (
        !(error instanceof ContextStoreRevisionServiceError) ||
        error.code !== "draft_not_found"
      ) {
        throw error;
      }
    }
    const state: ContextStoreDraft["state"] =
      legacy.state === "pending_review" || legacy.state === "applying"
        ? "pending_review"
        : legacy.state === "needs_attention" || legacy.state === "superseded"
          ? "needs_attention"
          : "editing";
    const draft = ContextStoreDraftSchema.parse({
      schemaVersion: "pragma.context-store-draft/v2",
      id: draftId,
      revision: 1,
      name: `Migrated revision ${legacy.id.slice(0, 8)}`,
      storeId: legacy.request.storeId,
      baseSnapshotHash: base.snapshotHash,
      baseSnapshot: base,
      state,
      overlay: overlayFromV1Job(legacy, base),
      summary: legacy.changeSet?.summary,
      ...(["pending_review", "applying"].includes(legacy.state) ? { submittedRevision: 1 } : {}),
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
    });
    await writeDraft(draft);
    return draft;
  };

  const migrateJob = async (
    raw: unknown,
    retainedBase?: ContextStoreSnapshot,
  ): Promise<ContextStoreRevisionJob> => {
    const legacy = ContextStoreRevisionJobV1Schema.parse(raw);
    const migrationPath = join(options.statePath, "migrations", `${legacy.id}.v1-to-v2.json`);
    let migration: { schemaVersion: string; draftId: string } | undefined;
    try {
      migration = JSON.parse(await readFile(migrationPath, "utf8")) as {
        schemaVersion: string;
        draftId: string;
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    migration ??= {
      schemaVersion: "pragma.context-store-revision-v1-to-v2/v1",
      draftId: randomUUID(),
    };
    await writeJsonAtomic(migrationPath, migration);
    await writeJsonAtomic(
      join(options.statePath, "migration-backups", `${legacy.id}.v1.json`),
      legacy,
    );
    if (legacy.state === "completed" || legacy.state === "rejected") {
      const migrated = CONTEXT_STORE_REVISION_JOB_MIGRATIONS[0]!.migrate(legacy, migration.draftId);
      await writeJsonAtomic(jobPath(migrated.id), migrated);
      await rm(migrationPath, { force: true });
      return migrated;
    }
    const base = retainedBase ?? (await options.contextStores.getSnapshot(legacy.request.storeId));
    const draft = await ensureLegacyJobDraft(legacy, migration.draftId, base);
    const migrated = CONTEXT_STORE_REVISION_JOB_MIGRATIONS[0]!.migrate(legacy, draft.id);
    await writeJsonAtomic(jobPath(migrated.id), migrated);
    await rm(migrationPath, { force: true });
    return migrated;
  };

  const readJob = async (id: string): Promise<ContextStoreRevisionJob> => {
    try {
      const raw = JSON.parse(await readFile(jobPath(id), "utf8")) as unknown;
      const current = ContextStoreRevisionJobSchema.safeParse(raw);
      return current.success ? current.data : await migrateJob(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ContextStoreRevisionServiceError(
          "job_not_found",
          "Knowledge update task not found.",
        );
      }
      throw error;
    }
  };

  const writeJob = async (job: ContextStoreRevisionJob): Promise<void> => {
    await writeJsonAtomic(jobPath(job.id), ContextStoreRevisionJobSchema.parse(job));
    notifyChanged(job.request.storeId);
  };

  const transitionJob = async (
    id: string,
    expectedRevision: number,
    event: ContextStoreRevisionEvent,
  ): Promise<ContextStoreRevisionJob> =>
    await withFileLock(jobsLockPath, async () => {
      const current = await readJob(id);
      if (current.revision !== expectedRevision) throw revisionConflict();
      let next: ContextStoreRevisionJob;
      try {
        next = transitionContextStoreRevisionJob(current, event);
      } catch (error) {
        if (error instanceof Error && error.message === "revision_state_invalid") {
          throw invalidState(`Cannot ${event.type} while the update task is ${current.state}.`);
        }
        throw error;
      }
      await writeJob(next);
      return next;
    });

  const readAllJobs = async (): Promise<readonly ContextStoreRevisionJob[]> =>
    await Promise.all(
      (await readNames(jobsPath))
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => await readJob(name.slice(0, -5))),
    );

  const readAllDrafts = async (): Promise<readonly ContextStoreDraft[]> => {
    const drafts = await Promise.all(
      (await readNames(draftsPath)).map(async (name) => {
        try {
          return await readDraft(name);
        } catch (error) {
          if (
            error instanceof ContextStoreRevisionServiceError &&
            error.code === "draft_not_found"
          ) {
            return undefined;
          }
          throw error;
        }
      }),
    );
    return drafts.filter((draft): draft is ContextStoreDraft => draft !== undefined);
  };

  const api: ContextStoreRevisionService = {
    async submit(input) {
      return await api.start(input);
    },

    async start(input, startOptions = {}) {
      const request = ContextStoreRevisionRequestSchema.parse(input);
      return await withFileLock(jobsLockPath, async () => {
        if (request.sourceDigest !== undefined) {
          const existing = (await readAllJobs()).find(
            (job) =>
              job.request.storeId === request.storeId &&
              job.request.source === request.source &&
              job.request.sourceDigest === request.sourceDigest,
          );
          if (existing !== undefined) return existing;
        }
        const draft =
          startOptions.draftId === undefined
            ? await createDraft(
                request.storeId,
                startOptions.draftName ?? revisionDraftName(request),
              )
            : await readDraft(startOptions.draftId);
        if (draft.storeId !== request.storeId) {
          throw invalidState("The selected draft is not editable for this knowledge base.");
        }
        const active = (await readAllJobs()).find(
          (job) =>
            job.draftId === draft.id &&
            !["merged", "rejected", "needs_attention"].includes(job.state),
        );
        if (active !== undefined) return active;
        const timestamp = new Date().toISOString();
        const job = ContextStoreRevisionJobSchema.parse({
          schemaVersion: "pragma.context-store-revision-job/v2",
          id: randomUUID(),
          revision: 1,
          draftId: draft.id,
          request,
          state: "editing",
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await writeJob(job);
        return job;
      });
    },

    async list(filter = {}) {
      return (await readAllJobs())
        .filter(
          (job) =>
            (filter.storeId === undefined || job.request.storeId === filter.storeId) &&
            (filter.state === undefined || job.state === filter.state),
        )
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    async get(jobId) {
      return await readJob(jobId);
    },

    async approve(jobId, expectedRevision) {
      const current = await readJob(jobId);
      if (current.revision !== expectedRevision) throw revisionConflict();
      if (current.state !== "pending_review") {
        throw invalidState("Only a submitted draft can be approved.");
      }
      const draft = await readDraft(current.draftId);
      if (draft.state !== "pending_review" || draft.submittedRevision !== draft.revision) {
        throw invalidState("The submitted draft changed and must be submitted again.");
      }
      const live = await options.contextStores.getSnapshot(draft.storeId);
      if (live.snapshotHash !== draft.baseSnapshotHash) {
        await forceDraftState(draft, "needs_rebase");
        return await transitionJob(current.id, current.revision, { type: "rebase_required" });
      }
      const base = draft.baseSnapshot;
      const changeSet = changeSetFromDraft(draft, base);
      assertProgressiveKnowledgeStructure(base, changeSet);
      const target = materializeDraftSnapshot(draft, base);
      const merging = await transitionJob(current.id, current.revision, { type: "approved" });
      try {
        await mutateDraftRecord(draft.id, draft.revision, () => ({
          state: "merging",
          mergeTargetSnapshotHash: target.snapshotHash,
          submittedRevision: draft.revision + 1,
        }));
        await options.contextStores.applyChangeSet(changeSet);
      } catch (error) {
        if (error instanceof ContextStoreStoreError && error.code === "revision_conflict") {
          await forceDraftState(await readDraft(draft.id), "needs_rebase");
          return await transitionJob(merging.id, merging.revision, { type: "rebase_required" });
        }
        await transitionJob(merging.id, merging.revision, {
          type: "merge_failed",
          code: "merge_failed",
          message: errorMessage(error),
        });
        const failedDraft = await readDraft(draft.id);
        if (failedDraft.state !== "needs_rebase") {
          await forceDraftState(failedDraft, "needs_attention");
        }
        throw error;
      }
      const merged = await transitionJob(merging.id, merging.revision, {
        type: "merge_succeeded",
      });
      await trashDraft(draft.id);
      if (
        merged.missionId !== undefined &&
        (await notifyRevisionDetached({
          missionId: merged.missionId,
          jobId: merged.id,
          draftId: draft.id,
          storeId: draft.storeId,
        }))
      ) {
        return await transitionJob(merged.id, merged.revision, {
          type: "mission_detached",
          missionId: merged.missionId,
        });
      }
      return merged;
    },

    async reject(jobId, expectedRevision) {
      const rejected = await transitionJob(jobId, expectedRevision, { type: "rejected" });
      await trashDraft(rejected.draftId);
      if (
        rejected.missionId !== undefined &&
        (await notifyRevisionDetached({
          missionId: rejected.missionId,
          jobId: rejected.id,
          draftId: rejected.draftId,
          storeId: rejected.request.storeId,
        }))
      ) {
        return await transitionJob(rejected.id, rejected.revision, {
          type: "mission_detached",
          missionId: rejected.missionId,
        });
      }
      return rejected;
    },

    async retry(jobId, expectedRevision) {
      const current = await readJob(jobId);
      if (current.revision !== expectedRevision) throw revisionConflict();
      if (!["needs_attention", "rejected"].includes(current.state)) {
        throw invalidState("Only a stopped revision task can be retried.");
      }
      if (current.state === "rejected") {
        const draft = await createDraft(
          current.request.storeId,
          revisionDraftName(current.request),
        );
        try {
          return await transitionJob(jobId, expectedRevision, {
            type: "retried",
            draftId: draft.id,
          });
        } catch (error) {
          await trashDraft(draft.id).catch((cleanupError: unknown) => {
            options.warn?.("A failed update retry left a draft for later cleanup.", cleanupError);
          });
          throw error;
        }
      }
      const retryDraft = await readDraft(current.draftId);
      const transitioned = await transitionJob(jobId, expectedRevision, { type: "retried" });
      if (retryDraft.state !== "editing" || retryDraft.activeMissionId !== undefined) {
        await mutateDraftRecord(retryDraft.id, retryDraft.revision, () => ({
          activeMissionId: undefined,
          state: "editing",
        }));
      }
      return transitioned;
    },

    async delete(jobId, expectedRevision) {
      await withFileLock(jobsLockPath, async () => {
        const job = await readJob(jobId);
        if (job.revision !== expectedRevision) throw revisionConflict();
        await rm(jobPath(jobId));
        if (!(await readAllJobs()).some((candidate) => candidate.draftId === job.draftId)) {
          await trashDraft(job.draftId);
        }
        notifyChanged(job.request.storeId);
      });
    },

    async createDraft(input) {
      return await createDraft(input.storeId, input.name);
    },

    async listDrafts(filter = {}) {
      return (await readAllDrafts())
        .filter(
          (draft) =>
            (filter.storeId === undefined || draft.storeId === filter.storeId) &&
            (filter.state === undefined || draft.state === filter.state),
        )
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    async getDraft(draftId) {
      return await readDraft(draftId);
    },

    async getDraftChangeSet(draftId) {
      const draft = await readDraft(draftId);
      const base = draft.baseSnapshot;
      return attachContextStoreBaseContent(base, changeSetFromDraft(draft, base));
    },

    async getDraftFile(input) {
      const resolved = await api.resolveDraft(input.draftId);
      const result = await resolved.store.readContext({ id: input.id });
      if (!result.ok) {
        throw new ContextStoreRevisionServiceError("invalid_state", result.error.message);
      }
      return {
        id: result.value.id,
        content: result.value.content,
        metadata: result.value.metadata,
        ...(result.value.revision === undefined ? {} : { revision: result.value.revision }),
        ...(result.value.etag === undefined ? {} : { etag: result.value.etag }),
        truncated: false,
      };
    },

    async submitDraft(draftId, expectedRevision, summary) {
      return await withFileLock(`${draftRoot(draftId)}.lock`, async () => {
        const current = await readDraft(draftId);
        if (current.revision !== expectedRevision) throw revisionConflict();
        if (current.state !== "editing" && current.state !== "needs_rebase") {
          throw invalidState("Only an editable draft can be submitted.");
        }
        if (overlayIsEmpty(current.overlay))
          throw invalidState("An empty draft cannot be submitted.");
        const base = current.baseSnapshot;
        try {
          assertProgressiveKnowledgeStructure(
            base,
            changeSetFromDraft({ ...current, summary }, base),
          );
        } catch (error) {
          if (error instanceof KnowledgeDraftValidationError) {
            throw new ContextStoreRevisionServiceError("validation_failed", error.message, {
              diagnostics: error.diagnostics,
            });
          }
          throw error;
        }
        const revision = current.revision + 1;
        const next = ContextStoreDraftSchema.parse({
          ...current,
          revision,
          state: "pending_review",
          submittedRevision: revision,
          summary,
          updatedAt: new Date().toISOString(),
        });
        await writeDraft(next);
        const job = (await readAllJobs()).find((candidate) => candidate.draftId === draftId);
        if (job !== undefined && job.state !== "pending_review") {
          await transitionJob(job.id, job.revision, { type: "submitted" });
        }
        return next;
      });
    },

    async updateDraftFile(input) {
      const draft = await readDraft(input.draftId);
      if (draft.revision !== input.expectedRevision) throw revisionConflict();
      const resolved = await api.resolveDraft(draft.id);
      const result = await resolved.store.updateFile({
        id: input.id,
        content: input.content,
        metadata: {
          trigger: input.metadata.trigger,
          priority: input.metadata.priority,
          ...(input.metadata.description === undefined
            ? {}
            : { description: input.metadata.description }),
          ...(input.metadata.trustLevel === undefined
            ? {}
            : { trustLevel: input.metadata.trustLevel }),
          ...(input.metadata.sensitivity === undefined
            ? {}
            : { sensitivity: input.metadata.sensitivity }),
        },
        expectedRevision: input.expectedFileRevision,
      });
      if (!result.ok) {
        throw new ContextStoreRevisionServiceError(
          result.error.code === "context_conflict" ? "revision_conflict" : "invalid_state",
          result.error.message,
        );
      }
      return await readDraft(draft.id);
    },

    async discardDraft(draftId, expectedRevision) {
      await withFileLock(`${draftRoot(draftId)}.lock`, async () => {
        const draft = await readDraft(draftId);
        if (draft.revision !== expectedRevision) throw revisionConflict();
        const jobs = (await readAllJobs()).filter((candidate) => candidate.draftId === draftId);
        for (const candidate of jobs) {
          let job = candidate;
          if (job.state !== "merged" && job.state !== "rejected") {
            job = await transitionJob(job.id, job.revision, { type: "discarded" });
          }
          if (
            job.missionId !== undefined &&
            (await notifyRevisionDetached({
              missionId: job.missionId,
              jobId: job.id,
              draftId,
              storeId: draft.storeId,
            }))
          ) {
            await transitionJob(job.id, job.revision, {
              type: "mission_detached",
              missionId: job.missionId,
            });
          }
        }
        await trashDraft(draftId);
      });
    },

    async inspectRebase(draftId) {
      return await inspectRebase(await readDraft(draftId), options.contextStores);
    },

    async rebase(input) {
      const parsed = RebaseContextStoreDraftSchema.parse(input);
      const draft = await readDraft(parsed.draftId);
      if (draft.revision !== parsed.expectedRevision) throw revisionConflict();
      if (draft.state !== "editing" && draft.state !== "needs_rebase") {
        throw invalidState("Only an editable knowledge draft can be rebased.");
      }
      return await options.contextStores.withMutationLock(draft.storeId, async () => {
        const inspection = await inspectRebase(draft, options.contextStores);
        const resolutions = new Map(
          parsed.resolutions.map((resolution) => [resolution.id, resolution]),
        );
        const unresolved = inspection.conflicts.filter((conflict) => !resolutions.has(conflict.id));
        if (unresolved.length > 0) {
          throw new ContextStoreRevisionServiceError(
            "rebase_conflict",
            `Resolve ${unresolved.length} draft conflicts before rebasing.`,
          );
        }
        const current = await options.contextStores.getSnapshot(draft.storeId);
        if (current.snapshotHash !== inspection.currentSnapshotHash) {
          throw revisionConflict();
        }
        const originalBase = draft.baseSnapshot;
        const effective = materializeDraftSnapshot(draft, originalBase);
        const overlay = rebaseOverlay(effective, current, draft.overlay, resolutions);
        const rebased = await mutateDraftRecord(draft.id, parsed.expectedRevision, () => ({
          baseSnapshotHash: current.snapshotHash,
          baseSnapshot: current,
          state: "editing",
          submittedRevision: undefined,
          overlay,
        }));
        const job = (await readAllJobs()).find((candidate) => candidate.draftId === draft.id);
        if (job?.state === "needs_rebase") {
          await transitionJob(job.id, job.revision, { type: "rebase_completed" });
        }
        return rebased;
      });
    },

    async resolveDraft(draftId) {
      const draft = await readDraft(draftId);
      return {
        revision: String(draft.revision),
        name: draft.name,
        store: new SparseContextStoreDraft(draftId, {
          read: readDraft,
          readBase: async (current) => current.baseSnapshot,
          mutate: async (id, expectedRevision, update) =>
            await mutateDraftOverlay(id, expectedRevision, update),
        }),
      };
    },

    async attachMission(jobId, missionId) {
      const job = await readJob(jobId);
      if (job.missionId !== undefined && job.missionId !== missionId) {
        throw invalidState("The knowledge draft is already attached to another Mission.");
      }
      const draft = await readDraft(job.draftId);
      if (draft.activeMissionId !== undefined && draft.activeMissionId !== missionId) {
        throw invalidState("The knowledge draft is already owned by another Mission.");
      }
      if (job.state !== "editing" && job.state !== "running") {
        throw invalidState("Only editable knowledge revisions can be attached to a Mission.");
      }
      if (draft.state !== "editing") {
        throw invalidState("Only editable knowledge drafts can be attached to a Mission.");
      }
      const updated =
        job.missionId === missionId && job.state === "running"
          ? job
          : await transitionJob(job.id, job.revision, { type: "mission_attached", missionId });
      if (draft.activeMissionId !== missionId) {
        await mutateDraftRecord(draft.id, draft.revision, () => ({ activeMissionId: missionId }));
      }
      return updated;
    },

    async detachMission(jobId, missionId) {
      const job = await readJob(jobId);
      if (job.missionId !== missionId) return job;
      if (!["merged", "rejected"].includes(job.state)) {
        const draft = await readDraft(job.draftId);
        if (draft.activeMissionId === missionId) {
          await mutateDraftRecord(draft.id, draft.revision, (current) => ({
            activeMissionId: undefined,
            ...(current.state === "pending_review"
              ? { submittedRevision: current.revision + 1 }
              : {}),
          }));
        }
      }
      return await transitionJob(job.id, job.revision, { type: "mission_detached", missionId });
    },

    async processPending() {
      if (processing !== undefined) return await processing;
      const run = (async () => {
        for (const terminal of (await api.list()).filter((job) =>
          ["merged", "rejected"].includes(job.state),
        )) {
          await trashDraft(terminal.draftId);
        }
        const pausedDrafts = (await api.list()).filter(
          (job) =>
            job.state === "needs_attention" &&
            job.error?.code === "draft_not_submitted" &&
            job.missionId !== undefined,
        );
        for (const paused of pausedDrafts) {
          await transitionJob(paused.id, paused.revision, { type: "editing_started" });
        }
        const interruptedMerges = (await api.list()).filter((job) => job.state === "merging");
        for (const interrupted of interruptedMerges) {
          const draft = await readDraft(interrupted.draftId);
          const live = await options.contextStores.getSnapshot(draft.storeId);
          if (
            draft.mergeTargetSnapshotHash !== undefined &&
            (live.snapshotHash === draft.mergeTargetSnapshotHash ||
              draftChangesArePresent(draft, live))
          ) {
            const merged = await transitionJob(interrupted.id, interrupted.revision, {
              type: "merge_succeeded",
            });
            await trashDraft(draft.id);
            if (
              merged.missionId !== undefined &&
              (await notifyRevisionDetached({
                missionId: merged.missionId,
                jobId: merged.id,
                draftId: merged.draftId,
                storeId: merged.request.storeId,
              }))
            ) {
              await transitionJob(merged.id, merged.revision, {
                type: "mission_detached",
                missionId: merged.missionId,
              });
            }
            continue;
          }
          if (live.snapshotHash !== draft.baseSnapshotHash) {
            await forceDraftState(draft, "needs_rebase");
            await transitionJob(interrupted.id, interrupted.revision, {
              type: "rebase_required",
            });
            continue;
          }
          if (draft.state === "merging") await forceDraftState(draft, "pending_review");
          const replay = await transitionJob(interrupted.id, interrupted.revision, {
            type: "review_recovered",
          });
          await api.approve(replay.id, replay.revision);
        }
        const candidates = (await api.list()).filter(
          (job) => job.state === "editing" && job.missionId === undefined,
        );
        for (const candidate of candidates) {
          const running = await transitionJob(candidate.id, candidate.revision, {
            type: "execution_started",
          });
          try {
            const draft = await readDraft(running.draftId);
            const snapshot = draft.baseSnapshot;
            await options.executor.execute({
              jobId: running.id,
              draftId: draft.id,
              request: running.request,
              snapshot,
            });
            const completedByAgent = await api.get(running.id);
            if (completedByAgent.state !== "pending_review") {
              if (completedByAgent.state === "running") {
                await transitionJob(completedByAgent.id, completedByAgent.revision, {
                  type: "execution_paused",
                });
              }
            }
          } catch (error) {
            const failed = await api.get(running.id).catch(() => undefined);
            if (failed !== undefined && !["merged", "rejected"].includes(failed.state)) {
              if (failed.state === "running") {
                await transitionJob(failed.id, failed.revision, {
                  type: "execution_failed",
                  code: "generation_failed",
                  message: errorMessage(error),
                }).catch(() => undefined);
              }
            }
          }
        }
      })();
      processing = run;
      try {
        await run;
      } finally {
        if (processing === run) processing = undefined;
      }
    },

    scheduleProcessing() {
      void api.processPending().catch((error: unknown) => {
        options.warn?.("Context Store revision processing failed.", error);
      });
    },

    async hasActiveJobs(storeId) {
      return (await readAllDrafts()).some((draft) => draft.storeId === storeId);
    },

    async migrateLegacyStoreReferences(storeId, readLegacySnapshot) {
      await prepareContextStoreRevisionV1({
        storeId,
        statePath: options.statePath,
        draftsPath,
        readLegacySnapshot,
        writeDraft,
        trashDraft,
        migrateJob: async (raw, base) => {
          await migrateJob(raw, base);
        },
        backupDraft: async (draft, draftId) => {
          await writeJsonAtomic(
            join(options.statePath, "migration-backups", `draft-${draftId}.v1.json`),
            draft,
          );
        },
      });
    },

    async getProfile() {
      try {
        return ContextStoreRevisionProfileSchema.parse(
          JSON.parse(await readFile(profilePath, "utf8")),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return ContextStoreRevisionProfileSchema.parse({
          schemaVersion: "pragma.context-store-revision-profile/v1",
          revision: 0,
          mode: "inherit-default",
          updatedAt: new Date(0).toISOString(),
        });
      }
    },

    async updateProfile(input) {
      const parsed = UpdateContextStoreRevisionProfileSchema.parse(input);
      return await withFileLock(`${profilePath}.lock`, async () => {
        const current = await api.getProfile();
        if (current.revision !== parsed.expectedRevision) {
          throw new ContextStoreRevisionServiceError(
            "profile_conflict",
            "The revision Agent profile changed.",
          );
        }
        const next = ContextStoreRevisionProfileSchema.parse({
          schemaVersion: "pragma.context-store-revision-profile/v1",
          revision: current.revision + 1,
          mode: parsed.mode,
          ...(parsed.model === undefined ? {} : { model: parsed.model }),
          updatedAt: new Date().toISOString(),
        });
        await writeJsonAtomic(profilePath, next);
        notifyChanged();
        return next;
      });
    },
  };

  return api;
}

function emptyOverlay(): ContextStoreDraftOverlay {
  return { files: [], deletedFiles: [], directories: [], deletedDirectories: [] };
}

function overlayIsEmpty(overlay: ContextStoreDraftOverlay): boolean {
  return (
    overlay.files.length +
      overlay.deletedFiles.length +
      overlay.directories.length +
      overlay.deletedDirectories.length ===
    0
  );
}

function revisionDraftName(request: ContextStoreRevisionRequest): string {
  return (
    request.prompt.trim().split(/\s+/u).slice(0, 8).join(" ").slice(0, 120) || "Knowledge revision"
  );
}

function revisionConflict(): ContextStoreRevisionServiceError {
  return new ContextStoreRevisionServiceError(
    "revision_conflict",
    "The revision changed. Refresh and try again.",
  );
}

function invalidState(message: string): ContextStoreRevisionServiceError {
  return new ContextStoreRevisionServiceError("invalid_state", message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function changeSetFromDraft(
  draft: ContextStoreDraft,
  base: ContextStoreSnapshot,
): ContextStoreChangeSet {
  const explicitDeletes = new Set(draft.overlay.deletedFiles);
  for (const directory of draft.overlay.deletedDirectories) {
    const prefix = `${directory.replace(/\/+$/gu, "")}/`;
    for (const file of base.files) {
      if (file.id.startsWith(prefix)) explicitDeletes.add(file.id);
    }
  }
  for (const file of draft.overlay.files) explicitDeletes.delete(file.id);
  return ContextStoreChangeSetSchema.parse({
    schemaVersion: "pragma.context-store-change-set/v2",
    storeId: draft.storeId,
    baseSnapshotHash: draft.baseSnapshotHash,
    summary: draft.summary ?? `Merge knowledge draft ${draft.name}.`,
    operations: [
      ...draft.overlay.files.map((file) => ({ operation: "upsert" as const, ...file })),
      ...[...explicitDeletes].map((id) => ({ operation: "delete" as const, id })),
    ],
  });
}

async function inspectRebase(
  draft: ContextStoreDraft,
  stores: ContextStoreStore,
): Promise<ContextStoreDraftRebaseInspection> {
  const current = await stores.getSnapshot(draft.storeId);
  const base = draft.baseSnapshot;
  const baseById = new Map(base.files.map((file) => [file.id, file]));
  const currentById = new Map(current.files.map((file) => [file.id, file]));
  const draftById = new Map(
    materializeDraftSnapshot(draft, base).files.map((file) => [file.id, file]),
  );
  const changedIds = new Set([
    ...draft.overlay.files.map((file) => file.id),
    ...draft.overlay.deletedFiles,
  ]);
  const fileConflicts = [...changedIds].flatMap((id) => {
    const baseFile = baseById.get(id);
    const currentFile = currentById.get(id);
    const draftFile = draftById.get(id);
    if (JSON.stringify(baseFile) === JSON.stringify(currentFile)) return [];
    if (JSON.stringify(draftFile) === JSON.stringify(currentFile)) return [];
    return [
      {
        id,
        kind:
          baseFile === undefined
            ? ("added_collision" as const)
            : draftFile === undefined
              ? ("draft_deleted" as const)
              : currentFile === undefined
                ? ("current_deleted" as const)
                : ("modified" as const),
        ...(baseFile === undefined ? {} : { baseContent: baseFile.content }),
        ...(currentFile === undefined ? {} : { currentContent: currentFile.content }),
        ...(draftFile === undefined ? {} : { draftContent: draftFile.content }),
      },
    ];
  });
  const baseDirectories = new Set(base.directories);
  const currentDirectories = new Set(current.directories);
  const addedDirectories = new Set(draft.overlay.directories);
  const directoryConflicts = [
    ...new Set([...draft.overlay.directories, ...draft.overlay.deletedDirectories]),
  ].flatMap((id) => {
    if (draft.overlay.deletedDirectories.includes(id)) {
      const prefix = `${id.replace(/\/+$/gu, "")}/`;
      const affectedFiles = new Set(
        [...base.files, ...current.files]
          .filter((file) => file.id.startsWith(prefix))
          .map((file) => file.id),
      );
      if (
        [...affectedFiles].some(
          (fileId) =>
            JSON.stringify(baseById.get(fileId)) !== JSON.stringify(currentById.get(fileId)),
        )
      ) {
        return [{ id, kind: "directory_ancestor" as const }];
      }
    }
    const baseExists = baseDirectories.has(id);
    const currentExists = currentDirectories.has(id);
    const draftExists = addedDirectories.has(id);
    if (baseExists === currentExists || draftExists === currentExists) return [];
    return [{ id, kind: "directory_ancestor" as const }];
  });
  return ContextStoreDraftRebaseInspectionSchema.parse({
    draftId: draft.id,
    draftRevision: draft.revision,
    currentSnapshotHash: current.snapshotHash,
    conflicts: [...fileConflicts, ...directoryConflicts],
  });
}

function rebaseOverlay(
  effective: ContextStoreSnapshot,
  current: ContextStoreSnapshot,
  previous: ContextStoreDraftOverlay,
  resolutions: ReadonlyMap<string, RebaseContextStoreDraft["resolutions"][number]>,
): ContextStoreDraftOverlay {
  const effectiveById = new Map(effective.files.map((file) => [file.id, file]));
  const currentById = new Map(current.files.map((file) => [file.id, file]));
  const changedIds = new Set([...previous.files.map((file) => file.id), ...previous.deletedFiles]);
  const files: ContextStoreDraftOverlay["files"] = [];
  const deletedFiles: string[] = [];
  for (const id of changedIds) {
    const resolution = resolutions.get(id);
    const selected =
      resolution?.resolution === "keep_current"
        ? currentById.get(id)
        : resolution?.resolution === "replace"
          ? { id, content: resolution.content, metadata: resolution.metadata }
          : effectiveById.get(id);
    const base = currentById.get(id);
    if (selected === undefined) {
      if (base !== undefined) deletedFiles.push(id);
      continue;
    }
    if (JSON.stringify(selected) !== JSON.stringify(base)) files.push(selected);
  }
  const effectiveDirectories = new Set(effective.directories);
  const currentDirectories = new Set(current.directories);
  const directories: string[] = [];
  const deletedDirectories: string[] = [];
  for (const id of new Set([...previous.directories, ...previous.deletedDirectories])) {
    const resolution = resolutions.get(id);
    const selected =
      resolution?.resolution === "keep_current"
        ? currentDirectories.has(id)
        : effectiveDirectories.has(id);
    const base = currentDirectories.has(id);
    if (selected !== base) (selected ? directories : deletedDirectories).push(id);
  }
  return {
    files,
    deletedFiles,
    directories,
    deletedDirectories,
  };
}

function draftChangesArePresent(draft: ContextStoreDraft, current: ContextStoreSnapshot): boolean {
  const currentFiles = new Map(current.files.map((file) => [file.id, file]));
  for (const file of draft.overlay.files) {
    if (JSON.stringify(currentFiles.get(file.id)) !== JSON.stringify(file)) return false;
  }
  for (const id of draft.overlay.deletedFiles) {
    if (currentFiles.has(id)) return false;
  }

  const currentDirectories = new Set(current.directories);
  for (const id of draft.overlay.directories) {
    if (!currentDirectories.has(id)) return false;
  }
  for (const id of draft.overlay.deletedDirectories) {
    const prefix = `${id.replace(/\/+$/gu, "")}/`;
    if (
      currentDirectories.has(id) ||
      [...currentDirectories].some((directory) => directory.startsWith(prefix)) ||
      current.files.some((file) => file.id.startsWith(prefix))
    ) {
      return false;
    }
  }
  return true;
}

async function readNames(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
