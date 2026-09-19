import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/core";
import { applySkillChangeSet } from "@pragma/built-in-agents";
import {
  SkillRevisionDraftSchema,
  ManagedSkillRevisionJobSchema,
  SkillRevisionJobSchema,
  SkillRevisionRequestSchema,
  SkillRevisionRequestV3Schema,
  type SkillEvaluationSnapshot,
  type SkillRevisionDraft,
  type ManagedSkillRevisionJob,
  type SkillRevisionJob,
  type SkillRevisionRequest,
  type SkillRevisionRequestV3,
} from "@pragma/built-in-agents/contracts";
import { SkillPackageSchema, type SkillPackage } from "@pragma/shared";
import { z } from "zod";

import type { CapabilityStore } from "./capability-store.ts";
import {
  SkillWorkingTreeError,
  copySkillTree,
  createStableSkillSubmission,
  emptySkillWorkingTreeSnapshot,
  scanSkillWorkingTree,
  type SkillWorkingTreeSnapshot,
} from "./skill-revision-draft-store.ts";
import {
  SkillRevisionDraftV1Schema,
  SkillRevisionJobV2StoredSchema,
  SkillRevisionMigrationJournalSchema,
  migrateSkillRevisionDraftV1ToV2,
  migrateSkillRevisionJobV2ToV3,
  type SkillRevisionMigrationJournal,
} from "./skill-revision-migrations/index.ts";

export interface SkillRevisionGenerator {
  generate(input: {
    readonly jobId: string;
    readonly request: SkillRevisionRequest;
    readonly current: SkillPackage;
    readonly revision: number;
    readonly contentHash: string;
  }): Promise<import("@pragma/built-in-agents/contracts").SkillRevisionChangeSet>;
}

