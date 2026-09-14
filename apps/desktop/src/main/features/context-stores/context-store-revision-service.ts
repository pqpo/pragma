import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/core";
import {
  assertProgressiveKnowledgeStructure,
  attachContextStoreBaseContent,
  KnowledgeDraftValidationError,
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
import { z } from "zod";

import type { ContextStoreContent, ContextStoreSnapshot } from "../../../shared/contracts/index.ts";
import { SparseContextStoreDraft, materializeDraftSnapshot } from "./context-store-draft-store.ts";
import { ContextStoreStoreError, type ContextStoreStore } from "./context-store-store.ts";
import {
  ContextStoreRevisionJobV1Schema,
  CONTEXT_STORE_REVISION_JOB_MIGRATIONS,
  overlayFromV1Job,
} from "./revision-migrations/index.ts";

export interface ContextStoreRevisionGenerator {
  generate(input: {
    readonly jobId: string;
    readonly draftId: string;
    readonly request: ContextStoreRevisionRequest;
    readonly snapshot: ContextStoreSnapshot;
  }): Promise<ContextStoreChangeSet | undefined>;
}

export interface ContextStoreRevisionDraftRecoveryIssue {
  readonly code: "mission_orphaned" | "mission_unreadable";
  readonly message: string;
}

export interface ContextStoreRevisionDraftListEntry {
  readonly draft: ContextStoreDraft;
  readonly recovery?: ContextStoreRevisionDraftRecoveryIssue | undefined;
}

export interface ContextStoreRevisionService {
  submit(request: ContextStoreRevisionRequest): Promise<ContextStoreRevisionJob>;
  start(
    request: ContextStoreRevisionRequest,
    options?: { readonly draftId?: string | undefined; readonly draftName?: string | undefined },
  ): Promise<ContextStoreRevisionJob>;
  startForMission(input: {
    readonly request: ContextStoreRevisionRequest;
    readonly missionId: string;
    readonly draftId?: string | undefined;
    readonly draftName?: string | undefined;
  }): Promise<ContextStoreRevisionJob>;
  getMissionActiveJob(input: {
    readonly missionId: string;
    readonly storeId: string;
  }): Promise<ContextStoreRevisionJob | undefined>;
  completeMissionClaimMount(input: {
    readonly missionId: string;
    readonly storeId: string;
    readonly jobId: string;
    readonly draftId: string;
  }): Promise<void>;
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
  listDraftsWithRecovery(
    filter?: ListContextStoreDrafts,
  ): Promise<readonly ContextStoreRevisionDraftListEntry[]>;
  getDraft(draftId: string): Promise<ContextStoreDraft>;
  getDraftWithRecovery(draftId: string): Promise<ContextStoreRevisionDraftListEntry>;
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
  releaseMissionClaim(input: {
    readonly draftId: string;
    readonly missionId: string;
    readonly jobId?: string | undefined;
    readonly reason: "mission_deleted" | "mission_orphaned";
  }): Promise<void>;
  recoverMissionClaimReleases(): Promise<void>;
  processPending(): Promise<void>;
  scheduleProcessing(): void;
  hasActiveJobs(storeId: string): Promise<boolean>;
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

const MissionClaimReleaseJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-revision-claim-release/v1"),
    draftId: z.string().uuid(),
    missionId: z.string().uuid(),
    jobId: z.string().uuid().optional(),
    reason: z.enum(["mission_deleted", "mission_orphaned"]),
  })
  .strict();

type MissionClaimReleaseJournal = z.infer<typeof MissionClaimReleaseJournalSchema>;

const MissionClaimJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-revision-mission-claim/v1"),
    missionId: z.string().uuid(),
    storeId: z.string().uuid(),
    jobId: z.string().uuid(),
    draftId: z.string().uuid(),
    request: ContextStoreRevisionRequestSchema,
    draftName: z.string().min(1).max(200).optional(),
  })
  .strict();

type MissionClaimJournal = z.infer<typeof MissionClaimJournalSchema>;

