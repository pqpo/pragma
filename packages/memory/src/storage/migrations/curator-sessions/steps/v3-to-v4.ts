import type { DatabaseSync } from "node:sqlite";
import { CuratorSessionV3Schema } from "../schemas/v3.ts";
import { State } from "../../../../pipeline/extraction-session/schema.ts";

export function migrateCuratorSessionsV3ToV4(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare("SELECT key, state_json FROM sessions").all() as {
      key: string;
      state_json: string;
    }[];
    for (const row of rows) {
      const old = CuratorSessionV3Schema.parse(JSON.parse(row.state_json));
      const pending = old.pendingContinuation;
      // The historical writer used version 8 with variant 'a'. Mission rejected
      // these before command persistence, so there is no accepted receipt to remap.
      // Keep every other bit stable so interrupted migrations replay identically.
      if (
        pending !== undefined &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/.test(pending.requestId)
      ) {
        pending.requestId = `${pending.requestId.slice(0, 14)}4${pending.requestId.slice(15)}`;
      }
      const next = State.parse({ ...old, schemaVersion: "pragma.memory-curator-session/v4" });
      db.prepare("UPDATE sessions SET state_json = ? WHERE key = ?").run(
        JSON.stringify(next),
        row.key,
      );
    }
    db.exec("PRAGMA user_version = 4; COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