export interface SkillRevisionEvaluator {
  evaluate(input: {
    readonly jobId: string;
    readonly package: SkillPackage;
    readonly request: SkillRevisionRequest | SkillRevisionRequestV3;
  }): Promise<SkillEvaluationSnapshot>;
}

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
  submit(request: SkillRevisionRequest): Promise<ManagedSkillRevisionJob>;
  start(
    request: SkillRevisionRequestV3,
    options?: {
      readonly draftId?: string;
      readonly draftName?: string;
      readonly missionId?: string;
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

export function createSkillRevisionService(options: {
  readonly statePath: string;
  readonly draftsPath?: string;
  readonly draftsTrashPath?: string;
  readonly capabilities: CapabilityStore;
  readonly generator?: SkillRevisionGenerator;
  readonly evaluator: SkillRevisionEvaluator;
  readonly warn?: (message: string, error: unknown) => void;
}): SkillRevisionService {
  const jobsPath = join(options.statePath, "jobs");
  const draftsPath = options.draftsPath ?? join(options.statePath, "drafts");
  const draftsTrashPath = options.draftsTrashPath ?? join(options.statePath, "trash", "drafts");
  const discardJournalsPath = join(options.statePath, "discard-journals");
  const migrationJournalsPath = join(options.statePath, "migration-journals");
  const migrationBackupsPath = join(options.statePath, "migration-backups");
  const lockPath = join(options.statePath, ".lock");
  const jobPath = (id: string) => join(jobsPath, `${id}.json`);
  const draftRoot = (id: string) => join(draftsPath, id);
  const draftPath = (id: string) => join(draftRoot(id), "draft.json");
  const worktreePath = (id: string) => join(draftRoot(id), "worktree");
  const submissionsPath = (id: string) => join(draftRoot(id), "submissions");
  let processing: Promise<void> | undefined;
  let processingRequested = false;
  let diagnostics: readonly SkillRevisionRecordDiagnostic[] = [];
  let discardRecovery: Promise<void> | undefined;

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
  ): Omit<SkillRevisionMigrationJournal, "sourceHash"> =>
    kind === "job"
      ? {
          schemaVersion: "pragma.skill-revision-migration/v1",
          kind,
          recordId: id,
          sourceVersion: "pragma.skill-revision-job/v2",
          targetVersion: "pragma.skill-revision-job/v3",
          recordPath: jobPath(id),
          backupPath: join(migrationBackupsPath, `${id}.v2.json`),
        }
      : {
          schemaVersion: "pragma.skill-revision-migration/v1",
          kind,
          recordId: id,
          sourceVersion: "pragma.skill-revision-draft/v1",
          targetVersion: "pragma.skill-revision-draft/v2",
          recordPath: draftPath(id),
          backupPath: join(migrationBackupsPath, `draft-${id}.v1.json`),
        };

  const adjacentMigrationJournalPath = (kind: "job" | "draft", id: string): string =>
    join(
      migrationJournalsPath,
      kind === "job" ? `job-${id}.v2-to-v3.json` : `draft-${id}.v1-to-v2.json`,
    );

  const readAdjacentMigrationJournal = async (
    kind: "job" | "draft",
    id: string,
  ): Promise<SkillRevisionMigrationJournal | undefined> => {
    const path = adjacentMigrationJournalPath(kind, id);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const journal = SkillRevisionMigrationJournalSchema.parse(raw);
    const expected = adjacentMigration(kind, id);
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
    if (journal.kind === "job") SkillRevisionJobV2StoredSchema.parse(source);
    else SkillRevisionDraftV1Schema.parse(source);
    if (jsonHash(source) !== journal.sourceHash) {
      throw coded("skill_revision_migration_backup_mismatch");
    }
  };

  const finishAdjacentMigration = async (kind: "job" | "draft", id: string): Promise<void> => {
    const journal = await readAdjacentMigrationJournal(kind, id);
    if (journal === undefined) return;
    await assertAdjacentMigrationBackup(journal);
    await rm(adjacentMigrationJournalPath(kind, id), { force: true });
  };

  const persistAdjacentMigration = async <T>(input: {
    readonly kind: "job" | "draft";
    readonly id: string;
    readonly source: unknown;
    readonly migrated: T;
    readonly write: (value: T) => Promise<void>;
  }): Promise<T> => {
    const details = adjacentMigration(input.kind, input.id);
    const journal = SkillRevisionMigrationJournalSchema.parse({
      ...details,
      sourceHash: jsonHash(input.source),
    });
    const existing = await readAdjacentMigrationJournal(input.kind, input.id);
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
      await writeJsonAtomic(adjacentMigrationJournalPath(input.kind, input.id), journal);
    } else if (existing.sourceHash !== journal.sourceHash) {
      throw coded("skill_revision_migration_journal_invalid");
    }
    await assertAdjacentMigrationBackup(journal);
    await input.write(input.migrated);
    await rm(adjacentMigrationJournalPath(input.kind, input.id), { force: true });
    return input.migrated;
  };

  const readDraft = async (id: string): Promise<SkillRevisionDraft> => {
    const raw = JSON.parse(await readFile(draftPath(id), "utf8")) as unknown;
    const current = SkillRevisionDraftSchema.safeParse(raw);
    if (current.success) {
      await finishAdjacentMigration("draft", id);
      return current.data;
    }
    return await withFileLock(`${draftRoot(id)}.migration.lock`, async () => {
      const latestRaw = JSON.parse(await readFile(draftPath(id), "utf8")) as unknown;
      const latest = SkillRevisionDraftSchema.safeParse(latestRaw);
      if (latest.success) {
        await finishAdjacentMigration("draft", id);
        return latest.data;
      }
      const legacy = SkillRevisionDraftV1Schema.parse(latestRaw);
      const migrated = migrateSkillRevisionDraftV1ToV2(legacy);
      return await persistAdjacentMigration({
        kind: "draft",
        id,
        source: legacy,
        migrated,
        write: writeDraft,
      });
    });
  };

  const createDraft = async (input: {
    readonly request: SkillRevisionRequestV3;
    readonly name?: string;
  }): Promise<SkillRevisionDraft> => {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    try {
      let baseRevision = 0;
      let baseContentHash: string;
      let name: string;
      if (input.request.operation === "create") {
        await mkdir(worktreePath(id), { recursive: true, mode: 0o700 });
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
        await copySkillTree(source, worktreePath(id));
        await scanSkillWorkingTree(worktreePath(id));
        baseRevision = capability.manifest.latestRevision;
        baseContentHash = capability.definition.contentHash;
        name = capability.definition.name;
      }
      const draft = SkillRevisionDraftSchema.parse({
        schemaVersion: "pragma.skill-revision-draft/v2",
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
        state: "editing",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await writeDraft(draft);
      return draft;
    } catch (error) {
      await rm(draftRoot(id), { recursive: true, force: true });
      throw error;
    }
  };

  const migrateLegacyJob = async (legacy: SkillRevisionJob): Promise<ManagedSkillRevisionJob> => {
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
        worktreePath(migration.draftId),
      );
      if (legacy.changeSet !== undefined) {
        await applyLegacyChangeSetToTree(worktreePath(migration.draftId), legacy.changeSet);
      }
      draft = SkillRevisionDraftSchema.parse({
        schemaVersion: "pragma.skill-revision-draft/v2",
        operation: "revise",
        id: migration.draftId,
        revision: 1,
        capabilityId: legacy.request.capabilityId,
        name: legacy.changeSet?.name ?? capability.definition.name,
        baseRevision: legacy.changeSet?.baseRevision ?? capability.manifest.latestRevision,
        baseContentHash: legacy.changeSet?.baseContentHash ?? capability.definition.contentHash,
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
        const snapshot = await scanSkillWorkingTree(worktreePath(draft.id));
        const submission = await createStableSkillSubmission({
          worktreePath: worktreePath(draft.id),
          submissionsPath: submissionsPath(draft.id),
          expectedHash: snapshot.hash,
        });
        draft = SkillRevisionDraftSchema.parse({
          ...draft,
          submissionHash: submission.snapshot.hash,
          submittedRevision: draft.revision,
        });
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
    const migrated = migrateSkillRevisionJobV2ToV3(migratedV2);
    await persistAdjacentMigration({
      kind: "job",
      id: legacy.id,
      source: migratedV2,
      migrated,
      write: writeJob,
    });
    await rm(migrationPath, { force: true });
    return migrated;
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
          const migrated = migrateSkillRevisionJobV2ToV3(legacyV2.data);
          return await persistAdjacentMigration({
            kind: "job",
            id,
            source: legacyV2.data,
            migrated,
            write: writeJob,
          });
        }
        return await migrateLegacyJob(SkillRevisionJobSchema.parse(latestRaw));
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw coded("skill_revision_job_not_found");
      }
      throw error;
    }
  };

  const readAllJobs = async (): Promise<readonly ManagedSkillRevisionJob[]> => {
    await recoverDiscardJournals();
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
    await recoverDiscardJournals();
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

  const rejectForChangedBase = async (
    job: ManagedSkillRevisionJob,
    draft: SkillRevisionDraft,
  ): Promise<ManagedSkillRevisionJob> => {
    const error = {
      code: "skill_revision_base_changed",
      message: "The formal Skill changed after this draft was created.",
    };
    await mutateDraft(draft.id, draft.revision, () => ({
      state: "rejected",
      activeMissionId: undefined,
      error,
    }));
    return await mutateJob(job.id, job.revision, () => ({
      state: "rejected",
      error,
    }));
  };

  const processEvaluation = async (job: ManagedSkillRevisionJob): Promise<void> => {
    const draft = await readDraft(job.draftId);
    if (job.state !== "evaluating" || draft.submissionHash === undefined) return;
    try {
      const skillPackage = await readEvaluationPackage(
        options.capabilities,
        draft.capabilityId,
        join(submissionsPath(draft.id), draft.submissionHash),
        draft.operation === "create"
          ? { name: draft.name, description: draft.resourceDescription! }
          : undefined,
      );
      const evaluationResult = await options.evaluator.evaluate({
        jobId: job.id,
        package: skillPackage,
        request: job.request,
      });
      const evaluation: SkillEvaluationSnapshot = {
        ...evaluationResult,
        subjectHash: draft.submissionHash,
      };
      const state = evaluation.passed ? "pending_review" : "needs_attention";
      const failure = evaluation.passed
        ? undefined
        : {
            code: "skill_evaluation_failed",
            message: "The Skill candidate did not pass evaluation.",
          };
      await mutateDraft(draft.id, draft.revision, () => ({ state, error: failure }));
      const evaluated = await mutateJob(job.id, job.revision, () => ({
        state,
        evaluation,
        error: failure,
      }));
      if (
        state === "pending_review" &&
        evaluated.request.source === "memory-learning" &&
        evaluated.request.operation === "revise"
      ) {
        await service.approve(evaluated.id, evaluated.revision);
      }
    } catch (error) {
      const currentJob = await readJob(job.id);
      const currentDraft = await readDraft(job.draftId);
      if (currentJob.state !== "evaluating") return;
      const failure = { code: errorCode(error), message: errorMessage(error) };
      await mutateDraft(currentDraft.id, currentDraft.revision, () => ({
        state: "needs_attention",
        error: failure,
      }));
      await mutateJob(currentJob.id, currentJob.revision, () => ({
        state: "needs_attention",
        error: failure,
      }));
    }
  };

  const completePublication = async (
    job: ManagedSkillRevisionJob,
    draft: SkillRevisionDraft,
  ): Promise<ManagedSkillRevisionJob> => {
    if (
      draft.submissionHash === undefined ||
      job.evaluation?.passed !== true ||
      job.evaluation.subjectHash !== draft.submissionHash
    ) {
      throw coded("skill_revision_approval_invalid");
    }
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
      const failure = { code: errorCode(error), message: errorMessage(error) };
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

  const service: SkillRevisionService = {
    async submit(rawRequest) {
      const legacy = SkillRevisionRequestSchema.parse(rawRequest);
      const request = SkillRevisionRequestV3Schema.parse({
        schemaVersion: "pragma.skill-revision-request/v3",
        operation: "revise",
        capabilityId: legacy.capabilityId,
        prompt: legacy.prompt,
        source: legacy.source,
        sourceDigest:
          legacy.sourceDigest ?? createHash("sha256").update(JSON.stringify(legacy)).digest("hex"),
        sourceRefs: legacy.sourceRefs,
        replayCases: legacy.replayCases,
        boundaryCase: legacy.boundaryCase,
      });
      const job = await service.start(request);
      if (options.generator === undefined) return job;
      const draft = await readDraft(job.draftId);
      try {
        const base = await readEvaluationPackage(
          options.capabilities,
          draft.capabilityId,
          worktreePath(draft.id),
        );
        const changeSet = await options.generator.generate({
          jobId: job.id,
          request: legacy,
          current: base,
          revision: draft.baseRevision,
          contentHash: draft.baseContentHash,
        });
        applySkillChangeSet(base, changeSet);
        await applyLegacyChangeSetToTree(worktreePath(draft.id), changeSet);
        const inspection = await service.inspectDraft(draft.id);
        return await service.submitDraft({
          draftId: draft.id,
          expectedRevision: inspection.draft.revision,
          expectedWorkingTreeHash: inspection.workingTree.hash,
          summary: changeSet.summary,
        });
      } catch (error) {
        const currentJob = await readJob(job.id);
        const currentDraft = await readDraft(job.draftId);
        const failure = { code: errorCode(error), message: errorMessage(error) };
        await mutateDraft(currentDraft.id, currentDraft.revision, () => ({
          state: "needs_attention",
          error: failure,
        }));
        return await mutateJob(currentJob.id, currentJob.revision, () => ({
          state: "needs_attention",
          error: failure,
        }));
      }
    },
    async start(rawRequest, startOptions = {}) {
      const request = SkillRevisionRequestV3Schema.parse(rawRequest);
      return await withFileLock(lockPath, async () => {
        const existing = (await readAllJobs()).find(
          (job) =>
            job.request.capabilityId === request.capabilityId &&
            job.request.sourceDigest === request.sourceDigest,
        );
        if (existing !== undefined && startOptions.draftId === undefined) return existing;
        let draft: SkillRevisionDraft;
        if (startOptions.draftId === undefined) {
          draft = await createDraft({
            request,
            ...(startOptions.draftName === undefined ? {} : { name: startOptions.draftName }),
          });
        } else {
          draft = await readDraft(startOptions.draftId);
          if (
            draft.capabilityId !== request.capabilityId ||
            draft.operation !== request.operation
          ) {
            throw coded("skill_revision_target_unavailable");
          }
          if (!["editing", "needs_attention"].includes(draft.state)) {
            throw coded("skill_revision_state_invalid");
          }
          requireOwner(draft, startOptions.missionId);
          if (draft.state === "needs_attention" && draft.submissionHash !== undefined) {
            const replacement = `${worktreePath(draft.id)}.${randomUUID()}.tmp`;
            await copySkillTree(join(submissionsPath(draft.id), draft.submissionHash), replacement);
            await rm(worktreePath(draft.id), { recursive: true, force: true });
            await rename(replacement, worktreePath(draft.id));
          }
          draft = await mutateDraft(draft.id, draft.revision, () => ({
            state: "editing",
            activeMissionId: startOptions.missionId,
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
            evaluation: undefined,
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
          schemaVersion: "pragma.skill-revision-job/v3",
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
    get: readJob,
    getDraft: readDraft,
    async inspectDraft(id, missionId) {
      const draft = await readDraft(id);
      const workingTree = await scanSkillWorkingTree(worktreePath(id), {
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
          ? { draftPath: worktreePath(id) }
          : { referencePath: worktreePath(id) }),
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
      const job = await readJob(jobId);
      const draft = await readDraft(job.draftId);
      if (draft.activeMissionId !== undefined && draft.activeMissionId !== missionId) {
        throw coded("skill_revision_owned_by_another_context");
      }
      await mutateDraft(draft.id, draft.revision, () => ({ activeMissionId: missionId }));
      return await mutateJob(job.id, job.revision, () => ({ missionId, state: "running" }));
    },
    async detachMission(jobId, missionId) {
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
          return await rejectForChangedBase(job, draft);
        }
      }
      const candidate = await readEvaluationPackage(
        options.capabilities,
        draft.capabilityId,
        worktreePath(draft.id),
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
      const submission = await createStableSkillSubmission({
        worktreePath: worktreePath(draft.id),
        submissionsPath: submissionsPath(draft.id),
        expectedHash: input.expectedWorkingTreeHash,
      });
      await mutateDraft(draft.id, draft.revision, () => ({
        state: "evaluating",
        activeMissionId: undefined,
        submissionHash: submission.snapshot.hash,
        submittedRevision: draft.revision + 1,
        summary: input.summary,
        error: undefined,
      }));
      const nextJob = await mutateJob(job.id, job.revision, () => ({
        state: "evaluating",
        error: undefined,
      }));
      service.scheduleProcessing();
      return nextJob;
    },
    async approve(id, expectedRevision) {
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
          return await rejectForChangedBase(job, draft);
        }
      }
      if (
        draft.submissionHash === undefined ||
        job.evaluation?.passed !== true ||
        job.evaluation.subjectHash !== draft.submissionHash
      ) {
        throw coded("skill_revision_approval_invalid");
      }
      const publishingDraft = await mutateDraft(draft.id, draft.revision, () => ({
        state: "publishing",
      }));
      const publishingJob = await mutateJob(job.id, job.revision, () => ({ state: "publishing" }));
      return await completePublication(publishingJob, publishingDraft);
    },
    async reject(id, revision) {
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
      const job = await readJob(id);
      if (job.revision !== revision || job.state !== "needs_attention") {
        throw coded("skill_revision_conflict");
      }
      const draft = await readDraft(job.draftId);
      await mutateDraft(draft.id, draft.revision, () => ({
        state: "evaluating",
        error: undefined,
      }));
      const next = await mutateJob(job.id, job.revision, () => ({
        state: "evaluating",
        error: undefined,
      }));
      service.scheduleProcessing();
      return next;
    },
    async discardDraft(input) {
      await withFileLock(`${draftRoot(input.draftId)}.discard.lock`, async () => {
        const draft = await readDraft(input.draftId);
        if (draft.revision !== input.expectedRevision) throw coded("skill_revision_conflict");
        if (draft.state === "completed") throw coded("skill_revision_state_invalid");
        requireOwner(draft, input.missionId);
        const snapshot = await scanSkillWorkingTree(worktreePath(draft.id));
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
        await mkdir(discardJournalsPath, { recursive: true, mode: 0o700 });
        await mkdir(draftsTrashPath, { recursive: true, mode: 0o700 });
        const discardedAt = new Date().toISOString();
        const trashPath = join(draftsTrashPath, `${draft.id}-${discardedAt.replaceAll(":", "-")}`);
        const journalPath = join(discardJournalsPath, `${draft.id}.json`);
        const journal = {
          schemaVersion: "pragma.skill-revision-draft-discard/v1",
          draftId: draft.id,
          sourcePath: draftRoot(draft.id),
          trashPath,
          workingTreeHash: snapshot.hash,
          discardedAt,
        };
        await writeJsonAtomic(journalPath, { ...journal, state: "prepared" });
        await rename(draftRoot(draft.id), trashPath);
        await writeJsonAtomic(journalPath, { ...journal, state: "completed" });
      });
    },
    async delete(id, revision) {
      await withFileLock(lockPath, async () => {
        const job = await readJob(id);
        if (job.revision !== revision) throw coded("skill_revision_conflict");
        if (!["completed", "rejected", "needs_attention", "superseded"].includes(job.state)) {
          throw coded("skill_revision_state_invalid");
        }
        await rm(jobPath(id), { force: true });
      });
    },
    async processPending() {
      processingRequested = true;
      if (processing !== undefined) return await processing;
      processing = (async () => {
        do {
          processingRequested = false;
          const jobs = await readAllJobs();
          const next = jobs
            .filter((job) => job.state === "evaluating")
            .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
          if (next !== undefined) {
            await processEvaluation(next);
            processingRequested = true;
            continue;
          }
          const interrupted = await nextInterruptedPublication(jobs);
          if (interrupted !== undefined) {
            await completePublication(interrupted.job, interrupted.draft);
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

async function readEvaluationPackage(
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
