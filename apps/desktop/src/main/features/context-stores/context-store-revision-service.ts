import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/context-filesystem";

import {
  ContextStoreChangeSetSchema,
  ContextStoreRevisionJobSchema,
  ContextStoreRevisionProfileSchema,
  ContextStoreRevisionRequestSchema,
  ProgressiveKnowledgeStoreFilesSchema,
  UpdateContextStoreRevisionProfileSchema,
  type ContextStoreChangeSet,
  type ContextStoreRevisionJob,
  type ContextStoreRevisionProfile,
  type ContextStoreRevisionRequest,
  type ContextStoreSnapshot,
  type ListContextStoreRevisionJobs,
  type UpdateContextStoreRevisionProfile,
} from "../../../shared/contracts/index.ts";
import { ContextStoreStoreError, type ContextStoreStore } from "./context-store-store.ts";

export const STORE_REVISION_EXPERT_ID = "0000000000st0rev";
export const STORE_REVISION_EXPERT_REF = `expert:${STORE_REVISION_EXPERT_ID}` as const;

export interface ContextStoreRevisionGenerator {
  generate(input: {
    readonly jobId: string;
    readonly request: ContextStoreRevisionRequest;
    readonly profile: ContextStoreRevisionProfile;
    readonly snapshot: Awaited<ReturnType<ContextStoreStore["getSnapshot"]>>;
  }): Promise<ContextStoreChangeSet>;
}

export interface ContextStoreRevisionService {
  submit(request: ContextStoreRevisionRequest): Promise<ContextStoreRevisionJob>;
  list(filter?: ListContextStoreRevisionJobs): Promise<readonly ContextStoreRevisionJob[]>;
  get(jobId: string): Promise<ContextStoreRevisionJob>;
  approve(jobId: string, expectedRevision: number): Promise<ContextStoreRevisionJob>;
  reject(jobId: string, expectedRevision: number): Promise<ContextStoreRevisionJob>;
  retry(jobId: string, expectedRevision: number): Promise<ContextStoreRevisionJob>;
  delete(jobId: string, expectedRevision: number): Promise<void>;
  processPending(): Promise<void>;
  scheduleProcessing(): void;
  hasActiveJobs(storeId: string): Promise<boolean>;
  getProfile(): Promise<ContextStoreRevisionProfile>;
  updateProfile(input: UpdateContextStoreRevisionProfile): Promise<ContextStoreRevisionProfile>;
}

export class ContextStoreRevisionServiceError extends Error {
  constructor(
    readonly code: "job_not_found" | "revision_conflict" | "invalid_state" | "profile_conflict",
    message: string,
  ) {
    super(message);
    this.name = "ContextStoreRevisionServiceError";
  }
}

function assertProgressiveStructurePreserved(
  base: ContextStoreSnapshot,
  changeSet: ContextStoreChangeSet,
): void {
  const baseIds = new Set(base.files.map((file) => file.id));
  if (
    !baseIds.has("guide.md") ||
    !baseIds.has("overview.md") ||
    !baseIds.has("index.md") ||
    !base.files.some((file) => file.id.startsWith("items/"))
  ) {
    return;
  }
  const projected = new Map(base.files.map((file) => [file.id, file]));
  for (const operation of changeSet.operations) {
    if (operation.operation === "delete") {
      projected.delete(operation.id);
    } else if (operation.operation === "rename") {
      const current = projected.get(operation.id);
      if (current !== undefined) {
        projected.delete(operation.id);
        projected.set(operation.nextId, { ...current, id: operation.nextId });
      }
    } else {
      projected.set(operation.id, {
        id: operation.id,
        content: operation.content,
        metadata: operation.metadata,
      });
    }
  }
  ProgressiveKnowledgeStoreFilesSchema.parse([...projected.values()]);
}

function attachBaseContent(
  base: ContextStoreSnapshot,
  changeSet: ContextStoreChangeSet,
): ContextStoreChangeSet {
  const files = new Map(base.files.map((file) => [file.id, file]));
  return ContextStoreChangeSetSchema.parse({
    ...changeSet,
    operations: changeSet.operations.map((operation) => {
      if (operation.operation === "rename") return operation;
      const previous = files.get(operation.id);
      return { ...operation, previousContent: previous?.content };
    }),
  });
}

