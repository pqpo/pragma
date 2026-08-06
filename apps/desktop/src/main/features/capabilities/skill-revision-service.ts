import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/context-filesystem";
import { SkillPackageSchema, type SkillPackage } from "@pragma/shared";

import {
  SkillRevisionChangeSetSchema,
  SkillRevisionJobSchema,
  SkillRevisionRequestSchema,
  type ListSkillRevisionJobs,
  type SkillEvaluationSnapshot,
  type SkillRevisionChangeSet,
  type SkillRevisionJob,
  type SkillRevisionRequest,
} from "../../../shared/contracts/index.ts";
import type { CapabilityStore } from "./capability-store.ts";

export interface SkillRevisionGenerator {
  generate(input: {
    readonly jobId: string;
    readonly request: SkillRevisionRequest;
    readonly current: SkillPackage;
    readonly revision: number;
    readonly contentHash: string;
  }): Promise<SkillRevisionChangeSet>;
}
export interface SkillRevisionEvaluator {
  evaluate(input: {
    readonly jobId: string;
    readonly package: SkillPackage;
    readonly request: SkillRevisionRequest;
  }): Promise<SkillEvaluationSnapshot>;
}

export interface SkillRevisionService {
  submit(request: SkillRevisionRequest): Promise<SkillRevisionJob>;
  list(filter?: ListSkillRevisionJobs): Promise<readonly SkillRevisionJob[]>;
  approve(jobId: string, expectedRevision: number): Promise<SkillRevisionJob>;
  reject(jobId: string, expectedRevision: number): Promise<SkillRevisionJob>;
  retry(jobId: string, expectedRevision: number): Promise<SkillRevisionJob>;
  delete(jobId: string, expectedRevision: number): Promise<void>;
  processPending(): Promise<void>;
  scheduleProcessing(): void;
  hasActiveJobs(capabilityId: string): Promise<boolean>;
}

