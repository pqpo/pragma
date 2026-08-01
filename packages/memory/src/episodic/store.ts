import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths } from "@pragma/core";
import { MemoryEvidenceEnvelopeSchema, type MemoryEvidenceEnvelope } from "@pragma/shared";

import {
  EpisodicExtractionJobSchema,
  EpisodicMemoryRecordSchema,
  type EpisodicExtractionJob,
  type EpisodicMemoryRecord,
} from "./schema.ts";

export interface EpisodicMemoryStoreDiagnostic {
  readonly episodes: number;
  readonly pending: number;
  readonly running: number;
  readonly needsAttention: number;
  readonly rejectedLowValue: number;
}

export interface EpisodicMemoryStore {
  ingest(envelopes: readonly MemoryEvidenceEnvelope[]): Promise<void>;
  claimDueJob(now: Date): Promise<EpisodicExtractionJob | undefined>;
  readEvidence(executionId: string): Promise<readonly MemoryEvidenceEnvelope[]>;
  getEvidence(messageId: string): Promise<MemoryEvidenceEnvelope | undefined>;
  getByExecution(executionId: string): Promise<EpisodicMemoryRecord | undefined>;
  get(id: string): Promise<EpisodicMemoryRecord | undefined>;
  list(): Promise<readonly EpisodicMemoryRecord[]>;
  search(query: string, limit: number): Promise<readonly EpisodicMemoryRecord[]>;
  completeRetained(input: {
    readonly job: EpisodicExtractionJob;
    readonly record: EpisodicMemoryRecord;
    readonly evidence: readonly MemoryEvidenceEnvelope[];
  }): Promise<void>;
  completeRejected(job: EpisodicExtractionJob): Promise<void>;
  fail(input: {
    readonly job: EpisodicExtractionJob;
    readonly errorCode: string;
    readonly now: Date;
    readonly retry: "transient" | "configuration";
  }): Promise<void>;
  wakeNeedsAttention(now: Date): Promise<void>;
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
    initializeData(data);
    initializeState(state);
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
        for (const raw of envelopes) {
          const envelope = MemoryEvidenceEnvelopeSchema.parse(raw);
          const executionId = envelope.correlationId;
          if (executionId === undefined) continue;
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
              schemaVersion: "pragma.memory-extraction-job/v1",
              id,
              executionId,
              terminalMessageId: envelope.messageId,
              status: "pending",
              attempts: 0,
              updatedAt: envelope.occurredAt,
            }),
          );
        }
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
          | { readonly jobJson: string }
          | undefined;
        if (row === undefined) {
          state.exec("COMMIT;");
          return undefined;
        }
        const current = EpisodicExtractionJobSchema.parse(JSON.parse(row.jobJson));
        const claimed = EpisodicExtractionJobSchema.parse({
          ...current,
          status: "running",
          attempts: current.attempts + 1,
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

    async getEvidence(messageId) {
      const current = state
        .prepare("SELECT envelope_json AS envelopeJson FROM evidence WHERE message_id = ?")
        .get(messageId) as { readonly envelopeJson: string } | undefined;
      const retained = data
        .prepare(
          "SELECT envelope_json AS envelopeJson FROM episode_evidence WHERE evidence_id = ? LIMIT 1",
        )
        .get(messageId) as { readonly envelopeJson: string } | undefined;
      const row = current ?? retained;
      return row === undefined
        ? undefined
        : MemoryEvidenceEnvelopeSchema.parse(JSON.parse(row.envelopeJson));
    },

    async getByExecution(executionId) {
      return readEpisodeBy(data, "execution_id", executionId);
    },

    async get(id) {
      return readEpisodeBy(data, "id", id);
    },

    async list() {
      return readEpisodeRows(
        data
          .prepare("SELECT record_json AS recordJson FROM episodes ORDER BY updated_at DESC, id")
          .all(),
      );
    },

    async search(query, limit) {
      const normalizedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
      const escapedQuery = query
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_");
      const rows = data
        .prepare(
          `SELECT record_json AS recordJson FROM episodes
           WHERE status = 'active' AND lower(record_json) LIKE lower(?) ESCAPE '\\'
           ORDER BY updated_at DESC, id LIMIT ?`,
        )
        .all(`%${escapedQuery}%`, normalizedLimit);
      return readEpisodeRows(rows);
    },

    async completeRetained(input) {
      const record = EpisodicMemoryRecordSchema.parse(input.record);
      data.exec("BEGIN IMMEDIATE;");
      try {
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
        const insert = data.prepare(
          `INSERT OR REPLACE INTO episode_evidence(episode_id, evidence_id, occurred_at, envelope_json)
           VALUES (?, ?, ?, ?)`,
        );
        for (const envelope of input.evidence) {
          insert.run(record.id, envelope.messageId, envelope.occurredAt, JSON.stringify(envelope));
        }
        data.exec("COMMIT;");
      } catch (error) {
        rollback(data);
        throw error;
      }
      finishJob(state, input.job, "retained");
      state.prepare("DELETE FROM evidence WHERE execution_id = ?").run(input.job.executionId);
    },

    async completeRejected(job) {
      finishJob(state, job, "rejected");
      state.prepare("DELETE FROM evidence WHERE execution_id = ?").run(job.executionId);
      state
        .prepare(
          `INSERT INTO counters(name, value) VALUES ('rejected_low_value', 1)
           ON CONFLICT(name) DO UPDATE SET value = value + 1`,
        )
        .run();
    },

    async fail(input) {
      const attempts = input.job.attempts;
      const needsAttention = input.retry === "configuration" || attempts >= 3;
      const delay = attempts <= 1 ? 60_000 : attempts === 2 ? 5 * 60_000 : 15 * 60_000;
      writeJob(
        EpisodicExtractionJobSchema.parse({
          ...input.job,
          status: needsAttention ? "needs_attention" : "pending",
          leaseUntil: undefined,
          ...(needsAttention
            ? { retryAt: undefined }
            : { retryAt: new Date(input.now.getTime() + delay).toISOString() }),
          lastErrorCode: input.errorCode,
          updatedAt: input.now.toISOString(),
        }),
      );
    },

    async wakeNeedsAttention(now) {
      const rows = state
        .prepare("SELECT job_json AS jobJson FROM jobs WHERE status = 'needs_attention'")
        .all() as unknown as readonly { readonly jobJson: string }[];
      for (const row of rows) {
        const job = EpisodicExtractionJobSchema.parse(JSON.parse(row.jobJson));
        writeJob(
          EpisodicExtractionJobSchema.parse({
            ...job,
            status: "pending",
            retryAt: now.toISOString(),
            lastErrorCode: undefined,
            updatedAt: now.toISOString(),
          }),
        );
      }
    },

    async inspect() {
      const counts = state
        .prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status")
        .all() as unknown as readonly { readonly status: string; readonly count: number }[];
      const byStatus = new Map(counts.map((row) => [row.status, row.count]));
      const rejected = state
        .prepare("SELECT value FROM counters WHERE name = 'rejected_low_value'")
        .get() as unknown as { readonly value: number } | undefined;
      const episodes = data.prepare("SELECT COUNT(*) AS count FROM episodes").get() as unknown as {
        readonly count: number;
      };
      return {
        episodes: episodes.count,
        pending: byStatus.get("pending") ?? 0,
        running: byStatus.get("running") ?? 0,
        needsAttention: byStatus.get("needs_attention") ?? 0,
        rejectedLowValue: rejected?.value ?? 0,
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
  assertVersion(database, "pragma.memory-episodic-store");
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
    PRAGMA user_version = 1;
  `);
}

function initializeState(database: DatabaseSync): void {
  assertVersion(database, "pragma.memory-episodic-jobs");
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
    PRAGMA user_version = 1;
  `);
}

function assertVersion(database: DatabaseSync, family: string): void {
  const row = database.prepare("PRAGMA user_version").get() as unknown as {
    readonly user_version: number;
  };
  if (row.user_version > 1) {
    database.close();
    throw new Error(`unsupported-state-version:${family}/v${row.user_version}`);
  }
}

function readJob(database: DatabaseSync, id: string): EpisodicExtractionJob | undefined {
  const row = database.prepare("SELECT job_json AS jobJson FROM jobs WHERE id = ?").get(id) as
    | { readonly jobJson: string }
    | undefined;
  return row === undefined ? undefined : EpisodicExtractionJobSchema.parse(JSON.parse(row.jobJson));
}

function finishJob(
  database: DatabaseSync,
  job: EpisodicExtractionJob,
  completion: "retained" | "rejected",
): void {
  const completed = EpisodicExtractionJobSchema.parse({
    ...job,
    status: "completed",
    leaseUntil: undefined,
    retryAt: undefined,
    lastErrorCode: undefined,
    completion,
    updatedAt: new Date().toISOString(),
  });
  database
    .prepare(
      "UPDATE jobs SET status = ?, retry_at = NULL, lease_until = NULL, job_json = ? WHERE id = ?",
    )
    .run(completed.status, JSON.stringify(completed), completed.id);
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