export function createContextStoreRevisionService(options: {
  readonly statePath: string;
  readonly draftsPath?: string | undefined;
  readonly draftsTrashPath?: string | undefined;
  readonly contextStores: ContextStoreStore;
  readonly generator: ContextStoreRevisionGenerator;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
  readonly isMissionAvailable?: ((missionId: string) => Promise<boolean>) | undefined;
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
  const claimReleaseJournalsPath = join(options.statePath, "claim-releases");
  const missionClaimsPath = join(options.statePath, "mission-claims");
  const profilePath = join(options.statePath, "profile.json");
  const jobsLockPath = join(options.statePath, ".jobs.lock");
  const jobPath = (id: string) => join(jobsPath, `${id}.json`);
  const draftRoot = (id: string) => join(draftsPath, id);
  const draftPath = (id: string) => join(draftRoot(id), "draft.json");
  const claimReleaseJournalPath = (journal: MissionClaimReleaseJournal) =>
    join(
      claimReleaseJournalsPath,
      `${journal.draftId}-${journal.jobId ?? "draft"}-${journal.missionId}.json`,
    );
  const missionClaimPath = (missionId: string, storeId: string) =>
    join(missionClaimsPath, `${missionId}-${storeId}.json`);
  const missionClaimLockPath = (missionId: string, storeId: string) =>
    join(missionClaimsPath, `${missionId}-${storeId}.lock`);
  let processing: Promise<void> | undefined;
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
  };

  const mutateDraftRecord = async (
    id: string,
    expectedRevision: number,
    update: (draft: ContextStoreDraft) => Partial<ContextStoreDraft>,
  ): Promise<ContextStoreDraft> =>
    await withFileLock(`${draftRoot(id)}.lock`, async () => {
      const current = await readDraft(id);
      if (current.revision !== expectedRevision) throw revisionConflict();
      if (current.state === "merged") throw invalidState("Merged drafts are read-only.");
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
      ...(state === "merged" ? { activeMissionId: undefined } : {}),
      submittedRevision:
        state === "pending_review" || state === "merging" ? draft.revision + 1 : undefined,
    }));

  const createDraft = async (
    storeId: string,
    name: string,
    overlay: ContextStoreDraftOverlay = emptyOverlay(),
    id = randomUUID(),
  ): Promise<ContextStoreDraft> => {
    const base = await options.contextStores.getSnapshot(storeId);
    const timestamp = new Date().toISOString();
    const draft = ContextStoreDraftSchema.parse({
      schemaVersion: "pragma.context-store-draft/v1",
      id,
      revision: 1,
      name,
      storeId,
      baseRevision: base.revision,
      baseSnapshotHash: base.snapshotHash,
      state: "editing",
      overlay,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await writeDraft(draft);
    return draft;
  };

  const migrateJob = async (raw: unknown): Promise<ContextStoreRevisionJob> => {
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
    let draft: ContextStoreDraft;
    try {
      draft = await readDraft(migration.draftId);
    } catch (error) {
      if (
        !(error instanceof ContextStoreRevisionServiceError) ||
        error.code !== "draft_not_found"
      ) {
        throw error;
      }
      const base = await options.contextStores.getSnapshot(
        legacy.request.storeId,
        legacy.changeSet?.baseRevision,
      );
      draft = ContextStoreDraftSchema.parse({
        schemaVersion: "pragma.context-store-draft/v1",
        id: migration.draftId,
        revision: 1,
        name: `Migrated revision ${legacy.id.slice(0, 8)}`,
        storeId: legacy.request.storeId,
        baseRevision: base.revision,
        baseSnapshotHash: base.snapshotHash,
        state:
          legacy.state === "pending_review"
            ? "pending_review"
            : legacy.state === "applying"
              ? "merging"
              : legacy.state === "completed"
                ? "merged"
                : "editing",
        overlay: overlayFromV1Job(legacy, base),
        ...(["pending_review", "applying"].includes(legacy.state) ? { submittedRevision: 1 } : {}),
        createdAt: legacy.createdAt,
        updatedAt: legacy.updatedAt,
      });
      await writeJsonAtomic(
        join(options.statePath, "migration-backups", `${legacy.id}.v1.json`),
        legacy,
      );
      await writeDraft(draft);
    }
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
        throw new ContextStoreRevisionServiceError("job_not_found", "Revision task not found.");
      }
      throw error;
    }
  };

  const writeJob = async (job: ContextStoreRevisionJob): Promise<void> => {
    await writeJsonAtomic(jobPath(job.id), ContextStoreRevisionJobSchema.parse(job));
  };

  const mutateJob = async (
    id: string,
    expectedRevision: number,
    update: (job: ContextStoreRevisionJob) => Partial<ContextStoreRevisionJob>,
  ): Promise<ContextStoreRevisionJob> =>
    await withFileLock(jobsLockPath, async () => {
      const current = await readJob(id);
      if (current.revision !== expectedRevision) throw revisionConflict();
      const next = ContextStoreRevisionJobSchema.parse({
        ...current,
        ...update(current),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      await writeJob(next);
      return next;
    });

  const readAllJobs = async (): Promise<readonly ContextStoreRevisionJob[]> => {
    const jobs = await Promise.all(
      (await readNames(jobsPath))
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          try {
            return await readJob(name.slice(0, -5));
          } catch (error) {
            options.warn?.("A knowledge revision job could not be read and was skipped.", error);
            return undefined;
          }
        }),
    );
    return jobs.filter((job): job is ContextStoreRevisionJob => job !== undefined);
  };

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
          options.warn?.("A knowledge revision draft could not be read and was skipped.", error);
          return undefined;
        }
      }),
    );
    return drafts.filter((draft): draft is ContextStoreDraft => draft !== undefined);
  };

  const readMissionClaim = async (
    missionId: string,
    storeId: string,
  ): Promise<MissionClaimJournal | undefined> => {
    try {
      return MissionClaimJournalSchema.parse(
        JSON.parse(await readFile(missionClaimPath(missionId, storeId), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };

  const isActiveMissionJob = (job: ContextStoreRevisionJob): boolean =>
    !["merged", "rejected", "needs_attention"].includes(job.state);

  const findMissionActiveJob = async (
    missionId: string,
    storeId: string,
  ): Promise<ContextStoreRevisionJob | undefined> => {
    const matches = (await readAllJobs()).filter(
      (job) =>
        job.missionId === missionId &&
        job.request.storeId === storeId &&
        isActiveMissionJob(job),
    );
    if (matches.length > 1) {
      throw invalidState("More than one active knowledge revision claims this Mission target.");
    }
    return matches[0];
  };

  const clearMissionClaimIfMatches = async (input: {
    readonly missionId: string;
    readonly draftId: string;
    readonly jobId?: string | undefined;
  }): Promise<void> => {
    for (const name of (await readNames(missionClaimsPath)).filter((candidate) =>
      candidate.endsWith(".json"),
    )) {
      const path = join(missionClaimsPath, name);
      try {
        const claim = MissionClaimJournalSchema.parse(JSON.parse(await readFile(path, "utf8")));
        if (
          claim.missionId === input.missionId &&
          claim.draftId === input.draftId &&
          (input.jobId === undefined || claim.jobId === input.jobId)
        ) {
          await rm(path, { force: true });
        }
      } catch (error) {
        options.warn?.("A knowledge revision Mission claim journal could not be read.", error);
      }
    }
  };

  const materializeMissionClaim = async (
    claim: MissionClaimJournal,
  ): Promise<ContextStoreRevisionJob> => {
    let draft: ContextStoreDraft;
    try {
      draft = await readDraft(claim.draftId);
    } catch (error) {
      if (!(error instanceof ContextStoreRevisionServiceError) || error.code !== "draft_not_found") {
        throw error;
      }
      draft = await createDraft(
        claim.storeId,
        claim.draftName ?? revisionDraftName(claim.request),
        emptyOverlay(),
        claim.draftId,
      );
    }
    if (draft.storeId !== claim.storeId || draft.state === "merged") {
      throw invalidState("The claimed knowledge draft is not editable for this knowledge base.");
    }

    let job: ContextStoreRevisionJob;
    try {
      job = await readJob(claim.jobId);
    } catch (error) {
      if (!(error instanceof ContextStoreRevisionServiceError) || error.code !== "job_not_found") {
        throw error;
      }
      const timestamp = new Date().toISOString();
      job = ContextStoreRevisionJobSchema.parse({
        schemaVersion: "pragma.context-store-revision-job/v2",
        id: claim.jobId,
        revision: 1,
        draftId: claim.draftId,
        request: claim.request,
        missionId: claim.missionId,
        state: "running",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await writeJob(job);
    }
    if (
      job.draftId !== claim.draftId ||
      job.request.storeId !== claim.storeId ||
      (job.missionId !== undefined && job.missionId !== claim.missionId)
    ) {
      throw invalidState("The durable Mission claim does not match its revision task.");
    }
    if (!isActiveMissionJob(job)) return job;
    return await api.attachMission(job.id, claim.missionId);
  };

  const recoverOrphanedClaim = async (input: {
    readonly draftId: string;
    readonly missionId?: string | undefined;
  }): Promise<ContextStoreRevisionDraftRecoveryIssue | undefined> => {
    if (input.missionId === undefined || options.isMissionAvailable === undefined) return undefined;
    let available: boolean;
    try {
      available = await options.isMissionAvailable(input.missionId);
    } catch (error) {
      options.warn?.("A linked Mission could not be read while listing a knowledge draft.", error);
      return {
        code: "mission_unreadable",
        message: "The linked Mission could not be read. The draft was left unchanged.",
      };
    }
    if (available) return undefined;
    await releaseMissionClaim({
      draftId: input.draftId,
      missionId: input.missionId,
      reason: "mission_orphaned",
    });
    return {
      code: "mission_orphaned",
      message: "The linked Mission no longer exists. The draft was preserved and released.",
    };
  };

  const releaseMissionClaim = async (
    input: Omit<MissionClaimReleaseJournal, "schemaVersion">,
    persistJournal = true,
  ): Promise<void> => {
    const journal = MissionClaimReleaseJournalSchema.parse({
      schemaVersion: "pragma.context-store-revision-claim-release/v1",
      ...input,
    });
    const journalPath = claimReleaseJournalPath(journal);
    if (persistJournal) await writeJsonAtomic(journalPath, journal);
    let draft: ContextStoreDraft | undefined;
    try {
      draft = await readDraft(journal.draftId);
    } catch (error) {
      if (
        !(error instanceof ContextStoreRevisionServiceError) ||
        error.code !== "draft_not_found"
      ) {
        throw error;
      }
    }
    if (
      draft !== undefined &&
      draft.activeMissionId === journal.missionId &&
      draft.state !== "merged"
    ) {
      await mutateDraftRecord(draft.id, draft.revision, () => ({ activeMissionId: undefined }));
    }

    const jobs =
      journal.jobId === undefined
        ? (await readAllJobs()).filter(
            (candidate) =>
              candidate.draftId === journal.draftId && candidate.missionId === journal.missionId,
          )
        : [await readJob(journal.jobId)].filter(
            (candidate) =>
              candidate.draftId === journal.draftId && candidate.missionId === journal.missionId,
          );
    for (const job of jobs) {
      await mutateJob(job.id, job.revision, (current) => ({
        missionId: undefined,
        ...(["merged", "rejected"].includes(current.state)
          ? {}
          : {
              state: "needs_attention" as const,
              error: {
                code: journal.reason,
                message:
                  journal.reason === "mission_deleted"
                    ? "The revision Mission was deleted. The draft was preserved."
                    : "The revision Mission no longer exists. The draft was preserved.",
              },
            }),
      }));
    }
    await clearMissionClaimIfMatches(journal);
    await rm(journalPath, { force: true });
  };

  const recoverMissionClaimReleases = async (): Promise<void> => {
    for (const name of (await readNames(claimReleaseJournalsPath)).filter((candidate) =>
      candidate.endsWith(".json"),
    )) {
      const path = join(claimReleaseJournalsPath, name);
      const journal = MissionClaimReleaseJournalSchema.parse(
        JSON.parse(await readFile(path, "utf8")),
      );
      await releaseMissionClaim(journal, false);
    }
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
        if (draft.storeId !== request.storeId || draft.state === "merged") {
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

    async startForMission(input) {
      const request = ContextStoreRevisionRequestSchema.parse(input.request);
      return await withFileLock(missionClaimLockPath(input.missionId, request.storeId), async () => {
        const existingClaim = await readMissionClaim(input.missionId, request.storeId);
        if (existingClaim !== undefined) {
          const job = await materializeMissionClaim(existingClaim);
          if (isActiveMissionJob(job)) return job;
          await rm(missionClaimPath(input.missionId, request.storeId), { force: true });
        }

        const existingForMission = await findMissionActiveJob(input.missionId, request.storeId);
        if (existingForMission !== undefined) return existingForMission;

        const existingForRequest =
          request.sourceDigest === undefined
            ? undefined
            : (await readAllJobs()).find(
                (job) =>
                  job.request.storeId === request.storeId &&
                  job.request.source === request.source &&
                  job.request.sourceDigest === request.sourceDigest &&
                  isActiveMissionJob(job),
              );
        const existingForDraft =
          input.draftId === undefined
            ? undefined
            : (await readAllJobs()).find(
                (job) => job.draftId === input.draftId && isActiveMissionJob(job),
              );
        const existing = existingForRequest ?? existingForDraft;
        if (existing !== undefined && existing.missionId !== undefined) return existing;

        const claim = MissionClaimJournalSchema.parse({
          schemaVersion: "pragma.context-store-revision-mission-claim/v1",
          missionId: input.missionId,
          storeId: request.storeId,
          jobId: existing?.id ?? randomUUID(),
          draftId: existing?.draftId ?? input.draftId ?? randomUUID(),
          request,
          ...(input.draftName === undefined ? {} : { draftName: input.draftName }),
        });
        await writeJsonAtomic(missionClaimPath(input.missionId, request.storeId), claim);
        return await materializeMissionClaim(claim);
      });
    },

    async getMissionActiveJob(input) {
      return await withFileLock(missionClaimLockPath(input.missionId, input.storeId), async () => {
        const claim = await readMissionClaim(input.missionId, input.storeId);
        if (claim !== undefined) {
          const job = await materializeMissionClaim(claim);
          return isActiveMissionJob(job) ? job : undefined;
        }
        return await findMissionActiveJob(input.missionId, input.storeId);
      });
    },

    async completeMissionClaimMount(input) {
      await withFileLock(missionClaimLockPath(input.missionId, input.storeId), async () => {
        const claim = await readMissionClaim(input.missionId, input.storeId);
        if (claim === undefined) return;
        if (claim.jobId !== input.jobId || claim.draftId !== input.draftId) {
          throw invalidState("The mounted draft does not match the durable Mission claim.");
        }
        await rm(missionClaimPath(input.missionId, input.storeId), { force: true });
      });
    },

    async list(filter = {}) {
      const jobs = (await readAllJobs()).filter(
        (job) =>
          (filter.storeId === undefined || job.request.storeId === filter.storeId) &&
          (filter.state === undefined || job.state === filter.state),
      );
      const reconciled: ContextStoreRevisionJob[] = [];
      for (const job of jobs) {
        try {
          await recoverOrphanedClaim(job);
          reconciled.push(job.missionId === undefined ? job : await readJob(job.id));
        } catch (error) {
          options.warn?.("A knowledge revision Mission claim could not be reconciled.", error);
          reconciled.push(job);
        }
      }
      return reconciled.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    async get(jobId) {
      const job = await readJob(jobId);
      await recoverOrphanedClaim(job);
      return job.missionId === undefined ? job : await readJob(job.id);
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
      if (live.revision !== draft.baseRevision || live.snapshotHash !== draft.baseSnapshotHash) {
        await forceDraftState(draft, "needs_rebase");
        return await mutateJob(current.id, current.revision, () => ({ state: "needs_rebase" }));
      }
      const merging = await mutateJob(current.id, current.revision, () => ({ state: "merging" }));
      try {
        await forceDraftState(draft, "merging");
        const base = await options.contextStores.getSnapshot(draft.storeId, draft.baseRevision);
        const changeSet = changeSetFromDraft(draft, base);
        assertProgressiveKnowledgeStructure(base, changeSet);
        await options.contextStores.applyChangeSet(changeSet, "store-revision-agent", merging.id);
        await forceDraftState(await readDraft(draft.id), "merged");
        const merged = await mutateJob(merging.id, merging.revision, () => ({
          state: "merged",
          error: undefined,
        }));
        if (
          merged.missionId !== undefined &&
          (await notifyRevisionDetached({
            missionId: merged.missionId,
            jobId: merged.id,
            draftId: draft.id,
            storeId: draft.storeId,
          }))
        ) {
          return await mutateJob(merged.id, merged.revision, () => ({ missionId: undefined }));
        }
        return merged;
      } catch (error) {
        if (error instanceof ContextStoreStoreError && error.code === "revision_conflict") {
          await forceDraftState(await readDraft(draft.id), "needs_rebase");
          return await mutateJob(merging.id, merging.revision, () => ({
            state: "needs_rebase",
          }));
        }
        await mutateJob(merging.id, merging.revision, () => ({
          state: "needs_attention",
          error: { code: "merge_failed", message: errorMessage(error) },
        }));
        const failedDraft = await readDraft(draft.id);
        if (failedDraft.state !== "needs_rebase") {
          await forceDraftState(failedDraft, "needs_attention");
        }
        throw error;
      }
    },

    async reject(jobId, expectedRevision) {
      const rejected = await mutateJob(jobId, expectedRevision, (job) => {
        if (job.state !== "pending_review") {
          throw invalidState("Only a submitted draft can be rejected.");
        }
        return { state: "rejected" };
      });
      const rejectedDraft = await readDraft(rejected.draftId);
      await mutateDraftRecord(rejectedDraft.id, rejectedDraft.revision, () => ({
        state: "editing",
        activeMissionId: undefined,
        submittedRevision: undefined,
      }));
      if (
        rejected.missionId !== undefined &&
        (await notifyRevisionDetached({
          missionId: rejected.missionId,
          jobId: rejected.id,
          draftId: rejected.draftId,
          storeId: rejected.request.storeId,
        }))
      ) {
        return await mutateJob(rejected.id, rejected.revision, () => ({ missionId: undefined }));
      }
      return rejected;
    },

    async retry(jobId, expectedRevision) {
      const retried = await mutateJob(jobId, expectedRevision, (job) => {
        if (!["needs_attention", "rejected"].includes(job.state)) {
          throw invalidState("Only a stopped revision task can be retried.");
        }
        return { state: "editing", error: undefined, missionId: undefined };
      });
      const draft = await readDraft(retried.draftId);
      await mutateDraftRecord(draft.id, draft.revision, () => ({
        activeMissionId: undefined,
        state: "editing",
      }));
      return retried;
    },

    async delete(jobId, expectedRevision) {
      await withFileLock(jobsLockPath, async () => {
        const job = await readJob(jobId);
        if (job.revision !== expectedRevision) throw revisionConflict();
        await rm(jobPath(jobId));
      });
    },

    async createDraft(input) {
      return await createDraft(input.storeId, input.name);
    },

    async listDraftsWithRecovery(filter = {}) {
      const drafts = (await readAllDrafts()).filter(
        (draft) =>
          (filter.storeId === undefined || draft.storeId === filter.storeId) &&
          (filter.state === undefined || draft.state === filter.state),
      );
      const reconciled: ContextStoreRevisionDraftListEntry[] = [];
      for (const draft of drafts) {
        try {
          const recovery = await recoverOrphanedClaim({
            draftId: draft.id,
            missionId: draft.activeMissionId,
          });
          reconciled.push({
            draft: draft.activeMissionId === undefined ? draft : await readDraft(draft.id),
            ...(recovery === undefined ? {} : { recovery }),
          });
        } catch (error) {
          options.warn?.("A knowledge revision draft claim could not be reconciled.", error);
          reconciled.push({
            draft,
            recovery: {
              code: "mission_unreadable",
              message: "The linked Mission could not be reconciled. The draft was left unchanged.",
            },
          });
        }
      }
      return reconciled.toSorted((left, right) =>
        right.draft.updatedAt.localeCompare(left.draft.updatedAt),
      );
    },

    async listDrafts(filter = {}) {
      return (await api.listDraftsWithRecovery(filter)).map((entry) => entry.draft);
    },

    async getDraftWithRecovery(draftId) {
      const draft = await readDraft(draftId);
      const recovery = await recoverOrphanedClaim({
        draftId: draft.id,
        missionId: draft.activeMissionId,
      });
      return {
        draft: draft.activeMissionId === undefined ? draft : await readDraft(draft.id),
        ...(recovery === undefined ? {} : { recovery }),
      };
    },

    async getDraft(draftId) {
      return (await api.getDraftWithRecovery(draftId)).draft;
    },

    async getDraftChangeSet(draftId) {
      const draft = await readDraft(draftId);
      const base = await options.contextStores.getSnapshot(draft.storeId, draft.baseRevision);
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
        const base = await options.contextStores.getSnapshot(current.storeId, current.baseRevision);
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
          await mutateJob(job.id, job.revision, () => ({
            state: "pending_review",
            error: undefined,
          }));
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
        if (draft.state === "merged") {
          throw invalidState("Merged drafts are retained as revision history.");
        }
        const jobs = (await readAllJobs()).filter((candidate) => candidate.draftId === draftId);
        for (const candidate of jobs) {
          let job = candidate;
          if (job.state !== "merged" && job.state !== "rejected") {
            job = await mutateJob(job.id, job.revision, () => ({
              state: "rejected",
              error: { code: "draft_discarded", message: "The knowledge draft was discarded." },
            }));
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
            await mutateJob(job.id, job.revision, () => ({ missionId: undefined }));
          }
        }
        await mkdir(draftsTrashPath, { recursive: true, mode: 0o700 });
        await rename(
          draftRoot(draftId),
          join(draftsTrashPath, `${draftId}-${new Date().toISOString().replaceAll(":", "-")}`),
        );
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
      return await options.contextStores.withRevisionLock(draft.storeId, async () => {
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
        if (
          current.revision !== inspection.currentStoreRevision ||
          current.snapshotHash !== inspection.currentSnapshotHash
        ) {
          throw revisionConflict();
        }
        const originalBase = await options.contextStores.getSnapshot(
          draft.storeId,
          draft.baseRevision,
        );
        const effective = materializeDraftSnapshot(draft, originalBase);
        const overlay = rebaseOverlay(effective, current, draft.overlay, resolutions);
        return await mutateDraftRecord(draft.id, parsed.expectedRevision, () => ({
          baseRevision: current.revision,
          baseSnapshotHash: current.snapshotHash,
          state: "editing",
          submittedRevision: undefined,
          overlay,
        }));
      });
    },

    async resolveDraft(draftId) {
      const draft = await readDraft(draftId);
      return {
        revision: String(draft.revision),
        name: draft.name,
        store: new SparseContextStoreDraft(draftId, {
          read: readDraft,
          readBase: async (current) =>
            await options.contextStores.getSnapshot(current.storeId, current.baseRevision),
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
          : await mutateJob(job.id, job.revision, () => ({
              missionId,
              state: "running",
            }));
      if (draft.activeMissionId !== missionId) {
        await mutateDraftRecord(draft.id, draft.revision, () => ({ activeMissionId: missionId }));
      }
      return updated;
    },

    async detachMission(jobId, missionId) {
      const job = await readJob(jobId);
      if (job.missionId !== missionId) return job;
      const draft = await readDraft(job.draftId);
      if (draft.activeMissionId === missionId && draft.state !== "merged") {
        await mutateDraftRecord(draft.id, draft.revision, (current) => ({
          activeMissionId: undefined,
          ...(current.state === "pending_review"
            ? { submittedRevision: current.revision + 1 }
            : {}),
        }));
      }
      return await mutateJob(job.id, job.revision, () => ({
        missionId: undefined,
        state: job.state === "running" ? "editing" : job.state,
      }));
    },

    async releaseMissionClaim(input) {
      await releaseMissionClaim(input);
    },

    async recoverMissionClaimReleases() {
      await recoverMissionClaimReleases();
    },

    async processPending() {
      if (processing !== undefined) return await processing;
      const run = (async () => {
        await recoverMissionClaimReleases();
        const pausedDrafts = (await api.list()).filter(
          (job) =>
            job.state === "needs_attention" &&
            job.error?.code === "draft_not_submitted" &&
            job.missionId !== undefined,
        );
        for (const paused of pausedDrafts) {
          await mutateJob(paused.id, paused.revision, () => ({
            state: "editing",
            error: undefined,
          }));
        }
        const interruptedMerges = (await api.list()).filter((job) => job.state === "merging");
        for (const interrupted of interruptedMerges) {
          const draft = await readDraft(interrupted.draftId);
          const applied = (await options.contextStores.history(draft.storeId)).some(
            (record) => record.revisionJobId === interrupted.id,
          );
          if (applied) {
            if (draft.state !== "merged") await forceDraftState(draft, "merged");
            const merged = await mutateJob(interrupted.id, interrupted.revision, () => ({
              state: "merged",
              error: undefined,
            }));
            if (
              merged.missionId !== undefined &&
              (await notifyRevisionDetached({
                missionId: merged.missionId,
                jobId: merged.id,
                draftId: merged.draftId,
                storeId: merged.request.storeId,
              }))
            ) {
              await mutateJob(merged.id, merged.revision, () => ({ missionId: undefined }));
            }
            continue;
          }
          const live = await options.contextStores.getSnapshot(draft.storeId);
          if (
            live.revision !== draft.baseRevision ||
            live.snapshotHash !== draft.baseSnapshotHash
          ) {
            await forceDraftState(draft, "needs_rebase");
            await mutateJob(interrupted.id, interrupted.revision, () => ({
              state: "needs_rebase",
            }));
            continue;
          }
          if (draft.state === "merging") await forceDraftState(draft, "pending_review");
          const replay = await mutateJob(interrupted.id, interrupted.revision, () => ({
            state: "pending_review",
          }));
          await api.approve(replay.id, replay.revision);
        }
        const candidates = (await api.list()).filter(
          (job) => job.state === "editing" && job.missionId === undefined,
        );
        for (const candidate of candidates) {
          const running = await mutateJob(candidate.id, candidate.revision, () => ({
            state: "running",
          }));
          try {
            const draft = await readDraft(running.draftId);
            const snapshot = await options.contextStores.getSnapshot(
              draft.storeId,
              draft.baseRevision,
            );
            const generatedChangeSet = await options.generator.generate({
              jobId: running.id,
              draftId: draft.id,
              request: running.request,
              snapshot,
            });
            if (generatedChangeSet !== undefined) {
              const changeSet = attachContextStoreBaseContent(
                snapshot,
                ContextStoreChangeSetSchema.parse(generatedChangeSet),
              );
              const generated = await mutateDraftOverlay(draft.id, draft.revision, () =>
                overlayFromChangeSet(changeSet),
              );
              await api.submitDraft(generated.id, generated.revision, changeSet.summary);
              continue;
            }
            const completedByAgent = await api.get(running.id);
            if (completedByAgent.state !== "pending_review") {
              await mutateJob(completedByAgent.id, completedByAgent.revision, () => ({
                state: "editing",
                error: undefined,
              }));
            }
          } catch (error) {
            const failed = await api.get(running.id).catch(() => undefined);
            if (failed !== undefined && !["merged", "rejected"].includes(failed.state)) {
              await mutateJob(failed.id, failed.revision, () => ({
                state: "needs_attention",
                error: { code: "generation_failed", message: errorMessage(error) },
              })).catch(() => undefined);
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
      return (await readAllDrafts()).some(
        (draft) => draft.storeId === storeId && draft.state !== "merged",
      );
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
    schemaVersion: "pragma.context-store-change-set/v1",
    storeId: draft.storeId,
    baseRevision: draft.baseRevision,
    baseSnapshotHash: draft.baseSnapshotHash,
    summary: draft.summary ?? `Merge knowledge draft ${draft.name}.`,
    operations: [
      ...draft.overlay.files.map((file) => ({ operation: "upsert" as const, ...file })),
      ...[...explicitDeletes].map((id) => ({ operation: "delete" as const, id })),
    ],
  });
}

function overlayFromChangeSet(changeSet: ContextStoreChangeSet): ContextStoreDraftOverlay {
  const files: ContextStoreDraftOverlay["files"] = [];
  const deletedFiles: string[] = [];
  for (const operation of changeSet.operations) {
    if (operation.operation === "upsert") {
      files.push({
        id: operation.id,
        content: operation.content,
        metadata: operation.metadata,
      });
    } else {
      deletedFiles.push(operation.id);
    }
  }
  return { files, deletedFiles, directories: [], deletedDirectories: [] };
}

async function inspectRebase(
  draft: ContextStoreDraft,
  stores: ContextStoreStore,
): Promise<ContextStoreDraftRebaseInspection> {
  const current = await stores.getSnapshot(draft.storeId);
  const base = await stores.getSnapshot(draft.storeId, draft.baseRevision);
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
    currentStoreRevision: current.revision,
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
