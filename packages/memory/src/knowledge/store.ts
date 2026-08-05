import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths, withFileLock } from "@pragma/core";
import {
  KnowledgeExtractionJobSchema,
  type KnowledgeExtractionJob,
  type MemorySubjectRef,
} from "@pragma/shared";

import { DEFAULT_MEMORY_STORAGE_POLICY } from "../storage/memory-storage-policy.ts";
import {
  queryMemoryJobPage,
  type MemoryJobPage,
  type MemoryJobPageInput,
} from "../pipeline/memory-job-page.ts";
import { assertFreshSqliteDatabase } from "../storage/sqlite-migration-backup.ts";

const MODULE_ID = "pragma.memory.knowledge-learning";
const LEASE_MS = 5 * 60_000;
const MAX_TRANSIENT_ATTEMPTS = 3;

export interface KnowledgeLearningStoreDiagnostic {
  readonly jobs: number;
  readonly pending: number;
  readonly running: number;
  readonly needsAttention: number;
  readonly completed: number;
  readonly lastErrorCode?: string | undefined;
}

export interface KnowledgeLearningStore {
  schedule(input: {
    readonly rootRef: MemorySubjectRef;
    readonly sourceDigest: string;
    readonly now: Date;
  }): Promise<KnowledgeExtractionJob | undefined>;
  claimDueJob(now: Date): Promise<KnowledgeExtractionJob | undefined>;
  isClaimCurrent(job: KnowledgeExtractionJob): Promise<boolean>;
  completeRejected(job: KnowledgeExtractionJob, now: Date): Promise<void>;
  completeLearned(job: KnowledgeExtractionJob, now: Date): Promise<void>;
  fail(input: {
    readonly job: KnowledgeExtractionJob;
    readonly errorCode: string;
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
  }): Promise<KnowledgeExtractionJob>;
  deleteJob(input: { readonly id: string; readonly expectedRevision: number }): Promise<void>;
  wakeNeedsAttention(now: Date, reason?: "configuration" | "manual"): Promise<void>;
  listJobs(): Promise<readonly KnowledgeExtractionJob[]>;
  listJobsPage(
    input: MemoryJobPageInput<KnowledgeExtractionJob["status"]>,
  ): Promise<MemoryJobPage<KnowledgeExtractionJob>>;
  maintain(now: Date): Promise<{ readonly deletedJobs: number }>;
  inspect(): Promise<KnowledgeLearningStoreDiagnostic>;
  close(): void;
}

