import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/core";
import {
  applySkillChangeSet,
  validateSkillPackage,
  type GeneratedSkillValidationResult,
} from "@pragma/built-in-agents";
import {
  SkillRevisionDraftSchema,
  ManagedSkillRevisionJobSchema,
  SkillRevisionRequestV4Schema,
  type SkillRevisionDraft,
  type ManagedSkillRevisionJob,
  type SkillRevisionRequestV4,
} from "@pragma/built-in-agents/contracts";
import { SkillPackageSchema, type SkillPackage } from "@pragma/shared";
import { z } from "zod";

import {
  SkillRevisionReviewFileSchema,
  SkillRevisionReviewSchema,
  type SkillRevisionReview,
  type SkillRevisionReviewFile,
} from "../../../shared/contracts/index.ts";
import { copySkillSource, type CapabilityStore } from "./capability-store.ts";
import {
  SkillWorkingTreeError,
  assertSkillCopyTarget,
  copySkillTree,
  createStableSkillSubmission,
  emptySkillWorkingTreeSnapshot,
  scanSkillWorkingTree,
  type SkillWorkingTreeEntry,
  type SkillWorkingTreeSnapshot,
} from "./skill-revision-draft-store.ts";
import {
  SkillRevisionDraftV1Schema,
  SkillRevisionDraftV2StoredSchema,
  SkillRevisionDraftV3StoredSchema,
  SkillRevisionDraftV4StoredSchema,
  SkillRevisionJobV1StoredSchema,
  SkillRevisionJobV2StoredSchema,
  SkillRevisionJobV3StoredSchema,
  SkillRevisionJobV4StoredSchema,
  SkillRevisionMigrationJournalSchema,
  migrateSkillRevisionDraftV1ToV2,
  migrateSkillRevisionDraftV2ToV3,
  migrateSkillRevisionDraftV3ToV4,
  migrateSkillRevisionDraftV4ToV5,
  migrateSkillRevisionJobV2ToV3,
  migrateSkillRevisionJobV3ToV4,
  migrateSkillRevisionJobV4ToV5,
  type SkillRevisionDraftV4Stored,
  type SkillRevisionJobV1Stored,
  type SkillRevisionMigrationJournal,
} from "./skill-revision-migrations/index.ts";
import {
  prepareSkillRevisionWorkspace,
  resolveSkillRevisionDraftRootForRemoval,
  resolveSkillRevisionWorkspacePath,
  skillRevisionWorkspacePaths,
} from "./skill-revision-workspace.ts";
import { deterministicRevisionUuid } from "../built-in-agents/revision-resource-id.ts";

export interface SkillRevisionGenerator {
  generate(input: {
    readonly jobId: string;
    readonly draftId: string;
    readonly request: SkillRevisionRequestV4;
    readonly current: SkillPackage;
    readonly revision: number;
    readonly contentHash: string;
  }): Promise<import("@pragma/built-in-agents/contracts").SkillRevisionChangeSet | undefined>;
}

const SkillRevisionSubmissionRequestSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-revision-submission/v1"),
    capabilityId: z.string().uuid(),
    prompt: z.string().trim().min(1).max(50_000),
    source: z.enum(["user", "memory-learning"]),
    sourceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    sourceRefs: z
      .array(
        z
          .object({
            kind: z.enum(["episodic", "semantic", "knowledge"]),
            id: z.string().min(1),
            revision: z.number().int().positive(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
export type SkillRevisionSubmissionRequest = z.infer<typeof SkillRevisionSubmissionRequestSchema>;

export interface SkillDraftInspection {
  readonly draft: SkillRevisionDraft;
  readonly draftPath?: string;
  readonly referencePath?: string;
  readonly workingTree: SkillWorkingTreeSnapshot;
  readonly currentRevision: number;
  readonly currentContentHash: string;
  readonly stale: boolean;
  readonly changes: readonly {
    readonly path: string;
    readonly kind: "added" | "modified" | "deleted" | "type-changed";
    readonly sizeBytes?: number;
    readonly sha256?: string;
    readonly executable?: boolean;
  }[];
}

export interface SkillRevisionService {
  /** Compatibility entry used by Memory while it moves to managed Skill Missions. */
  submit(request: SkillRevisionSubmissionRequest): Promise<ManagedSkillRevisionJob>;
  importSource(input: {
    readonly capabilityId: string;
    readonly sourcePath: string;
  }): Promise<ManagedSkillRevisionJob>;
  start(
    request: SkillRevisionRequestV4,
    options?: {
      readonly draftId?: string;
      readonly draftName?: string;
      readonly missionId?: string;
      readonly workspacePath?: string;
    },
  ): Promise<ManagedSkillRevisionJob>;
  list(filter?: {
    readonly capabilityId?: string;
    readonly state?: ManagedSkillRevisionJob["state"];
  }): Promise<readonly ManagedSkillRevisionJob[]>;
  listDrafts(filter?: {
    readonly capabilityId?: string;
    readonly state?: SkillRevisionDraft["state"];
  }): Promise<readonly SkillRevisionDraft[]>;
  listDiagnostics(): Promise<readonly SkillRevisionRecordDiagnostic[]>;
  get(jobId: string): Promise<ManagedSkillRevisionJob>;
  getDraft(draftId: string): Promise<SkillRevisionDraft>;
  getReview(jobId: string): Promise<SkillRevisionReview>;
  getReviewFile(jobId: string, path: string): Promise<SkillRevisionReviewFile>;
  inspectDraft(draftId: string, missionId?: string): Promise<SkillDraftInspection>;
  attachMission(jobId: string, missionId: string): Promise<ManagedSkillRevisionJob>;
  detachMission(jobId: string, missionId: string): Promise<ManagedSkillRevisionJob>;
  submitDraft(input: {
    readonly draftId: string;
    readonly expectedRevision: number;
    readonly expectedWorkingTreeHash: string;
    readonly summary: string;
    readonly missionId?: string;
  }): Promise<ManagedSkillRevisionJob>;
  approve(jobId: string, expectedRevision: number): Promise<ManagedSkillRevisionJob>;
  reject(jobId: string, expectedRevision: number): Promise<ManagedSkillRevisionJob>;
  retry(jobId: string, expectedRevision: number): Promise<ManagedSkillRevisionJob>;
  discardDraft(input: {
    readonly draftId: string;
    readonly expectedRevision: number;
    readonly expectedWorkingTreeHash: string;
    readonly missionId?: string;
  }): Promise<void>;
  delete(jobId: string, expectedRevision: number): Promise<void>;
  processPending(): Promise<void>;
  scheduleProcessing(): void;
}

export interface SkillRevisionRecordDiagnostic {
  readonly kind: "job" | "draft";
  readonly id: string;
  readonly code: string;
  readonly message: string;
}

type SkillRevisionMigrationJournalWithoutHash = SkillRevisionMigrationJournal extends infer T
  ? T extends { readonly sourceHash: string }
    ? Omit<T, "sourceHash">
    : never
  : never;

export function createSkillRevisionService(options: {
  readonly statePath: string;
  readonly draftsPath?: string;
  readonly draftsTrashPath?: string;
  readonly capabilities: CapabilityStore;
  readonly generator?: SkillRevisionGenerator;
  readonly resolveWorkspacePath?:
    ((missionId?: string | undefined, draftId?: string | undefined) => Promise<string>) | undefined;
  readonly warn?: (message: string, error: unknown) => void;
}): SkillRevisionService {
  const jobsPath = join(options.statePath, "jobs");
  const draftsPath = options.draftsPath ?? join(options.statePath, "drafts");
  const draftsTrashPath = options.draftsTrashPath ?? join(options.statePath, "trash", "drafts");
  const discardJournalsPath = join(options.statePath, "discard-journals");
  const submissionCleanupJournalsPath = join(options.statePath, "submission-cleanup-journals");
  const submissionCleanupLockPath = join(options.statePath, ".submission-cleanup.lock");
  const migrationJournalsPath = join(options.statePath, "migration-journals");
  const migrationBackupsPath = join(options.statePath, "migration-backups");
  const lockPath = join(options.statePath, ".lock");
  const jobPath = (id: string) => join(jobsPath, `${id}.json`);
  const draftRoot = (id: string) => join(draftsPath, id);
  const draftPath = (id: string) => join(draftRoot(id), "draft.json");
  const legacyWorktreePath = (id: string) => join(draftRoot(id), "worktree");
  const worktreePath = (draft: Pick<SkillRevisionDraft, "id" | "workspacePath">) =>
    skillRevisionWorkspacePaths(draft.workspacePath, draft.id).worktreePath;
  const submissionsPath = (id: string) => join(draftRoot(id), "submissions");
  const candidatePath = (
    draft: Pick<
      SkillRevisionDraft,
      "id" | "workspacePath" | "state" | "submissionHash" | "rebaseReferenceHash"
    >,
  ) =>
    draft.state === "editing"
      ? worktreePath(draft)
      : draft.submissionHash !== undefined
        ? join(submissionsPath(draft.id), draft.submissionHash)
        : draft.rebaseReferenceHash !== undefined
          ? join(submissionsPath(draft.id), draft.rebaseReferenceHash)
          : worktreePath(draft);
  let processing: Promise<void> | undefined;
  let processingRequested = false;
  let diagnostics: readonly SkillRevisionRecordDiagnostic[] = [];
  let discardRecovery: Promise<void> | undefined;
  let submissionCleanupRecovery: Promise<void> | undefined;

  const SubmissionCleanupJournalSchema = z
    .object({
      schemaVersion: z.literal("pragma.skill-revision-submission-cleanup/v1"),
      draftId: z.string().uuid(),
      jobId: z.string().uuid(),
      workspacePath: z.string().min(1).max(4_000),
      submissionHash: z.string().regex(/^[a-f0-9]{64}$/u),
      draftRevision: z.number().int().positive(),
      jobRevision: z.number().int().positive(),
      state: z.enum(["prepared", "committed", "completed"]),
    })
    .strict();

  const recoverSubmissionCleanupJournals = async (): Promise<void> => {
    const recovery = (submissionCleanupRecovery ??= withFileLock(
      submissionCleanupLockPath,
      async () => {
        for (const name of await readJsonNames(submissionCleanupJournalsPath)) {
          const journalPath = join(submissionCleanupJournalsPath, `${name}.json`);
          try {
            let journal = SubmissionCleanupJournalSchema.parse(
              JSON.parse(await readFile(journalPath, "utf8")),
            );
            if (journal.state === "completed") continue;
            const rawDraft = SkillRevisionDraftSchema.parse(
              JSON.parse(await readFile(draftPath(journal.draftId), "utf8")),
            );
            const rawJob = ManagedSkillRevisionJobSchema.parse(
              JSON.parse(await readFile(jobPath(journal.jobId), "utf8")),
            );
            if (
              journal.state === "prepared" &&
              rawDraft.revision === journal.draftRevision - 1 &&
              rawDraft.state === "editing" &&
              rawDraft.submissionHash === undefined &&
              rawJob.revision === journal.jobRevision - 1 &&
              ["editing", "running"].includes(rawJob.state)
            ) {
              await rm(journalPath, { force: true });
              continue;
            }
            if (
              rawDraft.workspacePath !== journal.workspacePath ||
              rawJob.draftId !== rawDraft.id ||
              rawDraft.submissionHash !== journal.submissionHash ||
              rawDraft.revision < journal.draftRevision
            ) {
              throw coded("skill_revision_submission_cleanup_invalid");
            }
            if (journal.state === "prepared") {
              if (
                rawDraft.state === "pending_review" &&
                rawJob.revision === journal.jobRevision - 1 &&
                ["editing", "running"].includes(rawJob.state)
              ) {
                await writeJob(
                  ManagedSkillRevisionJobSchema.parse({
                    ...rawJob,
                    revision: journal.jobRevision,
                    state: "pending_review",
                    error: undefined,
                    updatedAt: rawDraft.updatedAt,
                  }),
                );
              } else if (
                rawJob.revision < journal.jobRevision ||
                ![
                  "pending_review",
                  "publishing",
                  "completed",
                  "rejected",
                  "needs_attention",
                  "superseded",
                ].includes(rawJob.state)
              ) {
                throw coded("skill_revision_submission_cleanup_invalid");
              }
              journal = { ...journal, state: "committed" };
              await writeJsonAtomic(journalPath, journal);
            }
            const removableDraftRoot = await resolveSkillRevisionDraftRootForRemoval(
              journal.workspacePath,
              journal.draftId,
            );
            await rm(removableDraftRoot, { recursive: true, force: true });
            await writeJsonAtomic(journalPath, { ...journal, state: "completed" });
          } catch (error) {
            options.warn?.("Failed to recover a submitted Skill draft cleanup.", error);
          }
        }
      },
    ));
    try {
      await recovery;
    } finally {
      if (submissionCleanupRecovery === recovery) {
        submissionCleanupRecovery = undefined;
      }
    }
  };

  const cleanupCommittedDraftWorkspace = async (
    draft: SkillRevisionDraft,
    job: ManagedSkillRevisionJob,
  ): Promise<void> => {
    if (draft.submissionHash === undefined) {
      throw coded("skill_revision_state_invalid");
    }
    const journalPath = join(submissionCleanupJournalsPath, `${draft.id}.json`);
    const journal = SubmissionCleanupJournalSchema.parse({
      schemaVersion: "pragma.skill-revision-submission-cleanup/v1",
      draftId: draft.id,
      jobId: job.id,
      workspacePath: draft.workspacePath,
      submissionHash: draft.submissionHash,
      draftRevision: draft.revision,
      jobRevision: job.revision,
      state: "committed",
    });
    await withFileLock(submissionCleanupLockPath, async () => {
      await writeJsonAtomic(journalPath, journal);
      submissionCleanupRecovery = undefined;
      try {
        await rm(await resolveSkillRevisionDraftRootForRemoval(draft.workspacePath, draft.id), {
          recursive: true,
          force: true,
        });
        await writeJsonAtomic(journalPath, { ...journal, state: "completed" });
      } catch (error) {
        submissionCleanupRecovery = undefined;
        options.warn?.("Failed to remove a submitted Skill draft working directory.", error);
      }
    });
  };

  const recoverDiscardJournals = async (): Promise<void> => {
    discardRecovery ??= (async () => {
      for (const name of await readJsonNames(discardJournalsPath)) {
        const journalPath = join(discardJournalsPath, `${name}.json`);
        const journal = z
          .object({
            schemaVersion: z.literal("pragma.skill-revision-draft-discard/v1"),
            draftId: z.string().uuid(),
            sourcePath: z.string().min(1),
            trashPath: z.string().min(1),
            workspacePath: z.string().min(1).max(4_000).optional(),
            workingTreeHash: z.string().regex(/^[a-f0-9]{64}$/u),
            discardedAt: z.string().datetime(),
            state: z.enum(["prepared", "completed"]),
          })
          .parse(JSON.parse(await readFile(journalPath, "utf8")));
        if (journal.state === "completed") continue;
        try {
          await access(journal.trashPath);
        } catch {
          await rename(journal.sourcePath, journal.trashPath);
        }
        if (journal.workspacePath !== undefined) {
          await rm(
            await resolveSkillRevisionDraftRootForRemoval(journal.workspacePath, journal.draftId),
            { recursive: true, force: true },
          );
        }
        await writeJsonAtomic(journalPath, { ...journal, state: "completed" });
      }
    })().catch((error) => {
      discardRecovery = undefined;
      throw error;
    });
    await discardRecovery;
  };

  const writeJob = async (job: ManagedSkillRevisionJob) =>
    await writeJsonAtomic(jobPath(job.id), ManagedSkillRevisionJobSchema.parse(job));
  const writeDraft = async (draft: SkillRevisionDraft) =>
    await writeJsonAtomic(draftPath(draft.id), SkillRevisionDraftSchema.parse(draft));

  const adjacentMigration = (
    kind: "job" | "draft",
    id: string,
    sourceVersion:
      | "pragma.skill-revision-job/v2"
      | "pragma.skill-revision-job/v3"
      | "pragma.skill-revision-job/v4"
      | "pragma.skill-revision-draft/v1"
      | "pragma.skill-revision-draft/v2"
      | "pragma.skill-revision-draft/v3"
      | "pragma.skill-revision-draft/v4",
    workspacePath?: string,
  ): SkillRevisionMigrationJournalWithoutHash => {
    const base = {
      schemaVersion: "pragma.skill-revision-migration/v1" as const,
      kind,
      recordId: id,
      recordPath: kind === "job" ? jobPath(id) : draftPath(id),
    };
    if (kind === "job" && sourceVersion === "pragma.skill-revision-job/v2") {
      return {
        ...base,
        kind,
        sourceVersion,
        targetVersion: "pragma.skill-revision-job/v3",
        backupPath: join(migrationBackupsPath, `${id}.v2.json`),
      };
    }
    if (kind === "job" && sourceVersion === "pragma.skill-revision-job/v3") {
      return {
        ...base,
        kind,
        sourceVersion,
        targetVersion: "pragma.skill-revision-job/v4",
        backupPath: join(migrationBackupsPath, `${id}.v3.json`),
      };
    }
    if (kind === "job" && sourceVersion === "pragma.skill-revision-job/v4") {
      return {
        ...base,
        kind,
        sourceVersion,
        targetVersion: "pragma.skill-revision-job/v5",
        backupPath: join(migrationBackupsPath, `${id}.v4.json`),
      };
    }
    if (kind === "draft" && sourceVersion === "pragma.skill-revision-draft/v1") {
      return {
        ...base,
        kind,
        sourceVersion,
        targetVersion: "pragma.skill-revision-draft/v2",
        backupPath: join(migrationBackupsPath, `draft-${id}.v1.json`),
      };
    }
    if (kind === "draft" && sourceVersion === "pragma.skill-revision-draft/v2") {
      return {
        ...base,
        kind,
        sourceVersion,
        targetVersion: "pragma.skill-revision-draft/v3",
        backupPath: join(migrationBackupsPath, `draft-${id}.v2.json`),
      };
    }
    if (kind === "draft" && sourceVersion === "pragma.skill-revision-draft/v4") {
      return {
        ...base,
        kind,
        sourceVersion,
        targetVersion: "pragma.skill-revision-draft/v5",
        backupPath: join(migrationBackupsPath, `draft-${id}.v4.json`),
      };
    }
    if (kind !== "draft" || sourceVersion !== "pragma.skill-revision-draft/v3") {
      throw coded("skill_revision_migration_journal_invalid");
    }
    if (workspacePath === undefined) throw coded("skill_revision_workspace_unavailable");
    return {
      ...base,
      kind,
      sourceVersion,
      targetVersion: "pragma.skill-revision-draft/v4",
      backupPath: join(migrationBackupsPath, `draft-${id}.v3.json`),
      workspacePath,
      sourceWorktreePath: legacyWorktreePath(id),
      targetWorktreePath: skillRevisionWorkspacePaths(workspacePath, id).worktreePath,
    };
  };

  const adjacentMigrationJournalPath = (
    kind: "job" | "draft",
    id: string,
    sourceVersion: SkillRevisionMigrationJournal["sourceVersion"],
  ): string => {
    const targetVersion =
      sourceVersion === "pragma.skill-revision-job/v2"
        ? "pragma.skill-revision-job/v3"
        : sourceVersion === "pragma.skill-revision-job/v3"
          ? "pragma.skill-revision-job/v4"
          : sourceVersion === "pragma.skill-revision-job/v4"
            ? "pragma.skill-revision-job/v5"
            : sourceVersion === "pragma.skill-revision-draft/v1"
              ? "pragma.skill-revision-draft/v2"
              : sourceVersion === "pragma.skill-revision-draft/v2"
                ? "pragma.skill-revision-draft/v3"
                : sourceVersion === "pragma.skill-revision-draft/v3"
                  ? "pragma.skill-revision-draft/v4"
                  : "pragma.skill-revision-draft/v5";
    return join(
      migrationJournalsPath,
      `${kind}-${id}.${sourceVersion.slice(sourceVersion.lastIndexOf("/") + 1)}-to-${targetVersion.slice(targetVersion.lastIndexOf("/") + 1)}.json`,
    );
  };

  const readAdjacentMigrationJournal = async (
    kind: "job" | "draft",
    id: string,
    sourceVersion: SkillRevisionMigrationJournal["sourceVersion"],
    workspacePath?: string,
  ): Promise<SkillRevisionMigrationJournal | undefined> => {
    const path = adjacentMigrationJournalPath(kind, id, sourceVersion);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const journal = SkillRevisionMigrationJournalSchema.parse(raw);
    const expected = adjacentMigration(
      kind,
      id,
      sourceVersion,
      workspacePath ??
        (journal.sourceVersion === "pragma.skill-revision-draft/v3"
          ? journal.workspacePath
          : undefined),
    );
    for (const [key, value] of Object.entries(expected)) {
      if (journal[key as keyof typeof journal] !== value) {
        throw coded("skill_revision_migration_journal_invalid");
      }
    }
    return journal;
  };

  const assertAdjacentMigrationBackup = async (
    journal: SkillRevisionMigrationJournal,
  ): Promise<void> => {
    const source = JSON.parse(await readFile(journal.backupPath, "utf8")) as unknown;
    if (journal.sourceVersion === "pragma.skill-revision-job/v2")
      SkillRevisionJobV2StoredSchema.parse(source);
    else if (journal.sourceVersion === "pragma.skill-revision-job/v3")
      SkillRevisionJobV3StoredSchema.parse(source);
    else if (journal.sourceVersion === "pragma.skill-revision-job/v4")
      SkillRevisionJobV4StoredSchema.parse(source);
    else if (journal.sourceVersion === "pragma.skill-revision-draft/v1")
      SkillRevisionDraftV1Schema.parse(source);
    else if (journal.sourceVersion === "pragma.skill-revision-draft/v2")
      SkillRevisionDraftV2StoredSchema.parse(source);
    else if (journal.sourceVersion === "pragma.skill-revision-draft/v3")
      SkillRevisionDraftV3StoredSchema.parse(source);
    else SkillRevisionDraftV4StoredSchema.parse(source);
    if (jsonHash(source) !== journal.sourceHash) {
      throw coded("skill_revision_migration_backup_mismatch");
    }
  };

  const finishAdjacentMigration = async (
    kind: "job" | "draft",
    id: string,
    currentDraft?: SkillRevisionDraft,
  ): Promise<void> => {
    const versions =
      kind === "job"
        ? ([
            "pragma.skill-revision-job/v2",
            "pragma.skill-revision-job/v3",
            "pragma.skill-revision-job/v4",
          ] as const)
        : ([
            "pragma.skill-revision-draft/v1",
            "pragma.skill-revision-draft/v2",
            "pragma.skill-revision-draft/v3",
            "pragma.skill-revision-draft/v4",
          ] as const);
    for (const sourceVersion of versions) {
      const journal = await readAdjacentMigrationJournal(
        kind,
        id,
        sourceVersion,
        currentDraft?.workspacePath,
      );
      if (journal === undefined) continue;
      await assertAdjacentMigrationBackup(journal);
      if (journal.sourceVersion === "pragma.skill-revision-draft/v3") {
        await rm(journal.sourceWorktreePath, { recursive: true, force: true });
        if (currentDraft?.submissionHash !== undefined) {
          await rm(
            await resolveSkillRevisionDraftRootForRemoval(journal.workspacePath, journal.recordId),
            { recursive: true, force: true },
          );
        }
      }
      await rm(adjacentMigrationJournalPath(kind, id, sourceVersion), {
        force: true,
      });
    }
  };

  const persistAdjacentMigration = async <T>(input: {
    readonly kind: "job" | "draft";
    readonly id: string;
    readonly sourceVersion: SkillRevisionMigrationJournal["sourceVersion"];
    readonly source: unknown;
    readonly migrated: T;
    readonly workspacePath?: string;
    readonly afterWrite?: (() => Promise<void>) | undefined;
    readonly write: (value: T) => Promise<void>;
  }): Promise<T> => {
    const details = adjacentMigration(
      input.kind,
      input.id,
      input.sourceVersion,
      input.workspacePath,
    );
    const journal = SkillRevisionMigrationJournalSchema.parse({
      ...details,
      sourceHash: jsonHash(input.source),
    });
    const existing = await readAdjacentMigrationJournal(
      input.kind,
      input.id,
      input.sourceVersion,
      input.workspacePath,
    );
    if (existing === undefined) {
      try {
        const backup = JSON.parse(await readFile(journal.backupPath, "utf8")) as unknown;
        if (jsonHash(backup) !== journal.sourceHash) {
          throw coded("skill_revision_migration_backup_mismatch");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await writeJsonAtomic(journal.backupPath, input.source);
      }
      await writeJsonAtomic(
        adjacentMigrationJournalPath(input.kind, input.id, input.sourceVersion),
        journal,
      );
    } else if (existing.sourceHash !== journal.sourceHash) {
      throw coded("skill_revision_migration_journal_invalid");
    }
    await assertAdjacentMigrationBackup(journal);
    await input.write(input.migrated);
    await input.afterWrite?.();
    await rm(adjacentMigrationJournalPath(input.kind, input.id, input.sourceVersion), {
      force: true,
    });
    return input.migrated;
  };

  const migrateDraftV3 = async (
    source: import("./skill-revision-migrations/index.ts").SkillRevisionDraftV3Stored,
  ): Promise<SkillRevisionDraftV4Stored> => {
    const existingJournal = await readAdjacentMigrationJournal(
      "draft",
      source.id,
      "pragma.skill-revision-draft/v3",
    );
    const requestedWorkspacePath =
      existingJournal?.sourceVersion === "pragma.skill-revision-draft/v3"
        ? existingJournal.workspacePath
        : await options.resolveWorkspacePath?.(source.activeMissionId, source.id);
    if (requestedWorkspacePath === undefined) throw coded("skill_revision_workspace_unavailable");
    const sourceWorktree = legacyWorktreePath(source.id);
    assertSkillCopyTarget(
      sourceWorktree,
      skillRevisionWorkspacePaths(requestedWorkspacePath, source.id).worktreePath,
    );
    const resolvedWorkspacePath = await resolveSkillRevisionWorkspacePath(requestedWorkspacePath);
    assertSkillCopyTarget(
      sourceWorktree,
      skillRevisionWorkspacePaths(resolvedWorkspacePath, source.id).worktreePath,
    );
    const workspace = await prepareSkillRevisionWorkspace(
      resolvedWorkspacePath,
      source.id,
      options.warn,
    );
    if (await pathExists(sourceWorktree)) {
      const temporary = `${workspace.worktreePath}.${randomUUID()}.tmp`;
      try {
        await copySkillTree(sourceWorktree, temporary);
        const scanOptions = {
          allowMissingSkillDocument: source.operation === "create" && source.state === "editing",
        };
        const [before, copied] = await Promise.all([
          scanSkillWorkingTree(sourceWorktree, scanOptions),
          scanSkillWorkingTree(temporary, scanOptions),
        ]);
        if (before.hash !== copied.hash) throw coded("skill_revision_migration_copy_mismatch");
        await rm(workspace.worktreePath, { recursive: true, force: true });
        await rename(temporary, workspace.worktreePath);
      } finally {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      }
    } else if (source.submissionHash === undefined) {
      throw coded("skill_revision_working_tree_missing");
    }
    const migrated = migrateSkillRevisionDraftV3ToV4(source, workspace.workspacePath);
    return await persistAdjacentMigration({
      kind: "draft",
      id: source.id,
      sourceVersion: "pragma.skill-revision-draft/v3",
      source,
      migrated,
      workspacePath: workspace.workspacePath,
      write: async (value) => await writeJsonAtomic(draftPath(source.id), value),
      afterWrite: async () => {
        await rm(sourceWorktree, { recursive: true, force: true });
        if (migrated.submissionHash !== undefined) {
          await rm(workspace.draftRoot, { recursive: true, force: true });
        }
      },
    });
  };

  const readDraft = async (id: string): Promise<SkillRevisionDraft> => {
    const raw = JSON.parse(await readFile(draftPath(id), "utf8")) as unknown;
    const current = SkillRevisionDraftSchema.safeParse(raw);
    if (current.success) {
      await finishAdjacentMigration("draft", id, current.data);
      return current.data;
    }
    return await withFileLock(`${draftRoot(id)}.migration.lock`, async () => {
      const latestRaw = JSON.parse(await readFile(draftPath(id), "utf8")) as unknown;
      const latest = SkillRevisionDraftSchema.safeParse(latestRaw);
      if (latest.success) {
        await finishAdjacentMigration("draft", id, latest.data);
        return latest.data;
      }
      const storedV3 = SkillRevisionDraftV3StoredSchema.safeParse(latestRaw);
      const storedV4 = SkillRevisionDraftV4StoredSchema.safeParse(latestRaw);
      if (storedV4.success) {
        const migrated = await persistAdjacentMigration({
          kind: "draft",
          id,
          sourceVersion: "pragma.skill-revision-draft/v4",
          source: storedV4.data,
          migrated: migrateSkillRevisionDraftV4ToV5(storedV4.data),
          write: writeDraft,
        });
        await finishAdjacentMigration("draft", id, migrated);
        return migrated;
      }
      if (storedV3.success) {
        const v4 = await migrateDraftV3(storedV3.data);
        return await persistAdjacentMigration({
          kind: "draft",
          id,
          sourceVersion: "pragma.skill-revision-draft/v4",
          source: v4,
          migrated: migrateSkillRevisionDraftV4ToV5(v4),
          write: writeDraft,
        });
      }
      const storedV2 = SkillRevisionDraftV2StoredSchema.safeParse(latestRaw);
      const v2 = storedV2.success
        ? storedV2.data
        : await persistAdjacentMigration({
            kind: "draft",
            id,
            sourceVersion: "pragma.skill-revision-draft/v1",
            source: SkillRevisionDraftV1Schema.parse(latestRaw),
            migrated: migrateSkillRevisionDraftV1ToV2(SkillRevisionDraftV1Schema.parse(latestRaw)),
            write: async (value) => await writeJsonAtomic(draftPath(id), value),
          });
      const v3 = await persistAdjacentMigration({
        kind: "draft",
        id,
        sourceVersion: "pragma.skill-revision-draft/v2",
        source: v2,
        migrated: migrateSkillRevisionDraftV2ToV3(v2),
        write: async (value) => await writeJsonAtomic(draftPath(id), value),
      });
      const v4 = await migrateDraftV3(v3);
      return await persistAdjacentMigration({
        kind: "draft",
        id,
        sourceVersion: "pragma.skill-revision-draft/v4",
        source: v4,
        migrated: migrateSkillRevisionDraftV4ToV5(v4),
        write: writeDraft,
      });
    });
  };

  const createDraft = async (input: {
    readonly request: SkillRevisionRequestV4;
    readonly workspacePath: string;
    readonly name?: string;
    readonly id?: string;
  }): Promise<SkillRevisionDraft> => {
    const id = input.id ?? randomUUID();
    const timestamp = new Date().toISOString();
    let preparedWorkspaceRoot: string | undefined;
    try {
      const workspace = await prepareSkillRevisionWorkspace(input.workspacePath, id, options.warn);
      preparedWorkspaceRoot = workspace.draftRoot;
      let baseRevision = 0;
      let baseContentHash: string;
      let name: string;
      if (input.request.operation === "create") {
        baseContentHash = emptySkillWorkingTreeSnapshot().hash;
        name = input.request.resourceName!;
      } else {
        const capability = await options.capabilities.get(input.request.capabilityId);
        if (capability.definition.kind !== "skill")
          throw coded("skill_revision_target_unavailable");
        const source = await options.capabilities.skillFilesPath(
          input.request.capabilityId,
          capability.manifest.latestRevision,
        );
        await copySkillTree(source, workspace.worktreePath);
        await scanSkillWorkingTree(workspace.worktreePath);
        baseRevision = capability.manifest.latestRevision;
        baseContentHash = capability.definition.contentHash;
        name = capability.definition.name;
      }
      const draft = SkillRevisionDraftSchema.parse({
        schemaVersion: "pragma.skill-revision-draft/v5",
        operation: input.request.operation,
        id,
        revision: 1,
        capabilityId: input.request.capabilityId,
        name: input.name ?? name,
        ...(input.request.operation === "create"
          ? { resourceDescription: input.request.resourceDescription }
          : {}),
        baseRevision,
        baseContentHash,
        workspacePath: workspace.workspacePath,
        state: "editing",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await writeDraft(draft);
      return draft;
    } catch (error) {
      await rm(draftRoot(id), { recursive: true, force: true });
      if (preparedWorkspaceRoot !== undefined) {
        await rm(preparedWorkspaceRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  };

  const migrateLegacyJob = async (
    legacy: SkillRevisionJobV1Stored,
  ): Promise<ManagedSkillRevisionJob> => {
    const migrationPath = join(options.statePath, "migrations", `${legacy.id}.v1-to-v2.json`);
    let migration: { readonly draftId: string } | undefined;
    try {
      migration = z
        .object({ draftId: z.string().uuid() })
        .parse(JSON.parse(await readFile(migrationPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    migration ??= { draftId: randomUUID() };
    await writeJsonAtomic(migrationPath, migration);
    let draft: SkillRevisionDraft;
    try {
      draft = await readDraft(migration.draftId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const requestedWorkspacePath = await options.resolveWorkspacePath?.();
      if (requestedWorkspacePath === undefined) {
        throw coded("skill_revision_workspace_unavailable");
      }
      const workspace = await prepareSkillRevisionWorkspace(
        requestedWorkspacePath,
        migration.draftId,
        options.warn,
      );
      const capability = await options.capabilities.get(
        legacy.request.capabilityId,
        legacy.changeSet?.baseRevision,
      );
      if (capability.definition.kind !== "skill") throw coded("skill_revision_target_unavailable");
      await copySkillTree(
        await options.capabilities.skillFilesPath(
          legacy.request.capabilityId,
          legacy.changeSet?.baseRevision ?? capability.manifest.latestRevision,
        ),
        workspace.worktreePath,
      );
      if (legacy.changeSet !== undefined) {
        await applyLegacyChangeSetToTree(workspace.worktreePath, legacy.changeSet);
      }
      draft = SkillRevisionDraftSchema.parse({
        schemaVersion: "pragma.skill-revision-draft/v5",
        operation: "revise",
        id: migration.draftId,
        revision: 1,
        capabilityId: legacy.request.capabilityId,
        name: legacy.changeSet?.name ?? capability.definition.name,
        baseRevision: legacy.changeSet?.baseRevision ?? capability.manifest.latestRevision,
        baseContentHash: legacy.changeSet?.baseContentHash ?? capability.definition.contentHash,
        workspacePath: workspace.workspacePath,
        state:
          legacy.state === "completed"
            ? "completed"
            : legacy.state === "rejected" || legacy.state === "superseded"
              ? "rejected"
              : legacy.state === "pending_review" || legacy.state === "applying"
                ? "pending_review"
                : "needs_attention",
        ...(legacy.changeSet === undefined ? {} : { summary: legacy.changeSet.summary }),
        ...(legacy.state === "pending_review" || legacy.state === "applying"
          ? { submittedRevision: 1 }
          : {}),
        ...(legacy.state === "pending" ||
        legacy.state === "running" ||
        legacy.state === "evaluating"
          ? {
              error: {
                code: "legacy_generation_interrupted",
                message: "The legacy Skill revision was interrupted during migration.",
              },
            }
          : {}),
        createdAt: legacy.createdAt,
        updatedAt: legacy.updatedAt,
      });
      if (legacy.state === "pending_review" || legacy.state === "applying") {
        const snapshot = await scanSkillWorkingTree(worktreePath(draft));
        const submission = await createStableSkillSubmission({
          worktreePath: worktreePath(draft),
          submissionsPath: submissionsPath(draft.id),
          expectedHash: snapshot.hash,
        });
        draft = SkillRevisionDraftSchema.parse({
          ...draft,
          submissionHash: submission.snapshot.hash,
          submittedRevision: draft.revision,
        });
        await rm(workspace.draftRoot, { recursive: true, force: true });
      }
      await writeJsonAtomic(
        join(options.statePath, "migration-backups", `${legacy.id}.v1.json`),
        legacy,
      );
      await writeDraft(draft);
    }
    const requestV2 = {
      schemaVersion: "pragma.skill-revision-request/v2" as const,
      capabilityId: legacy.request.capabilityId,
      prompt: legacy.request.prompt,
      source: legacy.request.source,
      sourceDigest:
        legacy.request.sourceDigest ??
        createHash("sha256").update(JSON.stringify(legacy.request)).digest("hex"),
      sourceRefs: legacy.request.sourceRefs,
      replayCases: legacy.request.replayCases,
      boundaryCase: legacy.request.boundaryCase,
    };
    const state =
      legacy.state === "completed"
        ? "completed"
        : legacy.state === "rejected"
          ? "rejected"
          : legacy.state === "superseded"
            ? "superseded"
            : legacy.state === "pending_review"
              ? "pending_review"
              : "needs_attention";
    const migratedV2 = SkillRevisionJobV2StoredSchema.parse({
      schemaVersion: "pragma.skill-revision-job/v2",
      id: legacy.id,
      revision: legacy.revision,
      draftId: draft.id,
      request: requestV2,
      state,
      evaluation: legacy.evaluation,
      supersededBy: legacy.supersededBy,
      error: draft.error ?? legacy.error,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
    });
    const migratedV3 = await persistAdjacentMigration({
      kind: "job",
      id: legacy.id,
      sourceVersion: "pragma.skill-revision-job/v2",
      source: migratedV2,
      migrated: migrateSkillRevisionJobV2ToV3(migratedV2),
      write: async (value) => await writeJsonAtomic(jobPath(legacy.id), value),
    });
    const migratedV4 = await persistAdjacentMigration({
      kind: "job",
      id: legacy.id,
      sourceVersion: "pragma.skill-revision-job/v3",
      source: migratedV3,
      migrated: migrateSkillRevisionJobV3ToV4(migratedV3),
      write: async (value) => await writeJsonAtomic(jobPath(legacy.id), value),
    });
    await rm(migrationPath, { force: true });
    return await persistAdjacentMigration({
      kind: "job",
      id: legacy.id,
      sourceVersion: "pragma.skill-revision-job/v4",
      source: migratedV4,
      migrated: migrateSkillRevisionJobV4ToV5(migratedV4),
      write: writeJob,
    });
  };

  const readJob = async (id: string): Promise<ManagedSkillRevisionJob> => {
    try {
      const raw = JSON.parse(await readFile(jobPath(id), "utf8")) as unknown;
      const current = ManagedSkillRevisionJobSchema.safeParse(raw);
      if (current.success) {
        await finishAdjacentMigration("job", id);
        await rm(join(options.statePath, "migrations", `${id}.v1-to-v2.json`), { force: true });
        return current.data;
      }
      return await withFileLock(`${jobPath(id)}.migration.lock`, async () => {
        const latestRaw = JSON.parse(await readFile(jobPath(id), "utf8")) as unknown;
        const latest = ManagedSkillRevisionJobSchema.safeParse(latestRaw);
        if (latest.success) {
          await finishAdjacentMigration("job", id);
          await rm(join(options.statePath, "migrations", `${id}.v1-to-v2.json`), { force: true });
          return latest.data;
        }
        const legacyV2 = SkillRevisionJobV2StoredSchema.safeParse(latestRaw);
        if (legacyV2.success) {
          const migratedV3 = await persistAdjacentMigration({
            kind: "job",
            id,
            sourceVersion: "pragma.skill-revision-job/v2",
            source: legacyV2.data,
            migrated: migrateSkillRevisionJobV2ToV3(legacyV2.data),
            write: async (value) => await writeJsonAtomic(jobPath(id), value),
          });
          const migratedV4 = await persistAdjacentMigration({
            kind: "job",
            id,
            sourceVersion: "pragma.skill-revision-job/v3",
            source: migratedV3,
            migrated: migrateSkillRevisionJobV3ToV4(migratedV3),
            write: async (value) => await writeJsonAtomic(jobPath(id), value),
          });
          return await persistAdjacentMigration({
            kind: "job",
            id,
            sourceVersion: "pragma.skill-revision-job/v4",
            source: migratedV4,
            migrated: migrateSkillRevisionJobV4ToV5(migratedV4),
            write: writeJob,
          });
        }
        const legacyV3 = SkillRevisionJobV3StoredSchema.safeParse(latestRaw);
        if (legacyV3.success) {
          const migratedV4 = await persistAdjacentMigration({
            kind: "job",
            id,
            sourceVersion: "pragma.skill-revision-job/v3",
            source: legacyV3.data,
            migrated: migrateSkillRevisionJobV3ToV4(legacyV3.data),
            write: async (value) => await writeJsonAtomic(jobPath(id), value),
          });
          return await persistAdjacentMigration({
            kind: "job",
            id,
            sourceVersion: "pragma.skill-revision-job/v4",
            source: migratedV4,
            migrated: migrateSkillRevisionJobV4ToV5(migratedV4),
            write: writeJob,
          });
        }
        const legacyV4 = SkillRevisionJobV4StoredSchema.safeParse(latestRaw);
        if (legacyV4.success) {
          const migrated = await persistAdjacentMigration({
            kind: "job",
            id,
            sourceVersion: "pragma.skill-revision-job/v4",
            source: legacyV4.data,
            migrated: migrateSkillRevisionJobV4ToV5(legacyV4.data),
            write: writeJob,
          });
          await finishAdjacentMigration("job", id);
          return migrated;
        }
        return await migrateLegacyJob(SkillRevisionJobV1StoredSchema.parse(latestRaw));
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw coded("skill_revision_job_not_found");
      }
      throw error;
    }
  };

  const readAllJobs = async (): Promise<readonly ManagedSkillRevisionJob[]> => {
    await Promise.all([recoverDiscardJournals(), recoverSubmissionCleanupJournals()]);
    const names = await readJsonNames(jobsPath);
    const settled = await Promise.allSettled(names.map(readJob));
    diagnostics = [
      ...diagnostics.filter((item) => item.kind !== "job"),
      ...settled.flatMap((result, index) =>
        result.status === "rejected" ? [recordDiagnostic("job", names[index]!, result.reason)] : [],
      ),
    ];
    return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  };
  const readAllDrafts = async (): Promise<readonly SkillRevisionDraft[]> => {
    await Promise.all([recoverDiscardJournals(), recoverSubmissionCleanupJournals()]);
    let names: string[];
    try {
      names = await readdir(draftsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const settled = await Promise.allSettled(names.map(readDraft));
    diagnostics = [
      ...diagnostics.filter((item) => item.kind !== "draft"),
      ...settled.flatMap((result, index) =>
        result.status === "rejected"
          ? [recordDiagnostic("draft", names[index]!, result.reason)]
          : [],
      ),
    ];
    return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  };

  const requireOwner = (draft: SkillRevisionDraft, missionId: string | undefined): void => {
    if (draft.activeMissionId !== undefined && draft.activeMissionId !== missionId) {
      throw coded("skill_revision_owned_by_another_context");
    }
  };

  const mutateJob = async (
    id: string,
    expected: number,
    update: (current: ManagedSkillRevisionJob) => Partial<ManagedSkillRevisionJob>,
  ): Promise<ManagedSkillRevisionJob> =>
    await withFileLock(lockPath, async () => {
      const current = await readJob(id);
      if (current.revision !== expected) throw coded("skill_revision_conflict");
      const next = ManagedSkillRevisionJobSchema.parse({
        ...current,
        ...update(current),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      await writeJob(next);
      return next;
    });

  const mutateDraft = async (
    id: string,
    expected: number,
    update: (current: SkillRevisionDraft) => Partial<SkillRevisionDraft>,
  ): Promise<SkillRevisionDraft> =>
    await withFileLock(`${draftRoot(id)}.lock`, async () => {
      const current = await readDraft(id);
      if (current.revision !== expected) throw coded("skill_revision_conflict");
      const next = SkillRevisionDraftSchema.parse({
        ...current,
        ...update(current),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      await writeDraft(next);
      return next;
    });

  const findJobForDraft = async (id: string): Promise<ManagedSkillRevisionJob> => {
    const matches = (await readAllJobs())
      .filter((job) => job.draftId === id)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (matches.length === 0) throw coded("skill_revision_job_not_found");
    return matches[0]!;
  };

  const requireRebaseForChangedBase = async (
    job: ManagedSkillRevisionJob,
    draft: SkillRevisionDraft,
  ): Promise<ManagedSkillRevisionJob> => {
    const error = {
      code: "skill_revision_base_changed",
      message: "The formal Skill changed after this draft was created.",
    };
    await mutateDraft(draft.id, draft.revision, () => ({
      state: "needs_rebase",
      activeMissionId: undefined,
      rebaseReferenceHash: undefined,
      error,
    }));
    return await mutateJob(job.id, job.revision, () => ({
      state: "needs_rebase",
      error,
    }));
  };

  const completePublication = async (
    job: ManagedSkillRevisionJob,
    draft: SkillRevisionDraft,
  ): Promise<ManagedSkillRevisionJob> => {
    if (draft.submissionHash === undefined) {
      throw coded("skill_revision_approval_invalid");
    }
    let publishingJob = job;
    if (publishingJob.state === "pending_review" && draft.state === "publishing") {
      publishingJob = await mutateJob(publishingJob.id, publishingJob.revision, () => ({
        state: "publishing",
      }));
    }
    if (publishingJob.state !== "publishing") throw coded("skill_revision_approval_invalid");
    try {
      const published =
        draft.operation === "create"
          ? await options.capabilities.publishNewSkillRevisionCandidate({
              id: draft.capabilityId,
              name: draft.name,
              description: draft.resourceDescription!,
              sourcePath: join(submissionsPath(draft.id), draft.submissionHash),
              candidateContentHash: draft.submissionHash,
            })
          : await options.capabilities.publishSkillRevisionCandidate({
              id: draft.capabilityId,
              baseRevision: draft.baseRevision,
              baseContentHash: draft.baseContentHash,
              sourcePath: join(submissionsPath(draft.id), draft.submissionHash),
              candidateContentHash: draft.submissionHash,
            });
      const currentDraft = await readDraft(draft.id);
      if (currentDraft.state !== "completed") {
        await mutateDraft(currentDraft.id, currentDraft.revision, () => ({
          state: "completed",
          error: undefined,
        }));
      }
      const currentJob = await readJob(job.id);
      if (currentJob.state === "completed") return currentJob;
      return await mutateJob(currentJob.id, currentJob.revision, () => ({
        state: "completed",
        publishedRevision: published.manifest.latestRevision,
        error: undefined,
      }));
    } catch (error) {
      const failure =
        draft.operation === "create" && isReservedSkillIdConflict(error)
          ? {
              code: "skill_creation_id_conflict",
              message: "The reserved Skill id is already occupied by different content.",
            }
          : { code: errorCode(error), message: errorMessage(error) };
      const currentDraft = await readDraft(draft.id);
      if (currentDraft.state === "publishing") {
        await mutateDraft(currentDraft.id, currentDraft.revision, () => ({
          state: "needs_attention",
          error: failure,
        }));
      }
      const currentJob = await readJob(job.id);
      if (currentJob.state === "publishing" || currentJob.state === "pending_review") {
        await mutateJob(currentJob.id, currentJob.revision, () => ({
          state: "needs_attention",
          error: failure,
        }));
      }
      throw error;
    }
  };

  const quarantineInterruptedPublication = async (
    job: ManagedSkillRevisionJob,
    draft: SkillRevisionDraft,
    error: unknown,
  ): Promise<void> => {
    const failure = {
      code: "skill_revision_publication_recovery_failed",
      message: errorMessage(error),
    };
    const currentDraft = await readDraft(draft.id);
    if (currentDraft.state === "publishing") {
      await mutateDraft(currentDraft.id, currentDraft.revision, () => ({
        state: "needs_attention",
        error: failure,
      }));
    }
    const currentJob = await readJob(job.id);
    if (currentJob.state === "publishing" || currentJob.state === "pending_review") {
      await mutateJob(currentJob.id, currentJob.revision, () => ({
        state: "needs_attention",
        error: failure,
      }));
    }
  };

  const nextInterruptedPublication = async (
    jobs: readonly ManagedSkillRevisionJob[],
  ): Promise<
    { readonly job: ManagedSkillRevisionJob; readonly draft: SkillRevisionDraft } | undefined
  > => {
    for (const job of jobs) {
      if (job.state !== "publishing" && job.state !== "pending_review") continue;
      let draft: SkillRevisionDraft;
      try {
        draft = await readDraft(job.draftId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (
        draft.state === "publishing" ||
        (job.state === "publishing" && draft.state === "completed")
      ) {
        return { job, draft };
      }
    }
    return undefined;
  };

  const moveDraftToTrash = async (
    draft: SkillRevisionDraft,
    snapshot: SkillWorkingTreeSnapshot,
  ): Promise<void> => {
    const editableWorktree = worktreePath(draft);
    if (await pathExists(editableWorktree)) {
      const retainedWorktree = legacyWorktreePath(draft.id);
      const temporary = `${retainedWorktree}.${randomUUID()}.tmp`;
      try {
        await copySkillTree(editableWorktree, temporary);
        const copied = await scanSkillWorkingTree(temporary, {
          allowMissingSkillDocument: draft.operation === "create" && draft.state !== "completed",
        });
        if (copied.hash !== snapshot.hash) throw coded("skill_revision_working_tree_changed");
        await rm(retainedWorktree, { recursive: true, force: true });
        await rename(temporary, retainedWorktree);
      } finally {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    await mkdir(discardJournalsPath, { recursive: true, mode: 0o700 });
    await mkdir(draftsTrashPath, { recursive: true, mode: 0o700 });
    const discardedAt = new Date().toISOString();
    const trashPath = join(draftsTrashPath, `${draft.id}-${discardedAt.replaceAll(":", "-")}`);
    const journalPath = join(discardJournalsPath, `${draft.id}.json`);
    const journal = {
      schemaVersion: "pragma.skill-revision-draft-discard/v1" as const,
      draftId: draft.id,
      sourcePath: draftRoot(draft.id),
      trashPath,
      workspacePath: draft.workspacePath,
      workingTreeHash: snapshot.hash,
      discardedAt,
    };
    await writeJsonAtomic(journalPath, { ...journal, state: "prepared" });
    await rename(draftRoot(draft.id), trashPath);
    await rm(await resolveSkillRevisionDraftRootForRemoval(draft.workspacePath, draft.id), {
      recursive: true,
      force: true,
    });
    await writeJsonAtomic(journalPath, { ...journal, state: "completed" });
  };

  const resolveReviewState = async (jobId: string) => {
    await recoverSubmissionCleanupJournals();
    const job = await readJob(jobId);
    const draft = await readDraft(job.draftId);
    const candidateRoot = candidatePath(draft);
    const baseRoot =
      draft.operation === "create"
        ? undefined
        : await options.capabilities.skillFilesPath(draft.capabilityId, draft.baseRevision);
    const [candidate, base] = await Promise.all([
      scanSkillWorkingTree(candidateRoot, {
        allowMissingSkillDocument: draft.operation === "create" && draft.state === "editing",
      }),
      baseRoot === undefined
        ? Promise.resolve(emptySkillWorkingTreeSnapshot())
        : scanSkillWorkingTree(baseRoot),
    ]);
    return { job, draft, candidateRoot, baseRoot, candidate, base };
  };

  const service: SkillRevisionService = {
    async submit(rawRequest) {
      const legacy = SkillRevisionSubmissionRequestSchema.parse(rawRequest);
      const request = SkillRevisionRequestV4Schema.parse({
        schemaVersion: "pragma.skill-revision-request/v4",
        operation: "revise",
        capabilityId: legacy.capabilityId,
        prompt: legacy.prompt,
        source: legacy.source,
        sourceDigest:
          legacy.sourceDigest ?? createHash("sha256").update(JSON.stringify(legacy)).digest("hex"),
        sourceRefs: legacy.sourceRefs,
      });
      const job = await service.start(request);
      service.scheduleProcessing();
      return job;
    },
    async importSource(input) {
      const request = SkillRevisionRequestV4Schema.parse({
        schemaVersion: "pragma.skill-revision-request/v4",
        operation: "revise",
        capabilityId: input.capabilityId,
        prompt: "Update this Skill from the selected local package.",
        source: "user",
        sourceDigest: createHash("sha256")
          .update(`${input.sourcePath}:${randomUUID()}`)
          .digest("hex"),
        sourceRefs: [],
      });
      const job = await service.start(request);
      const draft = await readDraft(job.draftId);
      const candidatePath = worktreePath(draft);
      await rm(candidatePath, { recursive: true, force: true });
      await mkdir(candidatePath, { recursive: true, mode: 0o700 });
      await copySkillSource(input.sourcePath, candidatePath);
      const workingTree = await scanSkillWorkingTree(candidatePath);
      return await service.submitDraft({
        draftId: draft.id,
        expectedRevision: draft.revision,
        expectedWorkingTreeHash: workingTree.hash,
        summary: "Update the Skill from a local package.",
      });
    },
    async start(rawRequest, startOptions = {}) {
      const request = SkillRevisionRequestV4Schema.parse(rawRequest);
      return await withFileLock(lockPath, async () => {
        const existing = (await readAllJobs()).find(
          (job) =>
            job.request.capabilityId === request.capabilityId &&
            job.request.sourceDigest === request.sourceDigest,
        );
        if (existing !== undefined && startOptions.draftId === undefined) return existing;
        let draft: SkillRevisionDraft;
        if (startOptions.draftId === undefined) {
          const workspacePath =
            startOptions.workspacePath ??
            (await options.resolveWorkspacePath?.(startOptions.missionId));
          if (workspacePath === undefined) throw coded("skill_revision_workspace_unavailable");
          draft = await createDraft({
            request,
            workspacePath,
            ...(startOptions.draftName === undefined ? {} : { name: startOptions.draftName }),
          });
        } else {
          draft = await readDraft(startOptions.draftId);
          const needsRebase = draft.state === "needs_rebase";
          if (
            draft.capabilityId !== request.capabilityId ||
            draft.operation !== request.operation
          ) {
            throw coded("skill_revision_target_unavailable");
          }
          if (!["editing", "needs_attention", "needs_rebase"].includes(draft.state)) {
            throw coded("skill_revision_state_invalid");
          }
          requireOwner(draft, startOptions.missionId);
          if (startOptions.workspacePath !== undefined) {
            const requested = await resolveSkillRevisionWorkspacePath(startOptions.workspacePath);
            if (requested !== draft.workspacePath) {
              throw coded("skill_revision_workspace_mismatch");
            }
          }
          if (draft.state === "needs_attention" && draft.submissionHash !== undefined) {
            const prepared = await prepareSkillRevisionWorkspace(
              draft.workspacePath,
              draft.id,
              options.warn,
            );
            const replacement = `${prepared.worktreePath}.${randomUUID()}.tmp`;
            await copySkillTree(join(submissionsPath(draft.id), draft.submissionHash), replacement);
            await rm(prepared.worktreePath, { recursive: true, force: true });
            await rename(replacement, prepared.worktreePath);
          }
          let preservedCandidateHash = draft.submissionHash ?? draft.rebaseReferenceHash;
          if (needsRebase && preservedCandidateHash === undefined) {
            const candidate = await scanSkillWorkingTree(worktreePath(draft));
            preservedCandidateHash = (
              await createStableSkillSubmission({
                worktreePath: worktreePath(draft),
                submissionsPath: submissionsPath(draft.id),
                expectedHash: candidate.hash,
              })
            ).snapshot.hash;
          }
          if (needsRebase && draft.rebaseReferenceHash !== preservedCandidateHash) {
            draft = await mutateDraft(draft.id, draft.revision, () => ({
              rebaseReferenceHash: preservedCandidateHash,
            }));
          }
          const latestBase =
            needsRebase && draft.operation === "revise"
              ? await options.capabilities.get(draft.capabilityId)
              : undefined;
          if (latestBase !== undefined && latestBase.definition.kind !== "skill") {
            throw coded("skill_revision_target_unavailable");
          }
          const rebasedBase =
            latestBase?.definition.kind === "skill"
              ? {
                  baseRevision: latestBase.manifest.latestRevision,
                  baseContentHash: latestBase.definition.contentHash,
                }
              : undefined;
          if (rebasedBase !== undefined) {
            const prepared = await prepareSkillRevisionWorkspace(
              draft.workspacePath,
              draft.id,
              options.warn,
            );
            const replacement = `${prepared.worktreePath}.${randomUUID()}.tmp`;
            try {
              await copySkillTree(
                await options.capabilities.skillFilesPath(
                  draft.capabilityId,
                  rebasedBase.baseRevision,
                ),
                replacement,
              );
              await rm(prepared.worktreePath, { recursive: true, force: true });
              await rename(replacement, prepared.worktreePath);
            } finally {
              await rm(replacement, { recursive: true, force: true }).catch(() => undefined);
            }
          }
          draft = await mutateDraft(draft.id, draft.revision, () => ({
            state: "editing",
            activeMissionId: startOptions.missionId,
            ...rebasedBase,
            submissionHash: undefined,
            submittedRevision: undefined,
            error: undefined,
          }));
          const resumedJob = await findJobForDraft(draft.id);
          const resumed = ManagedSkillRevisionJobSchema.parse({
            ...resumedJob,
            ...(startOptions.missionId === undefined ? {} : { missionId: startOptions.missionId }),
            request,
            state: startOptions.missionId === undefined ? "editing" : "running",
            error: undefined,
            revision: resumedJob.revision + 1,
            updatedAt: new Date().toISOString(),
          });
          await writeJob(resumed);
          return resumed;
        }
        if (
          startOptions.missionId !== undefined &&
          draft.activeMissionId !== startOptions.missionId
        ) {
          draft = await mutateDraft(draft.id, draft.revision, () => ({
            activeMissionId: startOptions.missionId,
          }));
        }
        const timestamp = new Date().toISOString();
        const job = ManagedSkillRevisionJobSchema.parse({
          schemaVersion: "pragma.skill-revision-job/v5",
          id: randomUUID(),
          revision: 1,
          draftId: draft.id,
          ...(startOptions.missionId === undefined ? {} : { missionId: startOptions.missionId }),
          request,
          state: startOptions.missionId === undefined ? "editing" : "running",
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
            job.error?.code !== "draft_discarded" &&
            (filter.capabilityId === undefined ||
              job.request.capabilityId === filter.capabilityId) &&
            (filter.state === undefined || job.state === filter.state),
        )
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    async listDrafts(filter = {}) {
      return (await readAllDrafts())
        .filter(
          (draft) =>
            (filter.capabilityId === undefined || draft.capabilityId === filter.capabilityId) &&
            (filter.state === undefined || draft.state === filter.state),
        )
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    async listDiagnostics() {
      await Promise.all([readAllJobs(), readAllDrafts()]);
      return diagnostics;
    },
    async get(id) {
      await recoverSubmissionCleanupJournals();
      return await readJob(id);
    },
    async getDraft(id) {
      await recoverSubmissionCleanupJournals();
      return await readDraft(id);
    },
    async getReview(jobId) {
      const { job, draft, candidate, base } = await resolveReviewState(jobId);
      const operations: SkillRevisionReview["operations"][number][] = [];
      const baseByPath = new Map(base.entries.map((entry) => [entry.path, entry]));
      const candidateByPath = new Map(candidate.entries.map((entry) => [entry.path, entry]));
      for (const path of [
        ...new Set([...baseByPath.keys(), ...candidateByPath.keys()]),
      ].toSorted()) {
        const previous = baseByPath.get(path);
        const next = candidateByPath.get(path);
        if (
          previous !== undefined &&
          next !== undefined &&
          previous.sha256 === next.sha256 &&
          previous.executable === next.executable
        ) {
          continue;
        }
        if (next === undefined) {
          operations.push({
            path,
            operation: "deleted",
            before: previous === undefined ? null : reviewFileMetadata(previous),
            after: null,
          });
          continue;
        }
        operations.push({
          path,
          operation: previous === undefined ? "added" : "modified",
          before: previous === undefined ? null : reviewFileMetadata(previous),
          after: reviewFileMetadata(next),
        });
      }
      return SkillRevisionReviewSchema.parse({
        jobId: job.id,
        draftId: draft.id,
        baseSnapshotHash: base.hash,
        candidateSnapshotHash: candidate.hash,
        operations,
      });
    },
    async getReviewFile(jobId, path) {
      const { job, candidateRoot, baseRoot, candidate, base } = await resolveReviewState(jobId);
      const previous = base.entries.find((entry) => entry.path === path);
      const next = candidate.entries.find((entry) => entry.path === path);
      if (
        (previous === undefined && next === undefined) ||
        (previous !== undefined &&
          next !== undefined &&
          previous.sha256 === next.sha256 &&
          previous.executable === next.executable)
      ) {
        throw coded("skill_revision_review_file_not_found");
      }
      return SkillRevisionReviewFileSchema.parse({
        jobId: job.id,
        path,
        before:
          previous === undefined || baseRoot === undefined
            ? null
            : await readReviewFile(baseRoot, previous),
        after: next === undefined ? null : await readReviewFile(candidateRoot, next),
      });
    },
    async inspectDraft(id, missionId) {
      await recoverSubmissionCleanupJournals();
      const draft = await readDraft(id);
      const candidateRoot = candidatePath(draft);
      const workingTree = await scanSkillWorkingTree(candidateRoot, {
        allowMissingSkillDocument: draft.operation === "create" && draft.state === "editing",
      });
      const current =
        draft.operation === "create"
          ? undefined
          : await options.capabilities.get(draft.capabilityId);
      const base =
        draft.operation === "create"
          ? emptySkillWorkingTreeSnapshot()
          : await scanSkillWorkingTree(
              await options.capabilities.skillFilesPath(draft.capabilityId, draft.baseRevision),
            );
      if (current !== undefined && current.definition.kind !== "skill") {
        throw coded("skill_revision_target_unavailable");
      }
      const currentSkillDefinition =
        current?.definition.kind === "skill" ? current.definition : undefined;
      return {
        draft,
        ...(draft.state === "editing" && draft.activeMissionId === missionId
          ? {
              draftPath: worktreePath(draft),
              ...(draft.rebaseReferenceHash === undefined
                ? {}
                : {
                    referencePath: join(submissionsPath(draft.id), draft.rebaseReferenceHash),
                  }),
            }
          : { referencePath: candidateRoot }),
        workingTree,
        currentRevision: current?.manifest.latestRevision ?? 0,
        currentContentHash: currentSkillDefinition?.contentHash ?? draft.baseContentHash,
        stale:
          currentSkillDefinition === undefined || current === undefined
            ? false
            : current.manifest.latestRevision !== draft.baseRevision ||
              currentSkillDefinition.contentHash !== draft.baseContentHash,
        changes: diffSnapshots(base, workingTree),
      };
    },
    async attachMission(jobId, missionId) {
      await recoverSubmissionCleanupJournals();
      const job = await readJob(jobId);
      const draft = await readDraft(job.draftId);
      if (draft.activeMissionId !== undefined && draft.activeMissionId !== missionId) {
        throw coded("skill_revision_owned_by_another_context");
      }
      await mutateDraft(draft.id, draft.revision, () => ({ activeMissionId: missionId }));
      return await mutateJob(job.id, job.revision, () => ({ missionId, state: "running" }));
    },
    async detachMission(jobId, missionId) {
      await recoverSubmissionCleanupJournals();
      const job = await readJob(jobId);
      if (job.missionId !== missionId) throw coded("skill_revision_owned_by_another_context");
      const draft = await readDraft(job.draftId);
      if (draft.activeMissionId === missionId) {
        await mutateDraft(draft.id, draft.revision, () => ({ activeMissionId: undefined }));
      }
      return await mutateJob(job.id, job.revision, () => ({
        missionId: undefined,
        state: "editing",
      }));
    },
    async submitDraft(input) {
      await recoverSubmissionCleanupJournals();
      const draft = await readDraft(input.draftId);
      const job = await findJobForDraft(draft.id);
      if (draft.revision !== input.expectedRevision) throw coded("skill_revision_conflict");
      if (draft.state !== "editing") throw coded("skill_revision_state_invalid");
      requireOwner(draft, input.missionId);
      if (draft.operation === "revise") {
        const current = await options.capabilities.get(draft.capabilityId);
        if (
          current.definition.kind !== "skill" ||
          current.manifest.latestRevision !== draft.baseRevision ||
          current.definition.contentHash !== draft.baseContentHash
        ) {
          return await requireRebaseForChangedBase(job, draft);
        }
      }
      const candidate = await readSkillPackage(
        options.capabilities,
        draft.capabilityId,
        worktreePath(draft),
        draft.operation === "create"
          ? { name: draft.name, description: draft.resourceDescription! }
          : undefined,
      );
      if (
        draft.operation === "create" &&
        (candidate.name !== draft.name || candidate.description !== draft.resourceDescription)
      ) {
        throw coded("skill_revision_metadata_mismatch");
      }
      const validation = validateSkillPackage(candidate);
      if (!validation.passed) throw new SkillRevisionValidationError(validation);
      const submission = await createStableSkillSubmission({
        worktreePath: worktreePath(draft),
        submissionsPath: submissionsPath(draft.id),
        expectedHash: input.expectedWorkingTreeHash,
      });
      const transaction = await withFileLock(
        lockPath,
        async () =>
          await withFileLock(
            submissionCleanupLockPath,
            async () =>
              await withFileLock(`${draftRoot(draft.id)}.lock`, async () => {
                const currentDraft = SkillRevisionDraftSchema.parse(
                  JSON.parse(await readFile(draftPath(draft.id), "utf8")),
                );
                const currentJob = ManagedSkillRevisionJobSchema.parse(
                  JSON.parse(await readFile(jobPath(job.id), "utf8")),
                );
                if (
                  currentDraft.revision !== draft.revision ||
                  currentDraft.state !== "editing" ||
                  currentJob.revision !== job.revision ||
                  currentJob.draftId !== currentDraft.id
                ) {
                  throw coded("skill_revision_conflict");
                }
                requireOwner(currentDraft, input.missionId);
                const cleanupJournalPath = join(
                  submissionCleanupJournalsPath,
                  `${currentDraft.id}.json`,
                );
                const cleanupJournal = SubmissionCleanupJournalSchema.parse({
                  schemaVersion: "pragma.skill-revision-submission-cleanup/v1",
                  draftId: currentDraft.id,
                  jobId: currentJob.id,
                  workspacePath: currentDraft.workspacePath,
                  submissionHash: submission.snapshot.hash,
                  draftRevision: currentDraft.revision + 1,
                  jobRevision: currentJob.revision + 1,
                  state: "prepared",
                });
                await writeJsonAtomic(cleanupJournalPath, cleanupJournal);
                const timestamp = new Date().toISOString();
                await writeDraft(
                  SkillRevisionDraftSchema.parse({
                    ...currentDraft,
                    revision: cleanupJournal.draftRevision,
                    state: "pending_review",
                    activeMissionId: undefined,
                    submissionHash: submission.snapshot.hash,
                    rebaseReferenceHash: undefined,
                    submittedRevision: cleanupJournal.draftRevision,
                    summary: input.summary,
                    error: undefined,
                    updatedAt: timestamp,
                  }),
                );
                const nextJob = ManagedSkillRevisionJobSchema.parse({
                  ...currentJob,
                  revision: cleanupJournal.jobRevision,
                  state: "pending_review",
                  error: undefined,
                  updatedAt: timestamp,
                });
                await writeJob(nextJob);
                await writeJsonAtomic(cleanupJournalPath, {
                  ...cleanupJournal,
                  state: "committed",
                });
                return { cleanupJournal, cleanupJournalPath, nextJob };
              }),
          ),
      );
      try {
        const removableDraftRoot = await resolveSkillRevisionDraftRootForRemoval(
          transaction.cleanupJournal.workspacePath,
          transaction.cleanupJournal.draftId,
        );
        await rm(removableDraftRoot, { recursive: true, force: true });
        await writeJsonAtomic(transaction.cleanupJournalPath, {
          ...transaction.cleanupJournal,
          state: "completed",
        });
      } catch (error) {
        submissionCleanupRecovery = undefined;
        options.warn?.("Failed to remove a submitted Skill draft working directory.", error);
      }
      return transaction.nextJob;
    },
    async approve(id, expectedRevision) {
      await recoverSubmissionCleanupJournals();
      const job = await readJob(id);
      if (job.revision !== expectedRevision || job.state !== "pending_review") {
        throw coded("skill_revision_conflict");
      }
      const draft = await readDraft(job.draftId);
      if (draft.operation === "revise") {
        const current = await options.capabilities.get(draft.capabilityId);
        if (
          current.definition.kind !== "skill" ||
          current.manifest.latestRevision !== draft.baseRevision ||
          current.definition.contentHash !== draft.baseContentHash
        ) {
          return await requireRebaseForChangedBase(job, draft);
        }
      }
      if (draft.submissionHash === undefined || draft.state !== "pending_review") {
        throw coded("skill_revision_approval_invalid");
      }
      const candidate = await readSkillPackage(
        options.capabilities,
        draft.capabilityId,
        join(submissionsPath(draft.id), draft.submissionHash),
        draft.operation === "create"
          ? { name: draft.name, description: draft.resourceDescription! }
          : undefined,
      );
      const validation = validateSkillPackage(candidate);
      if (!validation.passed) throw new SkillRevisionValidationError(validation);
      const publishingDraft = await mutateDraft(draft.id, draft.revision, () => ({
        state: "publishing",
      }));
      const publishingJob = await mutateJob(job.id, job.revision, () => ({ state: "publishing" }));
      return await completePublication(publishingJob, publishingDraft);
    },
    async reject(id, revision) {
      await recoverSubmissionCleanupJournals();
      const job = await readJob(id);
      if (job.revision !== revision || job.state !== "pending_review") {
        throw coded("skill_revision_conflict");
      }
      const draft = await readDraft(job.draftId);
      await mutateDraft(draft.id, draft.revision, () => ({
        state: "rejected",
        activeMissionId: undefined,
      }));
      return await mutateJob(job.id, job.revision, () => ({
        state: "rejected",
      }));
    },
    async retry(id, revision) {
      await recoverSubmissionCleanupJournals();
      const candidate = await readJob(id);
      if (
        candidate.revision !== revision ||
        !["needs_attention", "rejected"].includes(candidate.state)
      ) {
        throw coded("skill_revision_conflict");
      }
      if (candidate.error?.code === "skill_revision_base_changed") {
        throw coded("skill_revision_base_changed");
      }
      if (
        candidate.request.operation === "create" &&
        candidate.error?.code === "skill_creation_id_conflict"
      ) {
        const replacement = await withFileLock(lockPath, async () => {
          const job = await readJob(id);
          if (job.revision !== revision || !["needs_attention", "rejected"].includes(job.state)) {
            throw coded("skill_revision_conflict");
          }
          const draft = await readDraft(job.draftId);
          if (
            draft.operation !== "create" ||
            draft.submissionHash === undefined ||
            draft.summary === undefined
          ) {
            throw coded("skill_revision_state_invalid");
          }
          const replacementCapabilityId = deterministicRevisionUuid("skill-conflict-resource", [
            job.id,
            revision,
            draft.capabilityId,
          ]);
          const replacementDraftId = deterministicRevisionUuid("skill-conflict-draft", [
            job.id,
            revision,
            draft.id,
          ]);
          const replacementJobId = deterministicRevisionUuid("skill-conflict-job", [
            job.id,
            revision,
          ]);
          let replacementDraft: SkillRevisionDraft;
          try {
            replacementDraft = await readDraft(replacementDraftId);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const request = SkillRevisionRequestV4Schema.parse({
              ...job.request,
              capabilityId: replacementCapabilityId,
              sourceDigest: createHash("sha256")
                .update(
                  JSON.stringify([
                    "skill_creation_id_conflict_recovery",
                    job.request.sourceDigest,
                    replacementCapabilityId,
                  ]),
                )
                .digest("hex"),
            });
            replacementDraft = await createDraft({
              request,
              workspacePath: draft.workspacePath,
              name: draft.name,
              id: replacementDraftId,
            });
          }
          if (
            replacementDraft.state !== "pending_review" ||
            replacementDraft.submissionHash !== draft.submissionHash
          ) {
            const replacementWorktree = `${worktreePath(replacementDraft)}.${randomUUID()}.tmp`;
            await copySkillTree(
              join(submissionsPath(draft.id), draft.submissionHash),
              replacementWorktree,
            );
            await rm(worktreePath(replacementDraft), { recursive: true, force: true });
            await rename(replacementWorktree, worktreePath(replacementDraft));
            const submission = await createStableSkillSubmission({
              worktreePath: worktreePath(replacementDraft),
              submissionsPath: submissionsPath(replacementDraft.id),
              expectedHash: draft.submissionHash,
            });
            replacementDraft = SkillRevisionDraftSchema.parse({
              ...replacementDraft,
              revision: replacementDraft.revision + 1,
              state: "pending_review",
              submissionHash: submission.snapshot.hash,
              submittedRevision: replacementDraft.revision + 1,
              summary: draft.summary,
              updatedAt: new Date().toISOString(),
            });
            await writeDraft(replacementDraft);
          }
          let replacementJob: ManagedSkillRevisionJob;
          try {
            replacementJob = await readJob(replacementJobId);
          } catch (error) {
            if (errorCode(error) !== "skill_revision_job_not_found") throw error;
            const timestamp = new Date().toISOString();
            replacementJob = ManagedSkillRevisionJobSchema.parse({
              schemaVersion: "pragma.skill-revision-job/v5",
              id: replacementJobId,
              revision: 1,
              draftId: replacementDraft.id,
              request: {
                ...job.request,
                capabilityId: replacementCapabilityId,
                sourceDigest: createHash("sha256")
                  .update(
                    JSON.stringify([
                      "skill_creation_id_conflict_recovery",
                      job.request.sourceDigest,
                      replacementCapabilityId,
                    ]),
                  )
                  .digest("hex"),
              },
              state: "pending_review",
              createdAt: timestamp,
              updatedAt: timestamp,
            });
            await writeJob(replacementJob);
          }
          await cleanupCommittedDraftWorkspace(replacementDraft, replacementJob);
          await writeJob(
            ManagedSkillRevisionJobSchema.parse({
              ...job,
              revision: job.revision + 1,
              state: "superseded",
              missionId: undefined,
              supersededBy: replacementJob.id,
              error: {
                code: "skill_creation_id_conflict_recovered",
                message: `The candidate was moved to replacement revision task ${replacementJob.id}.`,
              },
              updatedAt: new Date().toISOString(),
            }),
          );
          return replacementJob;
        });
        return replacement;
      }
      const job = candidate;
      const draft = await readDraft(job.draftId);
      const requiresValidation = job.error?.code === "skill_revision_validation_required";
      const nextState =
        requiresValidation || draft.submissionHash === undefined ? "editing" : "pending_review";
      if (requiresValidation && draft.submissionHash !== undefined) {
        const prepared = await prepareSkillRevisionWorkspace(
          draft.workspacePath,
          draft.id,
          options.warn,
        );
        const replacement = `${prepared.worktreePath}.${randomUUID()}.tmp`;
        try {
          await copySkillTree(join(submissionsPath(draft.id), draft.submissionHash), replacement);
          await rm(prepared.worktreePath, { recursive: true, force: true });
          await rename(replacement, prepared.worktreePath);
        } finally {
          await rm(replacement, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      await mutateDraft(draft.id, draft.revision, () => ({
        state: nextState,
        ...(requiresValidation ? { submissionHash: undefined, submittedRevision: undefined } : {}),
        error: undefined,
      }));
      const next = await mutateJob(job.id, job.revision, () => ({
        state: nextState,
        error: undefined,
      }));
      if (nextState === "editing" && next.missionId === undefined) service.scheduleProcessing();
      return next;
    },
    async discardDraft(input) {
      await recoverSubmissionCleanupJournals();
      await withFileLock(`${draftRoot(input.draftId)}.discard.lock`, async () => {
        const draft = await readDraft(input.draftId);
        if (draft.revision !== input.expectedRevision) throw coded("skill_revision_conflict");
        if (draft.state === "completed") throw coded("skill_revision_state_invalid");
        requireOwner(draft, input.missionId);
        const snapshot = await scanSkillWorkingTree(candidatePath(draft), {
          allowMissingSkillDocument: draft.operation === "create" && draft.state === "editing",
        });
        if (snapshot.hash !== input.expectedWorkingTreeHash) {
          throw coded("skill_revision_working_tree_changed");
        }
        for (const job of (await readAllJobs()).filter(
          (candidate) => candidate.draftId === draft.id,
        )) {
          if (job.state === "completed") throw coded("skill_revision_state_invalid");
          await mutateJob(job.id, job.revision, () => ({
            state: "rejected",
            error: { code: "draft_discarded", message: "The Skill draft was discarded." },
          }));
        }
        await moveDraftToTrash(draft, snapshot);
      });
    },
    async delete(id, revision) {
      await recoverSubmissionCleanupJournals();
      await withFileLock(lockPath, async () => {
        const job = await readJob(id);
        if (job.revision !== revision) throw coded("skill_revision_conflict");
        const draft = await readDraft(job.draftId);
        const candidateRoot = candidatePath(draft);
        const snapshot = await scanSkillWorkingTree(candidateRoot, {
          allowMissingSkillDocument: draft.operation === "create" && draft.state !== "completed",
        });
        for (const related of (await readAllJobs()).filter(
          (candidate) => candidate.draftId === draft.id,
        )) {
          await writeJob({
            ...related,
            state: "rejected",
            missionId: undefined,
            error: { code: "draft_discarded", message: "The Skill draft was discarded." },
            revision: related.revision + 1,
            updatedAt: new Date().toISOString(),
          });
        }
        await moveDraftToTrash(draft, snapshot);
      });
    },
    async processPending() {
      processingRequested = true;
      if (processing !== undefined) return await processing;
      processing = (async () => {
        do {
          processingRequested = false;
          const jobs = await readAllJobs();
          const interrupted = await nextInterruptedPublication(jobs);
          if (interrupted !== undefined) {
            try {
              await completePublication(interrupted.job, interrupted.draft);
              processingRequested = true;
              continue;
            } catch (error) {
              options.warn?.("Failed to recover an interrupted Skill publication.", error);
              await quarantineInterruptedPublication(
                interrupted.job,
                interrupted.draft,
                error,
              ).catch((quarantineError) => {
                options.warn?.(
                  "Failed to quarantine an interrupted Skill publication.",
                  quarantineError,
                );
              });
            }
          }
          const candidate = jobs
            .filter((job) => job.state === "editing" && job.missionId === undefined)
            .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
          if (candidate !== undefined && options.generator !== undefined) {
            const running = await mutateJob(candidate.id, candidate.revision, () => ({
              state: "running",
            }));
            try {
              const draft = await readDraft(running.draftId);
              const base = await readSkillPackage(
                options.capabilities,
                draft.capabilityId,
                worktreePath(draft),
              );
              const changeSet = await options.generator.generate({
                jobId: running.id,
                draftId: draft.id,
                request: running.request,
                current: base,
                revision: draft.baseRevision,
                contentHash: draft.baseContentHash,
              });
              if (changeSet !== undefined) {
                applySkillChangeSet(base, changeSet);
                await applyLegacyChangeSetToTree(worktreePath(draft), changeSet);
                const inspection = await service.inspectDraft(draft.id);
                await service.submitDraft({
                  draftId: draft.id,
                  expectedRevision: inspection.draft.revision,
                  expectedWorkingTreeHash: inspection.workingTree.hash,
                  summary: changeSet.summary,
                });
              } else {
                const completedByAgent = await readJob(running.id);
                if (!["pending_review", "needs_rebase"].includes(completedByAgent.state)) {
                  throw coded("skill_revision_agent_did_not_submit");
                }
              }
            } catch (error) {
              const failed = await readJob(running.id).catch(() => undefined);
              if (
                failed !== undefined &&
                !["pending_review", "needs_rebase", "completed", "rejected", "superseded"].includes(
                  failed.state,
                )
              ) {
                await mutateJob(failed.id, failed.revision, () => ({
                  state: "needs_attention",
                  error: { code: errorCode(error), message: errorMessage(error) },
                })).catch(() => undefined);
              }
            }
            processingRequested = true;
          }
        } while (processingRequested);
      })();
      try {
        await processing;
      } finally {
        processing = undefined;
        if (processingRequested) service.scheduleProcessing();
      }
    },
    scheduleProcessing() {
      queueMicrotask(() => {
        void service
          .processPending()
          .catch((error) => options.warn?.("Skill revision processing failed.", error));
      });
    },
  };
  return service;
}

function diffSnapshots(
  base: SkillWorkingTreeSnapshot,
  current: SkillWorkingTreeSnapshot,
): SkillDraftInspection["changes"] {
  const baseByPath = new Map(base.entries.map((entry) => [entry.path, entry]));
  const currentByPath = new Map(current.entries.map((entry) => [entry.path, entry]));
  const changes: Array<SkillDraftInspection["changes"][number]> = [];
  for (const path of [...new Set([...baseByPath.keys(), ...currentByPath.keys()])].toSorted()) {
    const previous = baseByPath.get(path);
    const next = currentByPath.get(path);
    if (previous === undefined && next !== undefined) changes.push({ ...next, kind: "added" });
    else if (previous !== undefined && next === undefined) changes.push({ path, kind: "deleted" });
    else if (
      previous !== undefined &&
      next !== undefined &&
      (previous.sha256 !== next.sha256 || previous.executable !== next.executable)
    ) {
      changes.push({ ...next, kind: "modified" });
    }
  }
  return changes;
}

function reviewFileMetadata(entry: SkillWorkingTreeEntry) {
  return {
    sizeBytes: entry.sizeBytes,
    sha256: entry.sha256,
    executable: entry.executable,
  };
}

async function readReviewFile(
  root: string,
  entry: SkillWorkingTreeEntry,
): Promise<NonNullable<SkillRevisionReviewFile["before"]>> {
  const metadata = reviewFileMetadata(entry);
  if (entry.sizeBytes > 1_000_000) {
    return { ...metadata, content: null, unavailableReason: "size_limit" };
  }
  const bytes = await readFile(join(root, ...entry.path.split("/")));
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) {
    return { ...metadata, content: null, unavailableReason: "binary" };
  }
  let lineCount = 1;
  for (const character of content) {
    if (character === "\n") lineCount += 1;
    if (lineCount > 5_000) {
      return { ...metadata, content: null, unavailableReason: "line_limit" };
    }
  }
  return { ...metadata, content, unavailableReason: null };
}

async function readSkillPackage(
  capabilities: CapabilityStore,
  capabilityId: string,
  root: string,
  creation?: { readonly name: string; readonly description: string },
): Promise<SkillPackage> {
  const capability = creation === undefined ? await capabilities.get(capabilityId) : undefined;
  if (capability !== undefined && capability.definition.kind !== "skill") {
    throw coded("skill_revision_target_unavailable");
  }
  const snapshot = await scanSkillWorkingTree(root);
  const files: { path: string; content: string }[] = [];
  for (const entry of snapshot.entries) {
    if (entry.path !== "SKILL.md" && !/^(?:references|scripts|tests)\/.+/u.test(entry.path))
      continue;
    const bytes = await readFile(join(root, ...entry.path.split("/")));
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) continue;
    files.push({ path: entry.path, content });
  }
  const skillDocument = files.find((file) => file.path === "SKILL.md")?.content ?? "";
  const metadata = readSkillFrontmatter(skillDocument);
  return SkillPackageSchema.parse({
    name: metadata.name ?? creation?.name ?? capability!.definition.name,
    description:
      metadata.description ?? creation?.description ?? capability!.definition.description,
    files,
  });
}

async function applyLegacyChangeSetToTree(
  root: string,
  changeSet: import("@pragma/built-in-agents/contracts").SkillRevisionChangeSet,
): Promise<void> {
  for (const operation of changeSet.operations) {
    const path = join(root, ...operation.path.split("/"));
    if (operation.operation === "delete") await unlink(path).catch(() => undefined);
    else if (operation.operation === "rename") {
      const target = join(root, ...operation.nextPath.split("/"));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(path, target);
    } else {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, operation.content, { mode: 0o600 });
    }
  }
}

function readSkillFrontmatter(content: string): { name?: string; description?: string } {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/u.exec(content)?.[1] ?? "";
  const name = /^name:\s*["']?([^\n"']+)["']?\s*$/mu.exec(frontmatter)?.[1]?.trim();
  const description = /^description:\s*["']?([^\n"']+)["']?\s*$/mu.exec(frontmatter)?.[1]?.trim();
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
  };
}

async function readJsonNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function jsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function coded(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function errorCode(error: unknown): string {
  if (error instanceof SkillWorkingTreeError) return error.code;
  const value = (error as { code?: unknown })?.code;
  if (typeof value === "string" && /^[a-z0-9_:-]+$/iu.test(value)) return value.slice(0, 100);
  const message = error instanceof Error ? error.message : "skill_revision_failed";
  return /^[a-z0-9_:-]+$/iu.test(message) ? message.slice(0, 100) : "skill_revision_failed";
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Skill revision failed.").slice(0, 2_000);
}

export class SkillRevisionValidationError extends Error {
  readonly code = "invalid_input";
  readonly retryable = true;

  constructor(readonly validation: GeneratedSkillValidationResult) {
    super(
      validation.diagnostics
        .map((diagnostic) => `${diagnostic.path}: ${diagnostic.code}: ${diagnostic.message}`)
        .join(" | ")
        .slice(0, 2_000),
    );
    this.name = "SkillRevisionValidationError";
  }
}

function isReservedSkillIdConflict(error: unknown): boolean {
  return (
    errorCode(error) === "revision_conflict" &&
    errorMessage(error) === "The reserved Skill id is already occupied by different content."
  );
}

function recordDiagnostic(
  kind: SkillRevisionRecordDiagnostic["kind"],
  id: string,
  error: unknown,
): SkillRevisionRecordDiagnostic {
  return { kind, id, code: errorCode(error), message: errorMessage(error) };
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
