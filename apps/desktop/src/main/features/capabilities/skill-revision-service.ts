import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/core";
import { applySkillChangeSet, transitionSkillRevisionJob } from "@pragma/built-in-agents";
import {
  SkillRevisionChangeSetSchema,
  SkillRevisionJobSchema,
  SkillRevisionRequestSchema,
  type SkillRevisionChangeSet,
  type SkillEvaluationSnapshot,
  type SkillRevisionJob,
  type SkillRevisionRequest,
} from "@pragma/built-in-agents/contracts";
import { SkillPackageSchema, type SkillPackage } from "@pragma/shared";

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
  list(filter?: {
    readonly capabilityId?: string;
    readonly state?: SkillRevisionJob["state"];
  }): Promise<readonly SkillRevisionJob[]>;
  approve(jobId: string, expectedRevision: number): Promise<SkillRevisionJob>;
  reject(jobId: string, expectedRevision: number): Promise<SkillRevisionJob>;
  retry(jobId: string, expectedRevision: number): Promise<SkillRevisionJob>;
  delete(jobId: string, expectedRevision: number): Promise<void>;
  processPending(): Promise<void>;
  scheduleProcessing(): void;
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
    let running = await mutate(pending.id, pending.revision, (job) =>
      job.state === "pending"
        ? transitionSkillRevisionJob(job, { type: "generation_started" })
        : job,
    );
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
      running = await mutate(running.id, running.revision, (job) =>
        transitionSkillRevisionJob(job, { type: "generation_succeeded", changeSet }),
      );
      const evaluation = await options.evaluator.evaluate({
        jobId: running.id,
        package: nextPackage,
        request: running.request,
      });
      const evaluated = await mutate(running.id, running.revision, (job) =>
        transitionSkillRevisionJob(job, { type: "evaluation_succeeded", evaluation }),
      );
      if (evaluated.state === "pending_review" && evaluated.request.source === "memory-learning") {
        await service.approve(evaluated.id, evaluated.revision);
      }
    } catch (error) {
      const current = await readJob(running.id);
      if (!["running", "evaluating"].includes(current.state)) return;
      await mutate(current.id, current.revision, (job) =>
        transitionSkillRevisionJob(job, {
          type: "processing_failed",
          code: errorCode(error),
          message: errorMessage(error),
        }),
      );
    }
  };

  const applyApprovedRevision = async (applying: SkillRevisionJob): Promise<SkillRevisionJob> => {
    const changeSet = applying.changeSet!;
    const current = await readSkillPackage(options.capabilities, applying.request.capabilityId);
    const base = await readSkillPackage(
      options.capabilities,
      applying.request.capabilityId,
      changeSet.baseRevision,
    );
    const nextPackage = applySkillChangeSet(base.package, changeSet);
    if (
      current.revision === changeSet.baseRevision + 1 &&
      sameSkillPackage(current.package, nextPackage)
    ) {
      return await mutate(applying.id, applying.revision, (job) =>
        transitionSkillRevisionJob(job, { type: "apply_succeeded" }),
      );
    }
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
        const superseded = transitionSkillRevisionJob(currentJob, {
          type: "superseded",
          replacementId: replacement.id,
        });
        await writeJob(superseded);
        service.scheduleProcessing();
        return superseded;
      });
    }
    try {
      await options.capabilities.updateGeneratedSkill({
        id: applying.request.capabilityId,
        package: nextPackage,
      });
      return await mutate(applying.id, applying.revision, (job) =>
        transitionSkillRevisionJob(job, { type: "apply_succeeded" }),
      );
    } catch (error) {
      await mutate(applying.id, applying.revision, (job) =>
        transitionSkillRevisionJob(job, {
          type: "apply_failed",
          code: "skill_revision_apply_failed",
          message: errorMessage(error),
        }),
      );
      throw error;
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
      const applying = await mutate(jobId, expectedRevision, (job) =>
        transitionSkillRevisionJob(job, { type: "approved" }),
      );
      return await applyApprovedRevision(applying);
    },
    async reject(id, revision) {
      return await mutate(id, revision, (job) =>
        transitionSkillRevisionJob(job, { type: "rejected" }),
      );
    },
    async retry(id, revision) {
      const next = await mutate(id, revision, (job) =>
        transitionSkillRevisionJob(job, { type: "retried" }),
      );
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
              .filter(
                (job) =>
                  job.state === "pending" ||
                  job.state === "applying" ||
                  (job.state === "pending_review" && job.request.source === "memory-learning"),
              )
              .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
            if (next === undefined) break;
            if (next.state === "pending") await processJob(next);
            else if (next.state === "pending_review") await service.approve(next.id, next.revision);
            else await applyApprovedRevision(next);
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

async function readSkillPackage(
  capabilities: CapabilityStore,
  id: string,
  requestedRevision?: number,
): Promise<{
  readonly package: SkillPackage;
  readonly revision: number;
  readonly contentHash: string;
}> {
  const capability = await capabilities.get(id, requestedRevision);
  if (capability.definition.kind !== "skill") throw new Error("skill_revision_target_invalid");
  const revision = requestedRevision ?? capability.manifest.latestRevision;
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

function sameSkillPackage(left: SkillPackage, right: SkillPackage): boolean {
  const canonicalize = (skill: SkillPackage) => ({
    name: skill.name,
    description: skill.description,
    files: skill.files.toSorted((a, b) => a.path.localeCompare(b.path)),
  });
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
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
