import type { DatabaseSync } from "node:sqlite";

import { EpisodicExtractionJobSchema } from "../../../../episodic/schema.ts";
import { initializeExtractionFailureAttempts } from "../../../../pipeline/extraction-failure-store.ts";
import { EpisodicExtractionJobV3Schema } from "../schemas/v3.ts";

export function migrateEpisodicJobsV3ToV4(database: DatabaseSync): void {
  const rows = database.prepare("SELECT id, job_json FROM jobs").all() as unknown as readonly {
    readonly id: string;
    readonly job_json: string;
  }[];
  database.exec("BEGIN IMMEDIATE;");
  try {
    initializeExtractionFailureAttempts(database);
    const update = database.prepare("UPDATE jobs SET job_json=? WHERE id=?");
    for (const row of rows) {
      const previous = EpisodicExtractionJobV3Schema.parse(JSON.parse(row.job_json));
      const migrated = EpisodicExtractionJobSchema.parse({
        ...previous,
        schemaVersion: "pragma.memory-extraction-job/v4",
      });
      update.run(JSON.stringify(migrated), row.id);
    }
    database.exec("PRAGMA user_version = 4; COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}
