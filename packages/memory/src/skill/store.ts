import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths, withFileLock } from "@pragma/core";
import {
  SkillLearningJobSchema,
  type MemoryExtractionFailureAttempt,
  type MemoryExtractionFailureDiagnostic,
  type MemorySubjectRef,
  type SkillLearningJob,
} from "@pragma/shared";

import {
  queryMemoryJobPage,
  type MemoryJobPage,
  type MemoryJobPageInput,
} from "../pipeline/memory-job-page.ts";
import {
  deleteExtractionFailureAttempts,
  initializeExtractionFailureAttempts,
  insertExtractionFailureAttempt,
  listExtractionFailureAttempts,
} from "../pipeline/extraction-failure-store.ts";
import { DEFAULT_MEMORY_STORAGE_POLICY } from "../storage/memory-storage-policy.ts";
import {
  assertFreshSqliteDatabase,
  ensureSqliteMigrationBackup,
} from "../storage/sqlite-migration-backup.ts";

const MODULE_ID = "pragma.memory.skill-learning";
const LEASE_MS = 5 * 60_000;

export interface SkillLearningStore {
  schedule(input: {
    readonly rootRef: MemorySubjectRef;
    readonly sourceDigest: string;
    readonly now: Date;
  }): Promise<SkillLearningJob | undefined>;
  claimDueJob(now: Date): Promise<SkillLearningJob | undefined>;
  isClaimCurrent(job: SkillLearningJob): Promise<boolean>;
  complete(job: SkillLearningJob, completion: "retained" | "rejected", now: Date): Promise<void>;
  fail(input: {
    readonly job: SkillLearningJob;
    readonly diagnostic: MemoryExtractionFailureDiagnostic;
    readonly stack?: string | undefined;
    readonly retry: "configuration" | "transient" | "capacity";
    readonly now: Date;
  }): Promise<void>;
  retryJob(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly now: Date;
  }): Promise<void>;
  expediteJob(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly now: Date;
  }): Promise<void>;
  interruptJob(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly now: Date;
  }): Promise<SkillLearningJob>;
  deleteJob(input: { readonly id: string; readonly expectedRevision: number }): Promise<void>;
  wakeNeedsAttention(now: Date, reason?: "configuration" | "manual"): Promise<void>;
  listJobs(): Promise<readonly SkillLearningJob[]>;
  listFailureAttempts(jobId: string): Promise<readonly MemoryExtractionFailureAttempt[]>;
  listJobsPage(
    input: MemoryJobPageInput<SkillLearningJob["status"]>,
  ): Promise<MemoryJobPage<SkillLearningJob>>;
  maintain(now: Date): Promise<{ readonly deletedJobs: number }>;
  inspect(): Promise<{
    readonly jobs: number;
    readonly pending: number;
    readonly running: number;
    readonly needsAttention: number;
    readonly completed: number;
    readonly lastErrorCode?: string | undefined;
  }>;
  close(): void;
}

