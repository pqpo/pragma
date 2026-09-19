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
  SkillRevisionRequestV2Schema,
  type SkillEvaluationSnapshot,
  type SkillRevisionDraft,
  type ManagedSkillRevisionJob,
  type SkillRevisionJob,
  type SkillRevisionRequest,
  type SkillRevisionRequestV2,
} from "@pragma/built-in-agents/contracts";
import { SkillPackageSchema, type SkillPackage } from "@pragma/shared";
import { z } from "zod";

import type { CapabilityStore } from "./capability-store.ts";
import {
  SkillWorkingTreeError,
  copySkillTree,
  createStableSkillSubmission,
  scanSkillWorkingTree,
  type SkillWorkingTreeSnapshot,
} from "./skill-revision-draft-store.ts";

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
    readonly request: SkillRevisionRequest | SkillRevisionRequestV2;
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
    request: SkillRevisionRequestV2,
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

  const readDraft = async (id: string): Promise<SkillRevisionDraft> =>
    SkillRevisionDraftSchema.parse(JSON.parse(await readFile(draftPath(id), "utf8")));

  const createDraft = async (input: {
    readonly request: SkillRevisionRequestV2;
    readonly name?: string;
  }): Promise<SkillRevisionDraft> => {
    const capability = await options.capabilities.get(input.request.capabilityId);
    if (capability.definition.kind !== "skill") throw coded("skill_revision_target_unavailable");
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const source = await options.capabilities.skillFilesPath(
      input.request.capabilityId,
      capability.manifest.latestRevision,
    );
    try {
      await copySkillTree(source, worktreePath(id));
      await scanSkillWorkingTree(worktreePath(id));
      const draft = SkillRevisionDraftSchema.parse({
        schemaVersion: "pragma.skill-revision-draft/v1",
        id,
        revision: 1,
        capabilityId: input.request.capabilityId,
        name: input.name ?? capability.definition.name,
        baseRevision: capability.manifest.latestRevision,
        baseContentHash: capability.definition.contentHash,
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
        schemaVersion: "pragma.skill-revision-draft/v1",
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
    const request = SkillRevisionRequestV2Schema.parse({
      schemaVersion: "pragma.skill-revision-request/v2",
      capabilityId: legacy.request.capabilityId,
      prompt: legacy.request.prompt,
      source: legacy.request.source,
      sourceDigest:
        legacy.request.sourceDigest ??
        createHash("sha256").update(JSON.stringify(legacy.request)).digest("hex"),
      sourceRefs: legacy.request.sourceRefs,
      replayCases: legacy.request.replayCases,
      boundaryCase: legacy.request.boundaryCase,
    });
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
    const migrated = ManagedSkillRevisionJobSchema.parse({
      schemaVersion: "pragma.skill-revision-job/v2",
      id: legacy.id,
      revision: legacy.revision,
      draftId: draft.id,
      request,
      state,
      evaluation: legacy.evaluation,
      supersededBy: legacy.supersededBy,
      error: draft.error ?? legacy.error,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
    });
    await writeJob(migrated);
    await rm(migrationPath, { force: true });
    return migrated;
  };

  const readJob = async (id: string): Promise<ManagedSkillRevisionJob> => {
    try {
      const raw = JSON.parse(await readFile(jobPath(id), "utf8")) as unknown;
      const current = ManagedSkillRevisionJobSchema.safeParse(raw);
      return current.success
        ? current.data
        : await migrateLegacyJob(SkillRevisionJobSchema.parse(raw));
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
      if (state === "pending_review" && evaluated.request.source === "memory-learning") {
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

  const service: SkillRevisionService = {
    async submit(rawRequest) {
      const legacy = SkillRevisionRequestSchema.parse(rawRequest);
      const request = SkillRevisionRequestV2Schema.parse({
        schemaVersion: "pragma.skill-revision-request/v2",
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
        const next = applySkillChangeSet(base, changeSet);
        await writeGeneratedPackageToTree(next, worktreePath(draft.id));
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
      const request = SkillRevisionRequestV2Schema.parse(rawRequest);
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
          if (draft.capabilityId !== request.capabilityId) {
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
          schemaVersion: "pragma.skill-revision-job/v2",
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
      const [workingTree, current, base] = await Promise.all([
        scanSkillWorkingTree(worktreePath(id)),
        options.capabilities.get(draft.capabilityId),
        scanSkillWorkingTree(
          await options.capabilities.skillFilesPath(draft.capabilityId, draft.baseRevision),
        ),
      ]);
      if (current.definition.kind !== "skill") throw coded("skill_revision_target_unavailable");
      return {
        draft,
        ...(draft.state === "editing" && draft.activeMissionId === missionId
          ? { draftPath: worktreePath(id) }
          : { referencePath: worktreePath(id) }),
        workingTree,
        currentRevision: current.manifest.latestRevision,
        currentContentHash: current.definition.contentHash,
        stale:
          current.manifest.latestRevision !== draft.baseRevision ||
          current.definition.contentHash !== draft.baseContentHash,
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
      const current = await options.capabilities.get(draft.capabilityId);
      if (
        current.definition.kind !== "skill" ||
        current.manifest.latestRevision !== draft.baseRevision ||
        current.definition.contentHash !== draft.baseContentHash
      ) {
        return await rejectForChangedBase(job, draft);
      }
      await readEvaluationPackage(options.capabilities, draft.capabilityId, worktreePath(draft.id));
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
      const current = await options.capabilities.get(draft.capabilityId);
      if (
        current.definition.kind !== "skill" ||
        current.manifest.latestRevision !== draft.baseRevision ||
        current.definition.contentHash !== draft.baseContentHash
      ) {
        return await rejectForChangedBase(job, draft);
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
      try {
        const published = await options.capabilities.publishSkillRevisionCandidate({
          id: draft.capabilityId,
          baseRevision: draft.baseRevision,
          baseContentHash: draft.baseContentHash,
          sourcePath: join(submissionsPath(draft.id), draft.submissionHash),
          candidateContentHash: draft.submissionHash,
        });
        await mutateDraft(publishingDraft.id, publishingDraft.revision, () => ({
          state: "completed",
          error: undefined,
        }));
        return await mutateJob(publishingJob.id, publishingJob.revision, () => ({
          state: "completed",
          publishedRevision: published.manifest.latestRevision,
          error: undefined,
        }));
      } catch (error) {
        const failure = { code: errorCode(error), message: errorMessage(error) };
        await mutateDraft(publishingDraft.id, publishingDraft.revision, () => ({
          state: "needs_attention",
          error: failure,
        }));
        await mutateJob(publishingJob.id, publishingJob.revision, () => ({
          state: "needs_attention",
          error: failure,
        }));
        throw error;
      }
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
          if (!["completed", "rejected"].includes(job.state)) {
            await mutateJob(job.id, job.revision, () => ({
              state: "rejected",
              error: { code: "draft_discarded", message: "The Skill draft was discarded." },
            }));
          }
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
          const next = (await readAllJobs())
            .filter((job) => job.state === "evaluating")
            .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
          if (next !== undefined) await processEvaluation(next);
        } while (
          processingRequested ||
          (await readAllJobs()).some((job) => job.state === "evaluating")
        );
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
): Promise<SkillPackage> {
  const capability = await capabilities.get(capabilityId);
  if (capability.definition.kind !== "skill") throw coded("skill_revision_target_unavailable");
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
    name: metadata.name ?? capability.definition.name,
    description: metadata.description ?? capability.definition.description,
    files,
  });
}

async function writeGeneratedPackageToTree(skill: SkillPackage, root: string): Promise<void> {
  for (const file of skill.files) {
    const path = join(root, ...file.path.split("/"));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, file.content, { mode: 0o600 });
  }
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