export function createContextStoreRevisionService(options: {
  readonly statePath: string;
  readonly contextStores: ContextStoreStore;
  readonly generator: ContextStoreRevisionGenerator;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}): ContextStoreRevisionService {
  const jobsPath = join(options.statePath, "jobs");
  const profilePath = join(options.statePath, "profile.json");
  const lockPath = join(options.statePath, ".jobs.lock");
  const jobPath = (id: string) => join(jobsPath, `${id}.json`);
  let processing: Promise<void> | undefined;

  const readJob = async (id: string): Promise<ContextStoreRevisionJob> => {
    try {
      return ContextStoreRevisionJobSchema.parse(JSON.parse(await readFile(jobPath(id), "utf8")));
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
    mutate: (job: ContextStoreRevisionJob) => ContextStoreRevisionJob,
  ): Promise<ContextStoreRevisionJob> =>
    await withFileLock(lockPath, async () => {
      const current = await readJob(id);
      if (current.revision !== expectedRevision) {
        throw new ContextStoreRevisionServiceError(
          "revision_conflict",
          "The revision task changed. Refresh and try again.",
        );
      }
      const next = ContextStoreRevisionJobSchema.parse(mutate(current));
      await writeJob(next);
      return next;
    });

  const createJob = (
    request: ContextStoreRevisionRequest,
    timestamp = new Date().toISOString(),
  ): ContextStoreRevisionJob =>
    ContextStoreRevisionJobSchema.parse({
      schemaVersion: "pragma.context-store-revision-job/v1",
      id: randomUUID(),
      revision: 1,
      request,
      state: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

  const readAllJobs = async (): Promise<readonly ContextStoreRevisionJob[]> => {
    let names: string[];
    try {
      names = await readdir(jobsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => await readJob(name.slice(0, -5))),
    );
  };

  const api: ContextStoreRevisionService = {
    async submit(input) {
      const request = ContextStoreRevisionRequestSchema.parse(input);
      return await options.contextStores.withRevisionLock(request.storeId, async () => {
        await options.contextStores.getSnapshot(request.storeId);
        return await withFileLock(lockPath, async () => {
          if (request.source === "memory-learning") {
            const existing = (await readAllJobs()).find(
              (job) =>
                job.request.storeId === request.storeId &&
                job.request.source === "memory-learning" &&
                job.request.sourceDigest === request.sourceDigest,
            );
            if (existing !== undefined) return existing;
          }
          const job = createJob(request);
          await writeJob(job);
          return job;
        });
      });
    },

    async list(filter = {}) {
      const jobs = await readAllJobs();
      return jobs
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
      const applying = await mutateJob(jobId, expectedRevision, (job) => {
        if (job.state !== "pending_review" || job.changeSet === undefined) {
          throw new ContextStoreRevisionServiceError(
            "invalid_state",
            "Only a task awaiting review can be approved.",
          );
        }
        return {
          ...job,
          revision: job.revision + 1,
          state: "applying",
          updatedAt: new Date().toISOString(),
        };
      });
      try {
        const changeSet = ContextStoreChangeSetSchema.parse(applying.changeSet);
        const base = await options.contextStores.getSnapshot(
          applying.request.storeId,
          changeSet.baseRevision,
        );
        assertProgressiveStructurePreserved(base, changeSet);
        await options.contextStores.applyChangeSet(changeSet, "store-revision-agent", applying.id);
        return await mutateJob(applying.id, applying.revision, (job) => ({
          ...job,
          revision: job.revision + 1,
          state: "completed",
          updatedAt: new Date().toISOString(),
        }));
      } catch (error) {
        if (error instanceof ContextStoreStoreError && error.code === "revision_conflict") {
          const applied = (await options.contextStores.history(applying.request.storeId)).some(
            (record) => record.revisionJobId === applying.id,
          );
          if (applied) {
            return await mutateJob(applying.id, applying.revision, (job) => ({
              ...job,
              revision: job.revision + 1,
              state: "completed",
              updatedAt: new Date().toISOString(),
            }));
          }
          return await withFileLock(lockPath, async () => {
            const stale = await readJob(applying.id);
            if (stale.revision !== applying.revision || stale.state !== "applying") return stale;
            const replacement = createJob(stale.request);
            await writeJob(replacement);
            const superseded = ContextStoreRevisionJobSchema.parse({
              ...stale,
              revision: stale.revision + 1,
              state: "superseded",
              supersededBy: replacement.id,
              updatedAt: new Date().toISOString(),
            });
            await writeJob(superseded);
            return superseded;
          });
        }
        await mutateJob(applying.id, applying.revision, (job) => ({
          ...job,
          revision: job.revision + 1,
          state: "needs_attention",
          error: { code: "apply_failed", message: errorMessage(error) },
          updatedAt: new Date().toISOString(),
        }));
        throw error;
      }
    },

    async reject(jobId, expectedRevision) {
      return await mutateJob(jobId, expectedRevision, (job) => {
        if (job.state !== "pending_review") {
          throw new ContextStoreRevisionServiceError(
            "invalid_state",
            "Only a task awaiting review can be rejected.",
          );
        }
        return {
          ...job,
          revision: job.revision + 1,
          state: "rejected",
          updatedAt: new Date().toISOString(),
        };
      });
    },

    async retry(jobId, expectedRevision) {
      return await mutateJob(jobId, expectedRevision, (job) => {
        if (job.state !== "needs_attention" && job.state !== "rejected") {
          throw new ContextStoreRevisionServiceError(
            "invalid_state",
            "Only failed or rejected tasks can be retried.",
          );
        }
        return {
          ...job,
          revision: job.revision + 1,
          state: "pending",
          changeSet: undefined,
          error: undefined,
          updatedAt: new Date().toISOString(),
        };
      });
    },

    async delete(jobId, expectedRevision) {
      await withFileLock(lockPath, async () => {
        const job = await readJob(jobId);
        if (job.revision !== expectedRevision) {
          throw new ContextStoreRevisionServiceError(
            "revision_conflict",
            "The revision task changed. Refresh and try again.",
          );
        }
        if (
          job.state !== "completed" &&
          job.state !== "rejected" &&
          job.state !== "needs_attention" &&
          job.state !== "superseded"
        ) {
          throw new ContextStoreRevisionServiceError(
            "invalid_state",
            "Active revision tasks cannot be deleted.",
          );
        }
        await rm(jobPath(jobId));
      });
    },

    async processPending() {
      if (processing !== undefined) return await processing;
      const run = (async () => {
        const initial = await api.list();
        for (const stale of initial.filter((job) => job.state === "running")) {
          await mutateJob(stale.id, stale.revision, (job) => ({
            ...job,
            revision: job.revision + 1,
            state: "pending",
            changeSet: undefined,
            error: undefined,
            updatedAt: new Date().toISOString(),
          }));
        }
        const afterRunningRecovery = await api.list();
        for (const applying of afterRunningRecovery.filter((job) => job.state === "applying")) {
          try {
            if (applying.changeSet === undefined) {
              await mutateJob(applying.id, applying.revision, (job) => ({
                ...job,
                revision: job.revision + 1,
                state: "needs_attention",
                error: {
                  code: "apply_recovery_invalid",
                  message: "Applying task has no staged changeset.",
                },
                updatedAt: new Date().toISOString(),
              }));
              continue;
            }
            const alreadyApplied = (
              await options.contextStores.history(applying.request.storeId)
            ).some((record) => record.revisionJobId === applying.id);
            if (alreadyApplied) {
              await mutateJob(applying.id, applying.revision, (job) => ({
                ...job,
                revision: job.revision + 1,
                state: "completed",
                updatedAt: new Date().toISOString(),
              }));
              continue;
            }
            const changeSet = ContextStoreChangeSetSchema.parse(applying.changeSet);
            const base = await options.contextStores.getSnapshot(
              applying.request.storeId,
              changeSet.baseRevision,
            );
            assertProgressiveStructurePreserved(base, changeSet);
            const current = await options.contextStores.getSnapshot(applying.request.storeId);
            if (
              current.revision === changeSet.baseRevision &&
              current.snapshotHash === changeSet.baseSnapshotHash
            ) {
              await options.contextStores.applyChangeSet(
                changeSet,
                "store-revision-agent",
                applying.id,
              );
              await mutateJob(applying.id, applying.revision, (job) => ({
                ...job,
                revision: job.revision + 1,
                state: "completed",
                updatedAt: new Date().toISOString(),
              }));
            } else {
              await withFileLock(lockPath, async () => {
                const stale = await readJob(applying.id);
                if (stale.revision !== applying.revision || stale.state !== "applying") return;
                const replacement = createJob(stale.request);
                await writeJob(replacement);
                await writeJob(
                  ContextStoreRevisionJobSchema.parse({
                    ...stale,
                    revision: stale.revision + 1,
                    state: "superseded",
                    supersededBy: replacement.id,
                    updatedAt: new Date().toISOString(),
                  }),
                );
              });
            }
          } catch (error) {
            await mutateJob(applying.id, applying.revision, (job) => ({
              ...job,
              revision: job.revision + 1,
              state: "needs_attention",
              error: { code: "apply_recovery_failed", message: errorMessage(error) },
              updatedAt: new Date().toISOString(),
            })).catch(() => undefined);
            options.warn?.("A Context Store revision could not be recovered.", error);
          }
        }
        const all = await api.list();
        const activeStores = new Set(
          all
            .filter((job) => ["running", "pending_review", "applying"].includes(job.state))
            .map((job) => job.request.storeId),
        );
        const candidates = all
          .filter((job) => job.state === "pending" && !activeStores.has(job.request.storeId))
          .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
        const claimedStores = new Set<string>();
        for (const candidate of candidates) {
          if (claimedStores.has(candidate.request.storeId)) continue;
          claimedStores.add(candidate.request.storeId);
          const running = await mutateJob(candidate.id, candidate.revision, (job) => ({
            ...job,
            revision: job.revision + 1,
            state: "running",
            updatedAt: new Date().toISOString(),
          }));
          try {
            const [profile, snapshot] = await Promise.all([
              api.getProfile(),
              options.contextStores.getSnapshot(running.request.storeId),
            ]);
            const changeSet = attachBaseContent(
              snapshot,
              ContextStoreChangeSetSchema.parse(
                await options.generator.generate({
                  jobId: running.id,
                  request: running.request,
                  profile,
                  snapshot,
                }),
              ),
            );
            if (
              changeSet.storeId !== running.request.storeId ||
              changeSet.baseRevision !== snapshot.revision ||
              changeSet.baseSnapshotHash !== snapshot.snapshotHash
            ) {
              throw new Error("Revision Agent returned a changeset for the wrong store snapshot.");
            }
            assertProgressiveStructurePreserved(snapshot, changeSet);
            await mutateJob(running.id, running.revision, (job) => ({
              ...job,
              revision: job.revision + 1,
              state: "pending_review",
              changeSet,
              updatedAt: new Date().toISOString(),
            }));
          } catch (error) {
            await mutateJob(running.id, running.revision, (job) => ({
              ...job,
              revision: job.revision + 1,
              state: "needs_attention",
              error: { code: "generation_failed", message: errorMessage(error) },
              updatedAt: new Date().toISOString(),
            }));
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
      return await withFileLock(lockPath, async () =>
        (await readAllJobs()).some(
          (job) =>
            job.request.storeId === storeId &&
            !["completed", "rejected", "superseded"].includes(job.state),
        ),
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
      return await withFileLock(join(options.statePath, ".profile.lock"), async () => {
        const current = await api.getProfile();
        if (current.revision !== parsed.expectedRevision) {
          throw new ContextStoreRevisionServiceError(
            "profile_conflict",
            "The Store Revision Agent profile changed. Refresh and try again.",
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
