import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  MemoryExtractionFailureAttemptSchema,
  type MemoryExtractionFailureAttempt,
  type MemoryExtractionFailureDiagnostic,
} from "@pragma/shared";

const MAX_FAILURE_ATTEMPTS_PER_JOB = 20;

export function initializeExtractionFailureAttempts(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS job_failure_attempts(
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      failed_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS job_failure_attempts_job
      ON job_failure_attempts(job_id, failed_at DESC, id DESC);
  `);
}

export function insertExtractionFailureAttempt(
  database: DatabaseSync,
  input: {
    readonly jobId: string;
    readonly jobRevision: number;
    readonly attempt: number;
    readonly diagnostic: MemoryExtractionFailureDiagnostic;
    readonly stack?: string | undefined;
  },
): MemoryExtractionFailureAttempt {
  const record = MemoryExtractionFailureAttemptSchema.parse({
    schemaVersion: "pragma.memory-extraction-failure-attempt/v1",
    id: randomUUID(),
    jobId: input.jobId,
    jobRevision: input.jobRevision,
    attempt: input.attempt,
    diagnostic: input.diagnostic,
    ...(input.stack === undefined ? {} : { stack: input.stack }),
  });
  database
    .prepare(
      "INSERT INTO job_failure_attempts(id, job_id, failed_at, record_json) VALUES (?, ?, ?, ?)",
    )
    .run(record.id, record.jobId, record.diagnostic.failedAt, JSON.stringify(record));
  database
    .prepare(
      `DELETE FROM job_failure_attempts WHERE job_id=? AND id NOT IN (
         SELECT id FROM job_failure_attempts WHERE job_id=?
         ORDER BY failed_at DESC, id DESC LIMIT ?
       )`,
    )
    .run(record.jobId, record.jobId, MAX_FAILURE_ATTEMPTS_PER_JOB);
  return record;
}

export function listExtractionFailureAttempts(
  database: DatabaseSync,
  jobId: string,
): readonly MemoryExtractionFailureAttempt[] {
  const rows = database
    .prepare(
      "SELECT record_json AS recordJson FROM job_failure_attempts WHERE job_id=? ORDER BY failed_at DESC, id DESC",
    )
    .all(jobId) as unknown as readonly { readonly recordJson: string }[];
  return rows.map((row) => MemoryExtractionFailureAttemptSchema.parse(JSON.parse(row.recordJson)));
}

export function deleteExtractionFailureAttempts(database: DatabaseSync, jobId: string): void {
  database.prepare("DELETE FROM job_failure_attempts WHERE job_id=?").run(jobId);
}
