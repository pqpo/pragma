import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths, withFileLock } from "@pragma/core";
import {
  MemoryEvidenceEnvelopeSchema,
  type MemoryEvidenceEnvelope,
  type MemorySubjectRef,
} from "@pragma/shared";

import {
  EpisodicExtractionJobSchema,
  EpisodicMemoryRecordSchema,
  type EpisodicExtractionJob,
  type EpisodicMemoryRecord,
} from "./schema.ts";
import {
  assertMemoryBindingsTightened,
  assertMemoryVisibilityTightened,
  createMemoryTombstone,
} from "../governance/access-governance.ts";
import type { MemoryRecallScope } from "../pipeline/memory-module.ts";
import {
  EMPTY_MEMORY_EVIDENCE_OMISSION_STATS,
  MemoryEvidenceOmissionStatsSchema,
  mergeMemoryEvidenceOmissionStats,
  selectBoundedMemoryEvidence,
  type MemoryEvidenceOmissionStats,
} from "../storage/bounded-evidence.ts";
import { DEFAULT_MEMORY_STORAGE_POLICY } from "../storage/memory-storage-policy.ts";
import { EPISODIC_DATA_STORAGE_MIGRATIONS } from "../storage/migrations/episodic-data/index.ts";
import { EPISODIC_JOB_STORAGE_MIGRATIONS } from "../storage/migrations/episodic-jobs/index.ts";
import {
  assertFreshSqliteDatabase,
  removeExpiredSqliteMigrationBackup,
  runAdjacentSqliteMigrations,
} from "../storage/sqlite-migration-backup.ts";

export interface EpisodicGovernanceInput {
  readonly id: string;
  readonly expectedRevision: number;
  readonly actorRef: MemorySubjectRef;
  readonly reason: string;
  readonly now: Date;
}

export interface EpisodicMemoryStoreDiagnostic {
  readonly episodes: number;
  readonly pending: number;
  readonly running: number;
  readonly needsAttention: number;
  readonly expired: number;
  readonly evidenceRecords: number;
  readonly evidenceBytes: number;
  readonly truncatedExecutions: number;
  readonly rejected: number;
  readonly rejectedByReason: Readonly<Record<EpisodicRejectionReason, number>>;
}

export type EpisodicRejectionReason =
  "low-value" | "insufficient-evidence" | "sensitive" | "policy";

export interface EpisodicMemoryStore {
  ingest(envelopes: readonly MemoryEvidenceEnvelope[]): Promise<void>;
  claimDueJob(now: Date): Promise<EpisodicExtractionJob | undefined>;
  readEvidence(executionId: string): Promise<readonly MemoryEvidenceEnvelope[]>;
  readOmissionStats(executionId: string): Promise<MemoryEvidenceOmissionStats>;
  getByExecution(executionId: string): Promise<EpisodicMemoryRecord | undefined>;
  get(id: string): Promise<EpisodicMemoryRecord | undefined>;
  history(id: string): Promise<readonly EpisodicMemoryRecord[]>;
  list(): Promise<readonly EpisodicMemoryRecord[]>;
  listForRecall(scope: MemoryRecallScope): Promise<readonly EpisodicMemoryRecord[]>;
  searchForRecall(
    scope: MemoryRecallScope,
    query: string,
    limit: number,
  ): Promise<readonly EpisodicMemoryRecord[]>;
  getForRecall(scope: MemoryRecallScope, id: string): Promise<EpisodicMemoryRecord | undefined>;
  getEvidenceForRecall(
    scope: MemoryRecallScope,
    messageId: string,
  ): Promise<MemoryEvidenceEnvelope | undefined>;
  getEvidence(messageId: string): Promise<MemoryEvidenceEnvelope | undefined>;
  tightenAccess(
    input: EpisodicGovernanceInput & {
      readonly bindings?: EpisodicMemoryRecord["bindings"] | undefined;
      readonly visibility?: EpisodicMemoryRecord["visibility"] | undefined;
    },
  ): Promise<EpisodicMemoryRecord>;
  invalidate(input: EpisodicGovernanceInput): Promise<EpisodicMemoryRecord>;
  forget(input: EpisodicGovernanceInput): Promise<void>;
  completeRetained(input: {
    readonly job: EpisodicExtractionJob;
    readonly record: EpisodicMemoryRecord;
    readonly evidence: readonly MemoryEvidenceEnvelope[];
    readonly now: Date;
  }): Promise<void>;
  completeRejected(
    job: EpisodicExtractionJob,
    reason: EpisodicRejectionReason,
    now: Date,
  ): Promise<void>;
  fail(input: {
    readonly job: EpisodicExtractionJob;
    readonly errorCode: string;
    readonly now: Date;
    readonly retry: "transient" | "configuration";
  }): Promise<void>;
  wakeNeedsAttention(now: Date, reason?: "configuration" | "manual"): Promise<void>;
  retryJob(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly now: Date;
  }): Promise<void>;
  listExtractionJobs(): Promise<readonly EpisodicExtractionJob[]>;
  maintain(now: Date): Promise<{ readonly expired: number; readonly deleted: number }>;
  deleteExecutionState(executionIds: readonly string[], now?: Date): Promise<void>;
  inspect(): Promise<EpisodicMemoryStoreDiagnostic>;
  close(): void;
}

