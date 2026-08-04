import type { DatabaseSync } from "node:sqlite";

import { EpisodicMemoryRecordV2Schema } from "../schemas/v2.ts";
import { EpisodicMemoryRecordV3Schema } from "../schemas/v3.ts";

export function migrateEpisodicDataV2ToV3(database: DatabaseSync): void {
  const rows = database
    .prepare("SELECT id, record_json AS recordJson FROM episodes")
    .all() as unknown as readonly { id: string; recordJson: string }[];
  const revisions = database
    .prepare(
      "SELECT episode_id AS episodeId, revision, record_json AS recordJson FROM episode_revisions",
    )
    .all() as unknown as readonly {
    readonly episodeId: string;
    readonly revision: number;
    readonly recordJson: string;
  }[];
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec("ALTER TABLE episodes ADD COLUMN conversation_key TEXT;");
    database.exec(`
      CREATE TABLE episode_source_executions (
        episode_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        PRIMARY KEY (episode_id, execution_id),
        FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
      );
      CREATE INDEX episode_source_executions_execution
        ON episode_source_executions(execution_id, episode_id);
    `);
    for (const row of rows) {
      const previous = EpisodicMemoryRecordV2Schema.parse(JSON.parse(row.recordJson));
      const migrated = EpisodicMemoryRecordV3Schema.parse({
        ...previous,
        schemaVersion: "pragma.memory-episodic/v3",
        conversationRef: { type: "pragma.execution", id: previous.executionId },
        sourceExecutionIds: [previous.executionId],
        sourceUpdatedAt: previous.updatedAt,
      });
      database
        .prepare("UPDATE episodes SET conversation_key = ?, record_json = ? WHERE id = ?")
        .run(`pragma.execution\0${previous.executionId}`, JSON.stringify(migrated), row.id);
      database
        .prepare("INSERT INTO episode_source_executions(episode_id, execution_id) VALUES (?, ?)")
        .run(row.id, previous.executionId);
    }
    const updateRevision = database.prepare(
      "UPDATE episode_revisions SET record_json = ? WHERE episode_id = ? AND revision = ?",
    );
    for (const row of revisions) {
      const previous = EpisodicMemoryRecordV2Schema.parse(JSON.parse(row.recordJson));
      const migrated = EpisodicMemoryRecordV3Schema.parse({
        ...previous,
        schemaVersion: "pragma.memory-episodic/v3",
        conversationRef: { type: "pragma.execution", id: previous.executionId },
        sourceExecutionIds: [previous.executionId],
        sourceUpdatedAt: previous.updatedAt,
      });
      updateRevision.run(JSON.stringify(migrated), row.episodeId, row.revision);
    }
    database.exec(
      "CREATE UNIQUE INDEX episodes_conversation ON episodes(conversation_key); PRAGMA user_version = 3; COMMIT;",
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
