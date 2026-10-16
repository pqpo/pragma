import type { DatabaseSync } from "node:sqlite";
import { CuratorSessionV1Schema } from "../schemas/v1.ts";
import { State } from "../../../../pipeline/extraction-session/schema.ts";

export function migrateCuratorSessionsV1ToV2(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare("SELECT key, state_json FROM sessions").all() as {
      key: string;
      state_json: string;
    }[];
    for (const row of rows) {
      const old = CuratorSessionV1Schema.parse(JSON.parse(row.state_json));
      const mission = db
        .prepare(
          "SELECT mission_id FROM missions WHERE session_key = ? ORDER BY mission_id LIMIT 1",
        )
        .get(row.key) as { mission_id: string } | undefined;
      const next = State.parse({
        ...old,
        schemaVersion: "pragma.memory-curator-session/v2",
        results: old.output === undefined ? {} : { [old.module]: old.output },
        resultProvenance:
          old.output === undefined || old.provenance === undefined
            ? {}
            : { [old.module]: old.provenance },
        continuations: 0,
        admitted: mission !== undefined,
        retryGeneration: 0,
        contextTypes: [old.module],
        restartPending: false,
        ...(mission === undefined ? {} : { missionId: mission.mission_id }),
      });
      db.prepare("UPDATE sessions SET state_json = ? WHERE key = ?").run(
        JSON.stringify(next),
        row.key,
      );
    }
    db.exec("PRAGMA user_version = 2; COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