export async function createEpisodicMemoryStore(
  options: { readonly pragmaHome?: string | undefined } = {},
): Promise<EpisodicMemoryStore> {
  const paths = new PragmaPaths(options);
  const moduleId = "pragma.memory.episodic";
  const dataPath = join(paths.memoryModuleDataRoot(moduleId), "episodes.sqlite");
  const statePath = join(paths.memoryModuleStateRoot(moduleId), "jobs.sqlite");
  await Promise.all([
    mkdir(paths.memoryModuleDataRoot(moduleId), { recursive: true, mode: 0o700 }),
    mkdir(paths.memoryModuleStateRoot(moduleId), { recursive: true, mode: 0o700 }),
  ]);
  const data = new DatabaseSync(dataPath);
  const state = new DatabaseSync(statePath);
  try {
    await withFileLock(`${dataPath}.migration.lock`, async () => {
      if (readVersion(data) === 0) {
        assertFreshSqliteDatabase(data, "pragma.memory-episodic-store");
      } else {
        await runAdjacentSqliteMigrations({
          database: data,
          databasePath: dataPath,
          family: "pragma.memory-episodic-store",
          targetVersion: 2,
          migrations: EPISODIC_DATA_STORAGE_MIGRATIONS,
        });
      }
      initializeData(data);
    });
    await withFileLock(`${statePath}.migration.lock`, async () => {
      if (readVersion(state) === 0) {
        assertFreshSqliteDatabase(state, "pragma.memory-episodic-jobs");
      } else {
        await runAdjacentSqliteMigrations({
          database: state,
          databasePath: statePath,
          family: "pragma.memory-episodic-jobs",
          targetVersion: 2,
          migrations: EPISODIC_JOB_STORAGE_MIGRATIONS,
        });
      }
      initializeState(state);
    });
  } catch (error) {
    tryClose(data);
    tryClose(state);
    throw error;
  }

  const writeJob = (job: EpisodicExtractionJob): void => {
    state
      .prepare(
        `INSERT INTO jobs(id, execution_id, terminal_message_id, status, retry_at, lease_until, job_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           terminal_message_id=excluded.terminal_message_id,
           status=excluded.status,
           retry_at=excluded.retry_at,
           lease_until=excluded.lease_until,
           job_json=excluded.job_json`,
      )
      .run(
        job.id,
        job.executionId,
        job.terminalMessageId,
        job.status,
        job.retryAt ?? null,
        job.leaseUntil ?? null,
        JSON.stringify(job),
      );
  };

  return {
    async ingest(envelopes) {
      if (envelopes.length === 0) return;
      const insertEvidence = state.prepare(
        `INSERT OR IGNORE INTO evidence(message_id, execution_id, occurred_at, envelope_json)
         VALUES (?, ?, ?, ?)`,
      );
      state.exec("BEGIN IMMEDIATE;");
      try {
        const touched = new Set<string>();
        for (const raw of envelopes) {
          const envelope = MemoryEvidenceEnvelopeSchema.parse(raw);
          const executionId = envelope.correlationId;
          if (executionId === undefined) continue;
          if (isDeletedExecution(state, executionId)) continue;
          touched.add(executionId);
          insertEvidence.run(
            envelope.messageId,
            executionId,
            envelope.occurredAt,
            JSON.stringify(envelope),
          );
          if (envelope.topic !== "execution.execution.terminal") continue;
          const id = extractionJobId(executionId);
          const existing = readJob(state, id);
          if (existing?.terminalMessageId === envelope.messageId) continue;
          writeJob(
            EpisodicExtractionJobSchema.parse({
              schemaVersion: "pragma.memory-extraction-job/v2",
              id,
              revision: 1,
              executionId,
              terminalMessageId: envelope.messageId,
              status: "pending",
              attempts: 0,
              totalAttempts: 0,
              updatedAt: envelope.occurredAt,
            }),
          );
        }
        for (const executionId of touched) compactEvidence(state, executionId);
        state.exec("COMMIT;");
      } catch (error) {
        rollback(state);
        throw error;
      }
    },

    async claimDueJob(now) {
      state.exec("BEGIN IMMEDIATE;");
      try {
        const row = state
          .prepare(
            `SELECT job_json AS jobJson FROM jobs
             WHERE (status = 'pending' AND (retry_at IS NULL OR retry_at <= ?))
                OR (status = 'running' AND lease_until <= ?)
             ORDER BY retry_at IS NOT NULL, retry_at, id LIMIT 1`,
          )
          .get(now.toISOString(), now.toISOString()) as unknown as
          { readonly jobJson: string } | undefined;
        if (row === undefined) {
          state.exec("COMMIT;");
          return undefined;
        }
        const current = EpisodicExtractionJobSchema.parse(JSON.parse(row.jobJson));
        const claimed = EpisodicExtractionJobSchema.parse({
          ...current,
          revision: current.revision + 1,
          status: "running",
          attempts: current.attempts + 1,
          totalAttempts: current.totalAttempts + 1,
          retryAt: undefined,
          leaseUntil: new Date(now.getTime() + 5 * 60_000).toISOString(),
          updatedAt: now.toISOString(),
        });
        writeJob(claimed);
        state.exec("COMMIT;");
        return claimed;
      } catch (error) {
        rollback(state);
        throw error;
      }
    },

    async readEvidence(executionId) {
      const current = state
        .prepare(
          "SELECT envelope_json AS envelopeJson FROM evidence WHERE execution_id = ? ORDER BY occurred_at, message_id",
        )
        .all(executionId) as unknown as readonly { readonly envelopeJson: string }[];
      const previous = data
        .prepare(
          `SELECT e.envelope_json AS envelopeJson FROM episode_evidence e
           JOIN episodes p ON p.id = e.episode_id WHERE p.execution_id = ?
           ORDER BY e.occurred_at, e.evidence_id`,
        )
        .all(executionId) as unknown as readonly { readonly envelopeJson: string }[];
      const unique = new Map<string, MemoryEvidenceEnvelope>();
      for (const row of [...previous, ...current]) {
        const envelope = MemoryEvidenceEnvelopeSchema.parse(JSON.parse(row.envelopeJson));
        unique.set(envelope.messageId, envelope);
      }
      return [...unique.values()].slice(-2_000);
    },

    async readOmissionStats(executionId) {
      return readOmissionStats(state, executionId);
    },

    async getByExecution(executionId) {
      return readEpisodeBy(data, "execution_id", executionId);
    },

    async get(id) {
      return readEpisodeBy(data, "id", id);
    },

    async history(id) {
      return readEpisodeRows(
        data
          .prepare(
            "SELECT record_json AS recordJson FROM episode_revisions WHERE episode_id = ? ORDER BY revision DESC",
          )
          .all(id),
      );
    },

    async list() {
      return readEpisodeRows(
        data
          .prepare("SELECT record_json AS recordJson FROM episodes ORDER BY updated_at DESC, id")
          .all(),
      );
    },

    async listForRecall(scope) {
      const access = recallPredicate("episodes", scope);
      return readEpisodeRows(
        data
          .prepare(
            `SELECT record_json AS recordJson FROM episodes
             WHERE status = 'active' AND ${access.sql}
             ORDER BY updated_at DESC, id`,
          )
          .all(...access.parameters),
      );
    },

    async searchForRecall(scope, query, limit) {
      const normalizedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
      const escapedQuery = query
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_");
      const access = recallPredicate("episodes", scope);
      const rows = data
        .prepare(
          `SELECT record_json AS recordJson FROM episodes
           WHERE status = 'active' AND lower(record_json) LIKE lower(?) ESCAPE '\\'
             AND ${access.sql}
           ORDER BY updated_at DESC, id LIMIT ?`,
        )
        .all(`%${escapedQuery}%`, ...access.parameters, normalizedLimit);
      return readEpisodeRows(rows);
    },

    async getForRecall(scope, id) {
      const access = recallPredicate("episodes", scope);
      const row = data
        .prepare(
          `SELECT record_json AS recordJson FROM episodes
           WHERE id = ? AND status = 'active' AND ${access.sql}`,
        )
        .get(id, ...access.parameters) as { readonly recordJson: string } | undefined;
      return row === undefined
        ? undefined
        : EpisodicMemoryRecordSchema.parse(JSON.parse(row.recordJson));
    },

    async getEvidenceForRecall(scope, messageId) {
      const access = recallPredicate("p", scope);
      const row = data
        .prepare(
          `SELECT e.envelope_json AS envelopeJson FROM episode_evidence e
           JOIN episodes p ON p.id = e.episode_id
           WHERE e.evidence_id = ? AND p.status = 'active' AND ${access.sql}
           LIMIT 1`,
        )
        .get(messageId, ...access.parameters) as { readonly envelopeJson: string } | undefined;
      return row === undefined
        ? undefined
        : MemoryEvidenceEnvelopeSchema.parse(JSON.parse(row.envelopeJson));
    },

    async getEvidence(messageId) {
      const row = data
        .prepare(
          "SELECT envelope_json AS envelopeJson FROM episode_evidence WHERE evidence_id = ? LIMIT 1",
        )
        .get(messageId) as { readonly envelopeJson: string } | undefined;
      return row === undefined
        ? undefined
        : MemoryEvidenceEnvelopeSchema.parse(JSON.parse(row.envelopeJson));
    },

    async completeRetained(input) {
      if (isDeletedExecution(state, input.job.executionId)) return;
      const record = EpisodicMemoryRecordSchema.parse(input.record);
      data.exec("BEGIN IMMEDIATE;");
      try {
        if (hasTombstone(data, record.id)) {
          data.exec("COMMIT;");
          completeRetainedJob(state, input.job, input.now);
          return;
        }
        data
          .prepare(
            `INSERT INTO episodes(id, execution_id, revision, status, updated_at, record_json)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, status=excluded.status,
               updated_at=excluded.updated_at, record_json=excluded.record_json`,
          )
          .run(
            record.id,
            record.executionId,
            record.revision,
            record.status,
            record.updatedAt,
            JSON.stringify(record),
          );
        data
          .prepare(
            "INSERT OR IGNORE INTO episode_revisions(episode_id, revision, record_json) VALUES (?, ?, ?)",
          )
          .run(record.id, record.revision, JSON.stringify(record));
        const insert = data.prepare(
          `INSERT OR REPLACE INTO episode_evidence(episode_id, evidence_id, occurred_at, envelope_json)
           VALUES (?, ?, ?, ?)`,
        );
        const citedEvidence = new Set(record.evidenceRefs);
        for (const envelope of input.evidence) {
          if (!citedEvidence.has(envelope.messageId)) continue;
          insert.run(record.id, envelope.messageId, envelope.occurredAt, JSON.stringify(envelope));
        }
        data.exec("COMMIT;");
      } catch (error) {
        rollback(data);
        throw error;
      }
      completeRetainedJob(state, input.job, input.now);
    },

    async tightenAccess(input) {
      return governEpisode(data, "tighten-access", input, (current) => ({
        ...current,
        ...(input.bindings === undefined
          ? {}
          : { bindings: assertMemoryBindingsTightened(current.bindings, input.bindings) }),
        ...(input.visibility === undefined
          ? {}
          : { visibility: assertMemoryVisibilityTightened(current.visibility, input.visibility) }),
        revision: current.revision + 1,
        updatedAt: input.now.toISOString(),
      }));
    },

    async invalidate(input) {
      return governEpisode(data, "invalidate", input, (current) => ({
        ...current,
        revision: current.revision + 1,
        status: "invalidated",
        invalidatedAt: input.now.toISOString(),
        updatedAt: input.now.toISOString(),
      }));
    },

    async forget(input) {
      data.exec("BEGIN IMMEDIATE;");
      try {
        const current = readEpisodeBy(data, "id", input.id);
        if (current === undefined) throw new Error("episodic_memory_not_found");
        assertExpectedRevision(input.expectedRevision, current.revision, "episodic_memory");
        data.prepare("DELETE FROM episode_evidence WHERE episode_id = ?").run(input.id);
        data.prepare("DELETE FROM episode_revisions WHERE episode_id = ?").run(input.id);
        data.prepare("DELETE FROM governance_events WHERE episode_id = ?").run(input.id);
        data.prepare("DELETE FROM episodes WHERE id = ?").run(input.id);
        data
          .prepare(
            "INSERT INTO tombstones(id, last_revision, forgotten_at, tombstone_json) VALUES (?, ?, ?, ?)",
          )
          .run(
            input.id,
            current.revision,
            input.now.toISOString(),
            JSON.stringify(createMemoryTombstone("episodic", current.id, current.revision, input)),
          );
        data.exec("COMMIT;");
      } catch (error) {
        rollback(data);
        throw error;
      }
    },

    async completeRejected(job, reason, now) {
      if (isDeletedExecution(state, job.executionId)) return;
      state.exec("BEGIN IMMEDIATE;");
      try {
        finishJob(state, job, "rejected", now);
        state.prepare("DELETE FROM evidence WHERE execution_id = ?").run(job.executionId);
        incrementCounter(state, "rejected_total");
        incrementCounter(state, `rejected_${reason.replaceAll("-", "_")}`);
        state.exec("COMMIT;");
      } catch (error) {
        rollback(state);
        throw error;
      }
    },

    async fail(input) {
      if (isDeletedExecution(state, input.job.executionId)) return;
      const attempts = input.job.attempts;
      const needsAttention = input.retry === "configuration" || attempts >= 3;
      const delay = attempts <= 1 ? 60_000 : attempts === 2 ? 5 * 60_000 : 15 * 60_000;
      writeJob(
        EpisodicExtractionJobSchema.parse({
          ...input.job,
          revision: input.job.revision + 1,
          status: needsAttention ? "needs_attention" : "pending",
          leaseUntil: undefined,
          ...(needsAttention
            ? { retryAt: undefined }
            : { retryAt: new Date(input.now.getTime() + delay).toISOString() }),
          lastErrorCode: input.errorCode,
          ...(needsAttention
            ? {
                failureClass:
                  input.retry === "configuration" ? "configuration" : "transient-exhausted",
                attentionSince: input.job.attentionSince ?? input.now.toISOString(),
              }
            : {}),
          updatedAt: input.now.toISOString(),
        }),
      );
    },

    async wakeNeedsAttention(now, reason = "configuration") {
      const rows = state
        .prepare("SELECT job_json AS jobJson FROM jobs WHERE status = 'needs_attention'")
        .all() as unknown as readonly { readonly jobJson: string }[];
      for (const row of rows) {
        const job = EpisodicExtractionJobSchema.parse(JSON.parse(row.jobJson));
        if (reason === "configuration" && job.failureClass !== "configuration") continue;
        writeJob(
          EpisodicExtractionJobSchema.parse({
            ...job,
            revision: job.revision + 1,
            status: "pending",
            attempts: 0,
            retryAt: now.toISOString(),
            lastErrorCode: undefined,
            failureClass: undefined,
            attentionSince: undefined,
            updatedAt: now.toISOString(),
          }),
        );
      }
    },

    async retryJob(input) {
      const job = readJob(state, input.id);
      if (job === undefined) throw new Error("memory_extraction_job_not_found");
      if (job.revision !== input.expectedRevision) {
        throw new Error("memory_extraction_job_revision_conflict");
      }
      if (job.status !== "needs_attention") throw new Error("memory_extraction_job_not_retryable");
      writeJob(
        EpisodicExtractionJobSchema.parse({
          ...job,
          revision: job.revision + 1,
          status: "pending",
          attempts: 0,
          retryAt: input.now.toISOString(),
          lastErrorCode: undefined,
          failureClass: undefined,
          attentionSince: undefined,
          updatedAt: input.now.toISOString(),
        }),
      );
    },

    async listExtractionJobs() {
      return readJobRows(state);
    },

    async maintain(now) {
      const result = maintainJobs(state, now);
      const cutoff = now.getTime() - DEFAULT_MEMORY_STORAGE_POLICY.jobRecordRetentionMs;
      await Promise.all([
        ...EPISODIC_DATA_STORAGE_MIGRATIONS.map((step) =>
          removeExpiredSqliteMigrationBackup(dataPath, step.fromVersion, cutoff),
        ),
        ...EPISODIC_JOB_STORAGE_MIGRATIONS.map((step) =>
          removeExpiredSqliteMigrationBackup(statePath, step.fromVersion, cutoff),
        ),
      ]);
      return result;
    },

    async deleteExecutionState(executionIds, now = new Date()) {
      deleteExecutionState(state, executionIds, now);
    },

    async inspect() {
      const counts = state
        .prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status")
        .all() as unknown as readonly { readonly status: string; readonly count: number }[];
      const byStatus = new Map(counts.map((row) => [row.status, row.count]));
      const counterRows = state
        .prepare("SELECT name, value FROM counters WHERE name LIKE 'rejected_%'")
        .all() as unknown as readonly { readonly name: string; readonly value: number }[];
      const counters = new Map(counterRows.map((row) => [row.name, row.value]));
      const episodes = data.prepare("SELECT COUNT(*) AS count FROM episodes").get() as unknown as {
        readonly count: number;
      };
      return {
        episodes: episodes.count,
        pending: byStatus.get("pending") ?? 0,
        running: byStatus.get("running") ?? 0,
        needsAttention: byStatus.get("needs_attention") ?? 0,
        expired: byStatus.get("expired") ?? 0,
        ...inspectEvidenceState(state),
        rejected: counters.get("rejected_total") ?? 0,
        rejectedByReason: {
          "low-value": counters.get("rejected_low_value") ?? 0,
          "insufficient-evidence": counters.get("rejected_insufficient_evidence") ?? 0,
          sensitive: counters.get("rejected_sensitive") ?? 0,
          policy: counters.get("rejected_policy") ?? 0,
        },
      };
    },

    close() {
      state.close();
      data.close();
    },
  };
}