export async function createKnowledgeLearningStore(
  options: { readonly pragmaHome?: string | undefined } = {},
): Promise<KnowledgeLearningStore> {
  const paths = new PragmaPaths(options);
  const dataRoot = paths.memoryModuleDataRoot(MODULE_ID);
  const stateRoot = paths.memoryModuleStateRoot(MODULE_ID);
  await Promise.all([
    mkdir(dataRoot, { recursive: true, mode: 0o700 }),
    mkdir(stateRoot, { recursive: true, mode: 0o700 }),
  ]);
  const databasePath = join(dataRoot, "knowledge.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    await withFileLock(`${databasePath}.migration.lock`, async () => {
      assertFreshOrCurrent(database);
      initialize(database);
    });
  } catch (error) {
    database.close();
    throw error;
  }

  const writeJob = (job: KnowledgeExtractionJob): void => {
    database
      .prepare(
        `INSERT INTO jobs(id, root_key, source_digest, status, retry_at, lease_until, job_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, retry_at=excluded.retry_at,
           lease_until=excluded.lease_until, job_json=excluded.job_json`,
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

  const store: KnowledgeLearningStore = {
    async schedule(input) {
      const sourceDigest = assertDigest(input.sourceDigest);
      const rootKey = refKey(input.rootRef);
      const existing = database
        .prepare("SELECT 1 FROM jobs WHERE root_key=? AND source_digest=?")
        .get(rootKey, sourceDigest);
      if (existing !== undefined) return undefined;
      const timestamp = input.now.toISOString();
      const job = KnowledgeExtractionJobSchema.parse({
        schemaVersion: "pragma.memory-knowledge-job/v1",
        id: stableId("knowledge-job", rootKey, sourceDigest),
        revision: 1,
        rootRef: input.rootRef,
        sourceDigest,
        status: "pending",
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      writeJob(job);
      return job;
    },
    async claimDueJob(now) {
      const timestamp = now.toISOString();
      const row = database
        .prepare(
          `SELECT job_json FROM jobs
           WHERE (status='pending' AND (retry_at IS NULL OR retry_at<=?))
              OR (status='running' AND lease_until<=?)
           ORDER BY rowid LIMIT 1`,
        )
        .get(timestamp, timestamp) as { job_json: string } | undefined;
      if (row === undefined) return undefined;
      const current = parseJob(row.job_json);
      const claimed = KnowledgeExtractionJobSchema.parse({
        ...current,
        revision: current.revision + 1,
        status: "running",
        attempts: current.attempts + 1,
        retryAt: undefined,
        leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(),
        updatedAt: timestamp,
      });
      writeJob(claimed);
      return claimed;
    },
    async isClaimCurrent(job) {
      const current = readJob(database, job.id);
      return current?.revision === job.revision && current.status === "running";
    },
    async completeRejected(job, now) {
      completeJob(database, writeJob, job, "rejected", now);
    },
    async completeLearned(job, now) {
      completeJob(database, writeJob, job, "retained", now);
    },
    async fail(input) {
      const current = readJob(database, input.job.id);
      if (current?.revision !== input.job.revision || current.status !== "running") return;
      const needsAttention =
        input.retry !== "transient" || input.job.attempts >= MAX_TRANSIENT_ATTEMPTS;
      writeJob(
        KnowledgeExtractionJobSchema.parse({
          ...input.job,
          revision: input.job.revision + 1,
          status: needsAttention ? "needs_attention" : "pending",
          retryAt: needsAttention
            ? undefined
            : new Date(input.now.getTime() + 2 ** input.job.attempts * 1_000).toISOString(),
          leaseUntil: undefined,
          lastErrorCode: input.errorCode,
          failureClass: needsAttention
            ? input.retry === "capacity"
              ? "capacity"
              : input.retry === "configuration"
                ? "configuration"
                : "transient-exhausted"
            : undefined,
          updatedAt: input.now.toISOString(),
        }),
      );
    },
    async retryJob(input) {
      const job = readJob(database, input.id);
      assertManageableJob(job, input.expectedRevision, ["needs_attention"]);
      writeJob(resetPendingJob(job, input.now));
    },
    async expediteJob(input) {
      const job = readJob(database, input.id);
      assertManageableJob(job, input.expectedRevision, ["pending"]);
      writeJob(
        KnowledgeExtractionJobSchema.parse({
          ...job,
          revision: job.revision + 1,
          retryAt: input.now.toISOString(),
          updatedAt: input.now.toISOString(),
        }),
      );
    },
    async interruptJob(input) {
      const job = readJob(database, input.id);
      assertManageableJob(job, input.expectedRevision, ["running"]);
      const interrupted = KnowledgeExtractionJobSchema.parse({
        ...resetPendingJob(job, input.now),
        retryAt: new Date(
          input.now.getTime() + DEFAULT_MEMORY_STORAGE_POLICY.extractionIdleMs,
        ).toISOString(),
      });
      writeJob(interrupted);
      return interrupted;
    },
    async deleteJob(input) {
      const job = readJob(database, input.id);
      assertManageableJob(job, input.expectedRevision, ["needs_attention"]);
      database.prepare("DELETE FROM jobs WHERE id=?").run(job.id);
    },
    async wakeNeedsAttention(now, reason = "configuration") {
      const rows = database
        .prepare("SELECT job_json FROM jobs WHERE status='needs_attention'")
        .all() as { job_json: string }[];
      for (const row of rows) {
        const job = parseJob(row.job_json);
        if (reason === "configuration" && job.failureClass !== "configuration") continue;
        writeJob(resetPendingJob(job, now));
      }
    },
    async listJobs() {
      return (
        database.prepare("SELECT job_json FROM jobs ORDER BY rowid DESC").all() as {
          job_json: string;
        }[]
      ).map((row) => parseJob(row.job_json));
    },
    async listJobsPage(input) {
      return queryMemoryJobPage(database, input, parseJob);
    },
    async maintain(now) {
      const cutoff = now.getTime() - DEFAULT_MEMORY_STORAGE_POLICY.jobRecordRetentionMs;
      const completed = database
        .prepare("SELECT id, job_json FROM jobs WHERE status='completed'")
        .all() as { id: string; job_json: string }[];
      const expired = completed.filter(
        (row) => Date.parse(parseJob(row.job_json).updatedAt) < cutoff,
      );
      if (expired.length === 0) return { deletedJobs: 0 };
      const remove = database.prepare("DELETE FROM jobs WHERE id=?");
      database.exec("BEGIN IMMEDIATE;");
      try {
        for (const row of expired) remove.run(row.id);
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
        jobs: [...counts.values()].reduce((total, count) => total + count, 0),
        pending: counts.get("pending") ?? 0,
        running: counts.get("running") ?? 0,
        needsAttention: counts.get("needs_attention") ?? 0,
        completed: counts.get("completed") ?? 0,
        lastErrorCode: last === undefined ? undefined : parseJob(last.job_json).lastErrorCode,
      };
    },
    close() {
      database.close();
    },
  };
  return store;
}

function initialize(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL);
    INSERT INTO schema_meta(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_meta);
    CREATE TABLE IF NOT EXISTS jobs(
      id TEXT PRIMARY KEY, root_key TEXT NOT NULL, source_digest TEXT NOT NULL,
      status TEXT NOT NULL, retry_at TEXT, lease_until TEXT, job_json TEXT NOT NULL,
      UNIQUE(root_key, source_digest)
    );
  `);
}

function assertFreshOrCurrent(database: DatabaseSync): void {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'")
    .get();
  if (row === undefined) {
    assertFreshSqliteDatabase(database, "pragma.memory-knowledge-learning-store");
    return;
  }
  const version = database.prepare("SELECT version FROM schema_meta LIMIT 1").get() as
    { version: number } | undefined;
  if (version?.version !== 1) {
    throw new Error("Unsupported pragma.memory-knowledge-learning-store version.");
  }
}

function parseJob(json: string): KnowledgeExtractionJob {
  return KnowledgeExtractionJobSchema.parse(JSON.parse(json));
}

function readJob(database: DatabaseSync, id: string): KnowledgeExtractionJob | undefined {
  const row = database.prepare("SELECT job_json FROM jobs WHERE id=?").get(id) as
    { job_json: string } | undefined;
  return row === undefined ? undefined : parseJob(row.job_json);
}

function completeJob(
  database: DatabaseSync,
  writeJob: (job: KnowledgeExtractionJob) => void,
  job: KnowledgeExtractionJob,
  completion: "retained" | "rejected",
  now: Date,
): void {
  assertCurrentJob(database, job);
  writeJob(
    KnowledgeExtractionJobSchema.parse({
      ...job,
      revision: job.revision + 1,
      status: "completed",
      completion,
      leaseUntil: undefined,
      updatedAt: now.toISOString(),
    }),
  );
}

function resetPendingJob(job: KnowledgeExtractionJob, now: Date): KnowledgeExtractionJob {
  return KnowledgeExtractionJobSchema.parse({
    ...job,
    revision: job.revision + 1,
    status: "pending",
    attempts: 0,
    retryAt: undefined,
    leaseUntil: undefined,
    lastErrorCode: undefined,
    failureClass: undefined,
    updatedAt: now.toISOString(),
  });
}

function assertCurrentJob(database: DatabaseSync, job: KnowledgeExtractionJob): void {
  const current = readJob(database, job.id);
  if (current?.revision !== job.revision || current.status !== "running") throw conflict();
}

function assertManageableJob(
  job: KnowledgeExtractionJob | undefined,
  expectedRevision: number,
  statuses: readonly KnowledgeExtractionJob["status"][],
): asserts job is KnowledgeExtractionJob {
  if (job === undefined || job.revision !== expectedRevision) throw conflict();
  if (!statuses.includes(job.status)) throw new Error("knowledge_job_state_invalid");
}

function assertDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("knowledge_source_digest_invalid");
  return value;
}

function refKey(ref: MemorySubjectRef): string {
  return `${ref.type}\0${ref.id}`;
}

function stableId(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

function conflict(): Error {
  return Object.assign(new Error("knowledge_job_conflict"), { code: "revision_conflict" });
}
