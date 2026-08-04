import type { DatabaseSync } from "node:sqlite";

import { SemanticExtractionJobV2Schema } from "../schemas/v2.ts";
import { SemanticExtractionJobV3Schema } from "../schemas/v3.ts";

const STABLE_ERROR_CODE = /^[a-z][a-z0-9_.-]{0,199}$/;

export function migrateSemanticJobsV2ToV3(database: DatabaseSync): void {
  const rows = database
    .prepare("SELECT id, job_json AS jobJson FROM jobs")
    .all() as unknown as readonly { id: string; jobJson: string }[];
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec(`
      ALTER TABLE jobs ADD COLUMN conversation_key TEXT;
      CREATE TABLE conversation_activity (
        conversation_key TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    for (const row of rows) {
      const previous = SemanticExtractionJobV2Schema.parse(JSON.parse(row.jobJson));
      const malformedAttention =
        previous.status === "needs_attention" &&
        (previous.lastErrorCode === undefined || !STABLE_ERROR_CODE.test(previous.lastErrorCode));
      const migrated = SemanticExtractionJobV3Schema.parse({
        ...previous,
        schemaVersion: "pragma.memory-semantic-job/v3",
        revision: previous.revision + 1,
        conversationRef: { type: "pragma.execution", id: previous.executionId },
        sourceExecutionIds: [previous.executionId],
        sourceUpdatedAt: previous.updatedAt,
        inputWatermark: previous.terminalMessageId,
        ...(malformedAttention
          ? {
              status: "pending",
              attempts: 0,
              retryAt: previous.updatedAt,
              leaseUntil: undefined,
              lastErrorCode: undefined,
              failureClass: undefined,
              attentionSince: undefined,
            }
          : {}),
      });
      const key = `pragma.execution\0${previous.executionId}`;
      database
        .prepare(
          "UPDATE jobs SET conversation_key = ?, status = ?, retry_at = ?, lease_until = ?, job_json = ? WHERE id = ?",
        )
        .run(
          key,
          migrated.status,
          migrated.retryAt ?? null,
          migrated.leaseUntil ?? null,
          JSON.stringify(migrated),
          row.id,
        );
    }
    database.exec(
      "CREATE UNIQUE INDEX semantic_jobs_conversation ON jobs(conversation_key); PRAGMA user_version = 3; COMMIT;",
    );
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      /* no transaction */
    }
    throw error;
  }
}