export function episodicMemoryId(executionId: string): string {
  return `episode-${createHash("sha256").update(executionId).digest("hex").slice(0, 24)}`;
}

function extractionJobId(executionId: string): string {
  return `episodic-${createHash("sha256").update(executionId).digest("hex").slice(0, 24)}`;
}

function initializeData(database: DatabaseSync): void {
  const version = readVersion(database);
  if (version > 2) {
    database.close();
    throw new Error(`unsupported-state-version:pragma.memory-episodic-store/v${version}`);
  }
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS episodes_status_updated ON episodes(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS episode_evidence (
      episode_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      PRIMARY KEY (episode_id, evidence_id),
      FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS episode_revisions (
      episode_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (episode_id, revision)
    );
    CREATE TABLE IF NOT EXISTS governance_events (
      id TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tombstones (
      id TEXT PRIMARY KEY,
      last_revision INTEGER NOT NULL,
      forgotten_at TEXT NOT NULL,
      tombstone_json TEXT NOT NULL
    );
  `);
  if (version !== 0 && version !== 2) {
    throw new Error(`missing-adjacent-migration:pragma.memory-episodic-store/v${version}`);
  }
  database.exec("PRAGMA user_version = 2;");
}

function initializeState(database: DatabaseSync): void {
  assertVersion(database, "pragma.memory-episodic-jobs", 2);
  const version = readVersion(database);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS evidence (
      message_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      envelope_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS evidence_execution ON evidence(execution_id, occurred_at);
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL UNIQUE,
      terminal_message_id TEXT NOT NULL,
      status TEXT NOT NULL,
      retry_at TEXT,
      lease_until TEXT,
      job_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, retry_at, lease_until);
    CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS capture_stats (
      execution_id TEXT PRIMARY KEY,
      stats_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deleted_executions (
      execution_id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL
    );
  `);
  if (version !== 0 && version !== 2) {
    throw new Error(`missing-adjacent-migration:pragma.memory-episodic-jobs/v${version}`);
  }
  database.exec("PRAGMA user_version = 2;");
}

function assertVersion(database: DatabaseSync, family: string, current: number): void {
  const version = readVersion(database);
  if (version > current) {
    database.close();
    throw new Error(`unsupported-state-version:${family}/v${version}`);
  }
}

function readVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as unknown as {
    readonly user_version: number;
  };
  return row.user_version;
}

function readJob(database: DatabaseSync, id: string): EpisodicExtractionJob | undefined {
  const row = database.prepare("SELECT job_json AS jobJson FROM jobs WHERE id = ?").get(id) as
    { readonly jobJson: string } | undefined;
  return row === undefined ? undefined : EpisodicExtractionJobSchema.parse(JSON.parse(row.jobJson));
}

function readJobRows(database: DatabaseSync): EpisodicExtractionJob[] {
  const rows = database
    .prepare("SELECT job_json AS jobJson FROM jobs ORDER BY rowid DESC")
    .all() as unknown as readonly { readonly jobJson: string }[];
  return rows.map((row) => EpisodicExtractionJobSchema.parse(JSON.parse(row.jobJson)));
}

function compactEvidence(database: DatabaseSync, executionId: string): void {
  const rows = database
    .prepare(
      "SELECT envelope_json AS envelopeJson FROM evidence WHERE execution_id = ? ORDER BY occurred_at, message_id",
    )
    .all(executionId) as unknown as readonly { readonly envelopeJson: string }[];
  const evidence = rows.map((row) =>
    MemoryEvidenceEnvelopeSchema.parse(JSON.parse(row.envelopeJson)),
  );
  const selection = selectBoundedMemoryEvidence(evidence, {
    maxRecords: DEFAULT_MEMORY_STORAGE_POLICY.evidenceMaxRecordsPerExecution,
    maxBytes: DEFAULT_MEMORY_STORAGE_POLICY.evidenceMaxBytesPerExecution,
  });
  if (selection.omitted.length === 0) return;
  const remove = database.prepare("DELETE FROM evidence WHERE message_id = ?");
  for (const envelope of selection.omitted) remove.run(envelope.messageId);
  const stats = mergeMemoryEvidenceOmissionStats(
    readOmissionStats(database, executionId),
    selection.omittedStats,
  );
  database
    .prepare(
      `INSERT INTO capture_stats(execution_id, stats_json) VALUES (?, ?)
       ON CONFLICT(execution_id) DO UPDATE SET stats_json=excluded.stats_json`,
    )
    .run(executionId, JSON.stringify(stats));
}

function readOmissionStats(
  database: DatabaseSync,
  executionId: string,
): MemoryEvidenceOmissionStats {
  const row = database
    .prepare("SELECT stats_json AS statsJson FROM capture_stats WHERE execution_id = ?")
    .get(executionId) as { readonly statsJson: string } | undefined;
  return row === undefined
    ? EMPTY_MEMORY_EVIDENCE_OMISSION_STATS
    : MemoryEvidenceOmissionStatsSchema.parse(JSON.parse(row.statsJson));
}

function inspectEvidenceState(database: DatabaseSync): {
  readonly evidenceRecords: number;
  readonly evidenceBytes: number;
  readonly truncatedExecutions: number;
} {
  const evidence = database
    .prepare(
      "SELECT COUNT(*) AS records, COALESCE(SUM(length(CAST(envelope_json AS BLOB))), 0) AS bytes FROM evidence",
    )
    .get() as unknown as { readonly records: number; readonly bytes: number };
  const truncated = database
    .prepare("SELECT COUNT(*) AS count FROM capture_stats")
    .get() as unknown as { readonly count: number };
  return {
    evidenceRecords: evidence.records,
    evidenceBytes: evidence.bytes,
    truncatedExecutions: truncated.count,
  };
}

function maintainJobs(
  database: DatabaseSync,
  now: Date,
): { readonly expired: number; readonly deleted: number } {
  const timestamp = now.getTime();
  let expired = 0;
  let deleted = 0;
  database.exec("BEGIN IMMEDIATE;");
  try {
    for (const job of readJobRows(database)) {
      if (
        job.status === "needs_attention" &&
        job.attentionSince !== undefined &&
        timestamp - Date.parse(job.attentionSince) >=
          DEFAULT_MEMORY_STORAGE_POLICY.failedPayloadRetentionMs
      ) {
        const next = EpisodicExtractionJobSchema.parse({
          ...job,
          revision: job.revision + 1,
          status: "expired",
          expiredAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        database.prepare("DELETE FROM evidence WHERE execution_id = ?").run(job.executionId);
        database.prepare("DELETE FROM capture_stats WHERE execution_id = ?").run(job.executionId);
        database
          .prepare("UPDATE jobs SET status = 'expired', job_json = ? WHERE id = ?")
          .run(JSON.stringify(next), next.id);
        expired += 1;
        continue;
      }
      const terminalAt = job.status === "completed" ? job.completedAt : job.expiredAt;
      const retention =
        job.status === "completed"
          ? DEFAULT_MEMORY_STORAGE_POLICY.jobRecordRetentionMs
          : DEFAULT_MEMORY_STORAGE_POLICY.expiredDiagnosticRetentionMs;
      if (
        terminalAt !== undefined &&
        ["completed", "expired"].includes(job.status) &&
        timestamp - Date.parse(terminalAt) >= retention
      ) {
        database.prepare("DELETE FROM jobs WHERE id = ?").run(job.id);
        database.prepare("DELETE FROM capture_stats WHERE execution_id = ?").run(job.executionId);
        deleted += 1;
      }
    }
    database
      .prepare("DELETE FROM deleted_executions WHERE deleted_at <= ?")
      .run(
        new Date(timestamp - DEFAULT_MEMORY_STORAGE_POLICY.failedPayloadRetentionMs).toISOString(),
      );
    database.exec("COMMIT;");
    return { expired, deleted };
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function deleteExecutionState(
  database: DatabaseSync,
  executionIds: readonly string[],
  now: Date,
): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const markDeleted = database.prepare(
      `INSERT INTO deleted_executions(execution_id, deleted_at) VALUES (?, ?)
       ON CONFLICT(execution_id) DO UPDATE SET deleted_at=excluded.deleted_at`,
    );
    const deleteEvidence = database.prepare("DELETE FROM evidence WHERE execution_id = ?");
    const deleteStats = database.prepare("DELETE FROM capture_stats WHERE execution_id = ?");
    const deleteJobs = database.prepare("DELETE FROM jobs WHERE execution_id = ?");
    for (const executionId of new Set(executionIds)) {
      markDeleted.run(executionId, now.toISOString());
      deleteEvidence.run(executionId);
      deleteStats.run(executionId);
      deleteJobs.run(executionId);
    }
    database.exec("COMMIT;");
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function isDeletedExecution(database: DatabaseSync, executionId: string): boolean {
  return (
    database
      .prepare("SELECT 1 AS found FROM deleted_executions WHERE execution_id = ?")
      .get(executionId) !== undefined
  );
}

function finishJob(
  database: DatabaseSync,
  job: EpisodicExtractionJob,
  completion: "retained" | "rejected",
  now: Date,
): void {
  const completedAt = now.toISOString();
  const completed = EpisodicExtractionJobSchema.parse({
    ...job,
    revision: job.revision + 1,
    status: "completed",
    leaseUntil: undefined,
    retryAt: undefined,
    lastErrorCode: undefined,
    completion,
    completedAt,
    updatedAt: completedAt,
  });
  database
    .prepare(
      "UPDATE jobs SET status = ?, retry_at = NULL, lease_until = NULL, job_json = ? WHERE id = ?",
    )
    .run(completed.status, JSON.stringify(completed), completed.id);
}

function completeRetainedJob(database: DatabaseSync, job: EpisodicExtractionJob, now: Date): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    finishJob(database, job, "retained", now);
    database.prepare("DELETE FROM evidence WHERE execution_id = ?").run(job.executionId);
    database.exec("COMMIT;");
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function incrementCounter(database: DatabaseSync, name: string): void {
  database
    .prepare(
      `INSERT INTO counters(name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1`,
    )
    .run(name);
}

function readEpisodeBy(
  database: DatabaseSync,
  column: "id" | "execution_id",
  value: string,
): EpisodicMemoryRecord | undefined {
  const row = database
    .prepare(`SELECT record_json AS recordJson FROM episodes WHERE ${column} = ?`)
    .get(value) as { readonly recordJson: string } | undefined;
  return row === undefined
    ? undefined
    : EpisodicMemoryRecordSchema.parse(JSON.parse(row.recordJson));
}

function readEpisodeRows(rows: readonly unknown[]): EpisodicMemoryRecord[] {
  return (rows as readonly { readonly recordJson: string }[]).map((row) =>
    EpisodicMemoryRecordSchema.parse(JSON.parse(row.recordJson)),
  );
}

function recallPredicate(
  tableAlias: "episodes" | "p",
  scope: MemoryRecallScope,
): { readonly sql: string; readonly parameters: readonly string[] } {
  const refs = [scope.rootRef, scope.expertRef].filter(
    (ref, index, all) =>
      all.findIndex((candidate) => candidate.type === ref.type && candidate.id === ref.id) ===
      index,
  );
  const clauses = refs.map(
    () =>
      `EXISTS (
        SELECT 1 FROM json_each(${tableAlias}.record_json, '$.bindings') AS binding
        WHERE json_extract(binding.value, '$.consumerRef.type') = ?
          AND json_extract(binding.value, '$.consumerRef.id') = ?
          AND json_extract(binding.value, '$.recall') = 'allow'
      )`,
  );
  const principals = uniqueRefs([scope.rootRef, scope.expertRef, ...(scope.principalRefs ?? [])]);
  const principalClauses = principals.map(
    () =>
      `(json_extract(principal.value, '$.type') = ?
        AND json_extract(principal.value, '$.id') = ?)`,
  );
  return {
    sql: `(json_extract(${tableAlias}.record_json, '$.visibility.mode') != 'restricted'
        OR EXISTS (
          SELECT 1 FROM json_each(${tableAlias}.record_json, '$.visibility.principals') AS principal
          WHERE ${principalClauses.length === 0 ? "0" : principalClauses.join(" OR ")}
        ))
      AND (${clauses.join(" OR ")})`,
    parameters: [
      ...principals.flatMap((ref) => [ref.type, ref.id]),
      ...refs.flatMap((ref) => [ref.type, ref.id]),
    ],
  };
}

function governEpisode(
  database: DatabaseSync,
  action: string,
  input: EpisodicGovernanceInput,
  mutate: (current: EpisodicMemoryRecord) => EpisodicMemoryRecord,
): EpisodicMemoryRecord {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const current = readEpisodeBy(database, "id", input.id);
    if (current === undefined) throw new Error("episodic_memory_not_found");
    assertExpectedRevision(input.expectedRevision, current.revision, "episodic_memory");
    const next = EpisodicMemoryRecordSchema.parse(mutate(current));
    database
      .prepare(
        "UPDATE episodes SET revision = ?, status = ?, updated_at = ?, record_json = ? WHERE id = ?",
      )
      .run(next.revision, next.status, next.updatedAt, JSON.stringify(next), next.id);
    database
      .prepare("INSERT INTO episode_revisions(episode_id, revision, record_json) VALUES (?, ?, ?)")
      .run(next.id, next.revision, JSON.stringify(next));
    database
      .prepare(
        "INSERT INTO governance_events(id, episode_id, revision, event_json) VALUES (?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        next.id,
        next.revision,
        JSON.stringify({
          schemaVersion: "pragma.memory-governance-event/v1",
          module: "episodic",
          memoryId: next.id,
          previousRevision: current.revision,
          revision: next.revision,
          action,
          actorRef: input.actorRef,
          reason: input.reason,
          occurredAt: input.now.toISOString(),
        }),
      );
    database.exec("COMMIT;");
    return next;
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function assertExpectedRevision(expected: number, actual: number, family: string): void {
  if (expected !== actual) {
    throw new Error(`${family}_revision_conflict:${expected}:${actual}`);
  }
}

function hasTombstone(database: DatabaseSync, id: string): boolean {
  return database.prepare("SELECT 1 FROM tombstones WHERE id = ?").get(id) !== undefined;
}

function uniqueRefs<T extends { readonly type: string; readonly id: string }>(
  refs: readonly T[],
): T[] {
  return [...new Map(refs.map((ref) => [`${ref.type}\0${ref.id}`, ref])).values()];
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK;");
  } catch {
    // No transaction remained active.
  }
}

function tryClose(database: DatabaseSync): void {
  try {
    database.close();
  } catch {
    // The version guard may already have closed this database.
  }
}