export function createSkillRevisionService(options: {
  readonly statePath: string;
  readonly capabilities: CapabilityStore;
  readonly generator: SkillRevisionGenerator;
  readonly evaluator: SkillRevisionEvaluator;
  readonly warn?: (message: string, error: unknown) => void;
}): SkillRevisionService {
  const jobsPath = join(options.statePath, "jobs");
  const lockPath = join(options.statePath, ".lock");
  const jobPath = (id: string) => join(jobsPath, `${id}.json`);
  let processing: Promise<void> | undefined;
  let processingRequested = false;
  const readJob = async (id: string) => {
    try {
      return SkillRevisionJobSchema.parse(JSON.parse(await readFile(jobPath(id), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw Object.assign(new Error("skill_revision_job_not_found"), { code: "job_not_found" });
      throw error;
    }
  };
  const writeJob = async (job: SkillRevisionJob) => await writeJsonAtomic(jobPath(job.id), job);
  const createJob = (request: SkillRevisionRequest): SkillRevisionJob => {
    const timestamp = new Date().toISOString();
    return SkillRevisionJobSchema.parse({
      schemaVersion: "pragma.skill-revision-job/v1",
      id: randomUUID(),
      revision: 1,
      request,
      state: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  };
  const readAll = async () => {
    let names: string[];
    try {
      names = await readdir(jobsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => readJob(name.slice(0, -5))),
    );
  };
  const mutate = async (
    id: string,
    expected: number,
    fn: (job: SkillRevisionJob) => SkillRevisionJob,
  ) =>
    await withFileLock(lockPath, async () => {
      const current = await readJob(id);
      if (current.revision !== expected)
        throw Object.assign(new Error("skill_revision_conflict"), { code: "revision_conflict" });
      const next = SkillRevisionJobSchema.parse(fn(current));
      await writeJob(next);
      return next;
    });

  const processJob = async (pending: SkillRevisionJob): Promise<void> => {
    let running = await mutate(pending.id, pending.revision, (job) => {
      if (job.state !== "pending") return job;
      return {
        ...job,
        revision: job.revision + 1,
        state: "running",
        updatedAt: new Date().toISOString(),
      };
    });
    if (running.state !== "running") return;
    try {
      const base = await readSkillPackage(options.capabilities, running.request.capabilityId);
      const changeSet = SkillRevisionChangeSetSchema.parse(
        await options.generator.generate({
          jobId: running.id,
          request: running.request,
          current: base.package,
          revision: base.revision,
          contentHash: base.contentHash,
        }),
      );
      if (
        changeSet.capabilityId !== running.request.capabilityId ||
        changeSet.baseRevision !== base.revision ||
        changeSet.baseContentHash !== base.contentHash
      )
        throw new Error("skill_revision_base_mismatch");
      const nextPackage = applySkillChangeSet(base.package, changeSet);
      running = await mutate(running.id, running.revision, (job) => ({
        ...job,
        revision: job.revision + 1,
        state: "evaluating",
        changeSet,
        updatedAt: new Date().toISOString(),
      }));
      const evaluation = await options.evaluator.evaluate({
        jobId: running.id,
        package: nextPackage,
        request: running.request,
      });
      await mutate(running.id, running.revision, (job) => ({
        ...job,
        revision: job.revision + 1,
        state: evaluation.passed ? "pending_review" : "needs_attention",
        evaluation,
        ...(evaluation.passed
          ? { error: undefined }
          : {
              error: {
                code: "skill_evaluation_failed",
                message: "The proposed Skill revision did not pass evaluation.",
              },
            }),
        updatedAt: new Date().toISOString(),
      }));
    } catch (error) {
      const current = await readJob(running.id);
      if (!["running", "evaluating"].includes(current.state)) return;
      await mutate(current.id, current.revision, (job) => ({
        ...job,
        revision: job.revision + 1,
        state: "needs_attention",
        error: { code: errorCode(error), message: errorMessage(error) },
        updatedAt: new Date().toISOString(),
      }));
    }
  };

  const service: SkillRevisionService = {
    async submit(rawRequest) {
      const request = SkillRevisionRequestSchema.parse(rawRequest);
      await options.capabilities.get(request.capabilityId);
      return await withFileLock(lockPath, async () => {
        if (request.source === "memory-learning") {
          const existing = (await readAll()).find(
            (job) =>
              job.request.capabilityId === request.capabilityId &&
              job.request.source === "memory-learning" &&
              job.request.sourceDigest === request.sourceDigest,
          );
          if (existing !== undefined) return existing;
        }
        const job = createJob(request);
        await writeJob(job);
        return job;
      });
    },
    async list(filter = {}) {
      return (await readAll())
        .filter(
          (job) =>
            (filter.capabilityId === undefined ||
              job.request.capabilityId === filter.capabilityId) &&
            (filter.state === undefined || job.state === filter.state),
        )
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async approve(jobId, expectedRevision) {
      const applying = await mutate(jobId, expectedRevision, (job) => {
        if (
          job.state !== "pending_review" ||
          job.changeSet === undefined ||
          job.evaluation?.passed !== true
        )
          throw new Error("skill_revision_state_invalid");
        return {
          ...job,
          revision: job.revision + 1,
          state: "applying",
          updatedAt: new Date().toISOString(),
        };
      });
      const changeSet = applying.changeSet!;
      const current = await readSkillPackage(options.capabilities, applying.request.capabilityId);
      if (
        current.revision !== changeSet.baseRevision ||
        current.contentHash !== changeSet.baseContentHash
      ) {
        return await withFileLock(lockPath, async () => {
          const currentJob = await readJob(applying.id);
          if (currentJob.revision !== applying.revision || currentJob.state !== "applying") {
            throw Object.assign(new Error("skill_revision_conflict"), {
              code: "revision_conflict",
            });
          }
          const replacement = createJob(applying.request);
          await writeJob(replacement);
          const superseded = SkillRevisionJobSchema.parse({
            ...currentJob,
            revision: currentJob.revision + 1,
            state: "superseded",
            supersededBy: replacement.id,
            updatedAt: new Date().toISOString(),
          });
          await writeJob(superseded);
          service.scheduleProcessing();
          return superseded;
        });
      }
      try {
        await options.capabilities.updateGeneratedSkill({
          id: applying.request.capabilityId,
          package: applySkillChangeSet(current.package, changeSet),
        });
        return await mutate(applying.id, applying.revision, (job) => ({
          ...job,
          revision: job.revision + 1,
          state: "completed",
          updatedAt: new Date().toISOString(),
        }));
      } catch (error) {
        await mutate(applying.id, applying.revision, (job) => ({
          ...job,
          revision: job.revision + 1,
          state: "needs_attention",
          error: { code: "skill_revision_apply_failed", message: errorMessage(error) },
          updatedAt: new Date().toISOString(),
        }));
        throw error;
      }
    },
    async reject(id, revision) {
      return await mutate(id, revision, (job) => {
        if (job.state !== "pending_review") throw new Error("skill_revision_state_invalid");
        return {
          ...job,
          revision: job.revision + 1,
          state: "rejected",
          updatedAt: new Date().toISOString(),
        };
      });
    },
    async retry(id, revision) {
      const next = await mutate(id, revision, (job) => {
        if (job.state !== "needs_attention") throw new Error("skill_revision_state_invalid");
        return {
          ...job,
          revision: job.revision + 1,
          state: "pending",
          changeSet: undefined,
          evaluation: undefined,
          error: undefined,
          updatedAt: new Date().toISOString(),
        };
      });
      service.scheduleProcessing();
      return next;
    },
    async delete(id, revision) {
      await withFileLock(lockPath, async () => {
        const job = await readJob(id);
        if (job.revision !== revision) throw new Error("skill_revision_conflict");
        if (["running", "evaluating", "applying"].includes(job.state))
          throw new Error("skill_revision_state_invalid");
        await rm(jobPath(id), { force: true });
      });
    },
    async processPending() {
      processingRequested = true;
      if (processing !== undefined) return await processing;
      processing = (async () => {
        do {
          processingRequested = false;
          for (;;) {
            const next = (await readAll())
              .filter((job) => job.state === "pending")
              .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
            if (next === undefined) break;
            await processJob(next);
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
    async hasActiveJobs(capabilityId) {
      return (await readAll()).some(
        (job) =>
          job.request.capabilityId === capabilityId &&
          [
            "pending",
            "running",
            "evaluating",
            "pending_review",
            "applying",
            "needs_attention",
          ].includes(job.state),
      );
    },
  };
  return service;
}

export function applySkillChangeSet(
  base: SkillPackage,
  rawChangeSet: SkillRevisionChangeSet,
): SkillPackage {
  const changeSet = SkillRevisionChangeSetSchema.parse(rawChangeSet);
  const files = new Map(base.files.map((file) => [file.path, file.content]));
  for (const operation of changeSet.operations) {
    if (operation.operation === "delete") files.delete(operation.path);
    else if (operation.operation === "rename") {
      const content = files.get(operation.path);
      if (content === undefined || files.has(operation.nextPath))
        throw new Error("skill_revision_rename_invalid");
      files.delete(operation.path);
      files.set(operation.nextPath, content);
    } else files.set(operation.path, operation.content);
  }
  return SkillPackageSchema.parse({
    name: changeSet.name,
    description: changeSet.description,
    files: [...files]
      .map(([path, content]) => ({ path, content }))
      .toSorted((a, b) => a.path.localeCompare(b.path)),
  });
}

async function readSkillPackage(
  capabilities: CapabilityStore,
  id: string,
): Promise<{
  readonly package: SkillPackage;
  readonly revision: number;
  readonly contentHash: string;
}> {
  const capability = await capabilities.get(id);
  if (capability.definition.kind !== "skill") throw new Error("skill_revision_target_invalid");
  const revision = capability.manifest.latestRevision;
  const entries = await capabilities.listSkillFiles({ id, revision });
  const files = [];
  for (const entry of entries) {
    const content = await capabilities.getSkillFile({ id, revision, path: entry.path });
    if (content.content === null) throw new Error("skill_revision_binary_file_unsupported");
    files.push({ path: entry.path, content: content.content });
  }
  return {
    package: SkillPackageSchema.parse({
      name: capability.definition.name,
      description: capability.definition.description,
      files,
    }),
    revision,
    contentHash: capability.definition.contentHash,
  };
}
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "skill_revision_failed";
  return /^[a-z0-9_:-]+$/iu.test(message) ? message.slice(0, 100) : "skill_revision_failed";
}
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Skill revision failed.").slice(0, 2_000);
}
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(SkillRevisionJobSchema.parse(value), null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
