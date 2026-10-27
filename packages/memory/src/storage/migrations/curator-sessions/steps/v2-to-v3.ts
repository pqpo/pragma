import type { DatabaseSync } from "node:sqlite";
import { CuratorSessionV2Schema } from "../schemas/v2.ts";
import { CuratorSessionV3Schema } from "../schemas/v3.ts";

export function migrateCuratorSessionsV2ToV3(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare("SELECT key, state_json FROM sessions").all() as {
      key: string;
      state_json: string;
    }[];
    for (const row of rows) {
      const old = CuratorSessionV2Schema.parse(JSON.parse(row.state_json));
      const next = CuratorSessionV3Schema.parse({
        ...old,
        schemaVersion: "pragma.memory-curator-session/v3",
        toolContractVersion: 1,
      });
      db.prepare("UPDATE sessions SET state_json = ? WHERE key = ?").run(
        JSON.stringify(next),
        row.key,
      );
    }
    db.exec("PRAGMA user_version = 3; COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