export async function createSkillLearningStore(
  options: { readonly pragmaHome?: string } = {},
): Promise<SkillLearningStore> {
  const paths = new PragmaPaths(options);
  const dataRoot = paths.memoryModuleDataRoot(MODULE_ID);
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const databasePath = join(dataRoot, "skill-learning.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    await withFileLock(`${databasePath}.migration.lock`, async () => {
      await assertFreshOrCurrent(database, databasePath);
      initialize(database);
    });
  } catch (error) {
    database.close();
    throw error;
  }

  const parse = (json: string) => SkillLearningJobSchema.parse(JSON.parse(json));
  const read = (id: string): SkillLearningJob | undefined => {
    const row = database.prepare("SELECT job_json FROM jobs WHERE id=?").get(id) as
      { job_json: string } | undefined;
    return row === undefined ? undefined : parse(row.job_json);
  };
  const write = (job: SkillLearningJob) => {
    database
      .prepare(
        `INSERT INTO jobs(id, root_key, source_digest, status, retry_at, lease_until, job_json)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,
      retry_at=excluded.retry_at, lease_until=excluded.lease_until, job_json=excluded.job_json`,
      )
      .run(
        job.id,
        refKey(job.rootRef),
        job.sourceDigest,
        job.status,
        job.retryAt ?? null,
        job.leaseUntil ?? null,
        JSON.stringify(job),
      );
  };
  const assertManaged = (
    job: SkillLearningJob | undefined,
    revision: number,
    states: readonly SkillLearningJob["status"][],
  ): SkillLearningJob => {
    if (job === undefined || job.revision !== revision) throw conflict();
    if (!states.includes(job.status)) throw new Error("skill_job_state_invalid");
    return job;
  };
  const reset = (job: SkillLearningJob, now: Date) =>
    SkillLearningJobSchema.parse({
      ...job,
      revision: job.revision + 1,
      status: "pending",
      attempts: 0,
      retryAt: undefined,
      leaseUntil: undefined,
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
      lastFailure: undefined,
      failureClass: undefined,
      updatedAt: now.toISOString(),
    });

  return {
    async schedule(input) {
      if (!/^[a-f0-9]{64}$/u.test(input.sourceDigest))
        throw new Error("skill_source_digest_invalid");
      const rootKey = refKey(input.rootRef);
      if (
        database
          .prepare("SELECT 1 FROM jobs WHERE root_key=? AND source_digest=?")
          .get(rootKey, input.sourceDigest) !== undefined
      )
        return undefined;
      const timestamp = input.now.toISOString();
      const job = SkillLearningJobSchema.parse({
        schemaVersion: "pragma.memory-skill-job/v2",
        id: stableId("skill-job", rootKey, input.sourceDigest),
        revision: 1,
        rootRef: input.rootRef,
        sourceDigest: input.sourceDigest,
        status: "pending",
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      write(job);
      return job;
    },
    async claimDueJob(now) {
      const timestamp = now.toISOString();
      const row = database
        .prepare(
          `SELECT job_json FROM jobs WHERE
        (status='pending' AND (retry_at IS NULL OR retry_at<=?)) OR
        (status='running' AND lease_until<=?) ORDER BY rowid LIMIT 1`,
        )
        .get(timestamp, timestamp) as { job_json: string } | undefined;
      if (row === undefined) return undefined;
      const current = parse(row.job_json);
      const claimed = SkillLearningJobSchema.parse({
        ...current,
        revision: current.revision + 1,
        status: "running",
        attempts: current.attempts + 1,
        retryAt: undefined,
        leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(),
        updatedAt: timestamp,
      });
      write(claimed);
      return claimed;
    },
    async isClaimCurrent(job) {
      const current = read(job.id);
      return current?.revision === job.revision && current.status === "running";
    },
    async complete(job, completion, now) {
      const current = read(job.id);
      if (current?.revision !== job.revision || current.status !== "running") throw conflict();
      write(
        SkillLearningJobSchema.parse({
          ...job,
          revision: job.revision + 1,
          status: "completed",
          completion,
          leaseUntil: undefined,
          updatedAt: now.toISOString(),
        }),
      );
    },
    async fail(input) {
      const current = read(input.job.id);
      if (current?.revision !== input.job.revision || current.status !== "running") return;
      const attention = input.retry !== "transient" || input.job.attempts >= 3;
      const failed = SkillLearningJobSchema.parse({
        ...input.job,
        revision: input.job.revision + 1,
        status: attention ? "needs_attention" : "pending",
        retryAt: attention
          ? undefined
          : new Date(input.now.getTime() + 2 ** input.job.attempts * 1_000).toISOString(),
        leaseUntil: undefined,
        lastErrorCode: input.diagnostic.code,
        lastErrorMessage: input.diagnostic.message,
        lastFailure: input.diagnostic,
        failureClass: attention
          ? input.retry === "capacity"
            ? "capacity"
            : input.retry === "configuration"
              ? "configuration"
              : "transient-exhausted"
          : undefined,
        updatedAt: input.now.toISOString(),
      });
      database.exec("BEGIN IMMEDIATE;");
      try {
        insertExtractionFailureAttempt(database, {
          jobId: input.job.id,
          jobRevision: input.job.revision,
          attempt: input.job.attempts,
          diagnostic: input.diagnostic,
          ...(input.stack === undefined ? {} : { stack: input.stack }),
        });
        write(failed);
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
    async retryJob(input) {
      write(
        reset(
          assertManaged(read(input.id), input.expectedRevision, ["needs_attention"]),
          input.now,
        ),
      );
    },
    async expediteJob(input) {
      const job = assertManaged(read(input.id), input.expectedRevision, ["pending"]);
      write(
        SkillLearningJobSchema.parse({
          ...job,
          revision: job.revision + 1,
          retryAt: input.now.toISOString(),
          updatedAt: input.now.toISOString(),
        }),
      );
    },
    async interruptJob(input) {
      const job = assertManaged(read(input.id), input.expectedRevision, ["running"]);
      const next = SkillLearningJobSchema.parse({
        ...reset(job, input.now),
        retryAt: new Date(
          input.now.getTime() + DEFAULT_MEMORY_STORAGE_POLICY.extractionIdleMs,
        ).toISOString(),
      });
      write(next);
      return next;
    },
    async deleteJob(input) {
      const job = assertManaged(read(input.id), input.expectedRevision, ["needs_attention"]);
      database.exec("BEGIN IMMEDIATE;");
      try {
        deleteExtractionFailureAttempts(database, job.id);
        database.prepare("DELETE FROM jobs WHERE id=?").run(job.id);
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    },
    async wakeNeedsAttention(now, reason = "configuration") {
      const rows = database
        .prepare("SELECT job_json FROM jobs WHERE status='needs_attention'")
        .all() as { job_json: string }[];
      for (const row of rows) {
        const job = parse(row.job_json);
        if (reason === "manual" || job.failureClass === "configuration") write(reset(job, now));
      }
    },
    async listJobs() {
      return (
        database.prepare("SELECT job_json FROM jobs ORDER BY rowid DESC").all() as {
          job_json: string;
        }[]
      ).map((row) => parse(row.job_json));
    },
    async listFailureAttempts(jobId) {
      return listExtractionFailureAttempts(database, jobId);
    },
    async listJobsPage(input) {
      return queryMemoryJobPage(database, input, parse);
    },
    async maintain(now) {
      const cutoff = now.getTime() - DEFAULT_MEMORY_STORAGE_POLICY.jobRecordRetentionMs;
      const rows = database
        .prepare("SELECT id, job_json FROM jobs WHERE status='completed'")
        .all() as { id: string; job_json: string }[];
      const expired = rows.filter((row) => Date.parse(parse(row.job_json).updatedAt) < cutoff);
      const remove = database.prepare("DELETE FROM jobs WHERE id=?");
      database.exec("BEGIN IMMEDIATE;");
      try {
        for (const row of expired) {
          deleteExtractionFailureAttempts(database, row.id);
          remove.run(row.id);
        }
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
      return { deletedJobs: expired.length };
    },
    async inspect() {
      const rows = database
        .prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status")
        .all() as { status: string; count: number }[];
      const counts = new Map(rows.map((row) => [row.status, Number(row.count)]));
      const last = database
        .prepare(
          "SELECT job_json FROM jobs WHERE status='needs_attention' ORDER BY rowid DESC LIMIT 1",
        )
        .get() as { job_json: string } | undefined;
      return {
        jobs: [...counts.values()].reduce((sum, count) => sum + count, 0),
        pending: counts.get("pending") ?? 0,
        running: counts.get("running") ?? 0,
        needsAttention: counts.get("needs_attention") ?? 0,
        completed: counts.get("completed") ?? 0,
        ...(last === undefined ? {} : { lastErrorCode: parse(last.job_json).lastErrorCode }),
      };
    },
    close() {
      database.close();
    },
  };
}

function initialize(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL);
    INSERT INTO schema_meta(version) SELECT 4 WHERE NOT EXISTS (SELECT 1 FROM schema_meta);
    CREATE TABLE IF NOT EXISTS jobs(
      id TEXT PRIMARY KEY, root_key TEXT NOT NULL, source_digest TEXT NOT NULL,
      status TEXT NOT NULL, retry_at TEXT, lease_until TEXT, job_json TEXT NOT NULL,
      UNIQUE(root_key, source_digest)
    );
  `);
  initializeExtractionFailureAttempts(database);
}

async function assertFreshOrCurrent(database: DatabaseSync, databasePath: string): Promise<void> {
  const existing = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'")
    .get();
  if (existing === undefined) {
    assertFreshSqliteDatabase(database, "pragma.memory-skill-learning-store");
    return;
  }
  const version = database.prepare("SELECT version FROM schema_meta LIMIT 1").get() as
    { readonly version: number } | undefined;
  if (
    version?.version !== 1 &&
    version?.version !== 2 &&
    version?.version !== 3 &&
    version?.version !== 4
  ) {
    throw new Error("Unsupported pragma.memory-skill-learning-store version.");
  }
  if (version.version === 4) return;
  await ensureSqliteMigrationBackup(database, databasePath, version.version);
  if (version.version === 1) migrateV1ToV2(database);
  if (version.version <= 2) migrateV2ToV3(database);
  migrateV3ToV4(database);
}

function migrateV1ToV2(database: DatabaseSync): void {
  const rows = database.prepare("SELECT id, job_json FROM jobs").all() as unknown as readonly {
    readonly id: string;
    readonly job_json: string;
  }[];
  database.exec("BEGIN IMMEDIATE;");
  try {
    const update = database.prepare(
      "UPDATE jobs SET status=?, retry_at=NULL, lease_until=NULL, job_json=? WHERE id=?",
    );
    for (const row of rows) {
      const legacy = JSON.parse(row.job_json) as Record<string, unknown>;
      if (
        legacy.status !== "needs_attention" ||
        legacy.lastErrorCode !== "skill_source_threshold_not_met"
      ) {
        continue;
      }
      const job = upgradeSkillJob(legacy);
      const migrated = SkillLearningJobSchema.parse({
        ...job,
        revision: job.revision + 1,
        status: "completed",
        completion: "rejected",
        retryAt: undefined,
        leaseUntil: undefined,
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
        lastFailure: undefined,
        failureClass: undefined,
      });
      update.run(migrated.status, JSON.stringify(migrated), migrated.id);
    }
    database.prepare("UPDATE schema_meta SET version=2").run();
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

const REQUEUEABLE_CANDIDATE_ERROR_CODES = new Set([
  "skill_normalized_key_duplicate",
  "skill_target_binding_invalid",
]);

function migrateV2ToV3(database: DatabaseSync): void {
  const rows = database.prepare("SELECT id, job_json FROM jobs").all() as unknown as readonly {
    readonly id: string;
    readonly job_json: string;
  }[];
  database.exec("BEGIN IMMEDIATE;");
  try {
    const update = database.prepare(
      "UPDATE jobs SET status=?, retry_at=?, lease_until=NULL, job_json=? WHERE id=?",
    );
    for (const row of rows) {
      const legacy = JSON.parse(row.job_json) as Record<string, unknown>;
      if (
        legacy.status !== "needs_attention" ||
        typeof legacy.lastErrorCode !== "string" ||
        !REQUEUEABLE_CANDIDATE_ERROR_CODES.has(legacy.lastErrorCode)
      ) {
        continue;
      }
      const job = upgradeSkillJob(legacy);
      const migrated = SkillLearningJobSchema.parse({
        ...job,
        revision: job.revision + 1,
        status: "pending",
        attempts: 0,
        retryAt: job.updatedAt,
        leaseUntil: undefined,
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
        lastFailure: undefined,
        failureClass: undefined,
        completion: undefined,
      });
      update.run(migrated.status, migrated.retryAt ?? null, JSON.stringify(migrated), migrated.id);
    }
    database.prepare("UPDATE schema_meta SET version=3").run();
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

function migrateV3ToV4(database: DatabaseSync): void {
  const rows = database.prepare("SELECT id, job_json FROM jobs").all() as unknown as readonly {
    readonly id: string;
    readonly job_json: string;
  }[];
  database.exec("BEGIN IMMEDIATE;");
  try {
    initializeExtractionFailureAttempts(database);
    const update = database.prepare("UPDATE jobs SET job_json=? WHERE id=?");
    for (const row of rows) {
      const migrated = upgradeSkillJob(JSON.parse(row.job_json));
      update.run(JSON.stringify(migrated), row.id);
    }
    database.prepare("UPDATE schema_meta SET version=4").run();
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

function upgradeSkillJob(value: unknown): SkillLearningJob {
  if (typeof value !== "object" || value === null) throw new Error("skill_job_state_invalid");
  return SkillLearningJobSchema.parse({
    ...(value as Record<string, unknown>),
    schemaVersion: "pragma.memory-skill-job/v2",
  });
}

function refKey(ref: MemorySubjectRef): string {
  return `${ref.type}\0${ref.id}`;
}
function stableId(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}
function conflict(): Error {
  return Object.assign(new Error("skill_job_conflict"), { code: "revision_conflict" });
}
