import type { DatabaseSync } from "node:sqlite";

import { initializeExtractionFailureAttempts } from "../../../../pipeline/extraction-failure-store.ts";
import { SemanticExtractionJobSchema } from "../../../../semantic/schema.ts";
import { SemanticExtractionJobV3Schema } from "../schemas/v3.ts";

export function migrateSemanticJobsV3ToV4(database: DatabaseSync): void {
  const rows = database.prepare("SELECT id, job_json FROM jobs").all() as unknown as readonly {
    readonly id: string;
    readonly job_json: string;
  }[];
  database.exec("BEGIN IMMEDIATE;");
  try {
    initializeExtractionFailureAttempts(database);
    const update = database.prepare("UPDATE jobs SET job_json=? WHERE id=?");
    for (const row of rows) {
      const previous = SemanticExtractionJobV3Schema.parse(JSON.parse(row.job_json));
      const migrated = SemanticExtractionJobSchema.parse({
        ...previous,
        schemaVersion: "pragma.memory-semantic-job/v4",
      });
      update.run(JSON.stringify(migrated), row.id);
    }
    database.exec("PRAGMA user_version = 4; COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}
