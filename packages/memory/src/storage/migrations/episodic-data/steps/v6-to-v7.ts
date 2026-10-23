import type { DatabaseSync } from "node:sqlite";

/** Projection changes wake a rescan; they never grant permission to learn a source. */
export function initializeEpisodicLearningNotificationsV7(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS learning_notifications (
    root_ref_json TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 1,
    learning_eligible INTEGER NOT NULL DEFAULT 0, source_changed INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS learning_clock (singleton INTEGER PRIMARY KEY CHECK(singleton=1), sequence INTEGER NOT NULL);
  INSERT OR IGNORE INTO learning_clock VALUES(1,0);`);
  for (const [event, row] of [
    ["INSERT", "NEW"],
    ["UPDATE", "NEW"],
    ["DELETE", "OLD"],
  ] as const) {
    const roots =
      event === "UPDATE"
        ? "(SELECT value FROM json_each(NEW.record_json,'$.rootRefs') UNION SELECT value FROM json_each(OLD.record_json,'$.rootRefs'))"
        : `json_each(${row}.record_json,'$.rootRefs')`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS learning_${event.toLowerCase()} AFTER ${event} ON episodes BEGIN
      UPDATE learning_clock SET sequence=sequence+1 WHERE singleton=1;
      INSERT INTO learning_notifications(root_ref_json,generation,learning_eligible,source_changed)
      SELECT value,(SELECT sequence FROM learning_clock WHERE singleton=1),
        EXISTS(SELECT 1 FROM episode_evidence WHERE episode_id=${row}.id) AND
        NOT EXISTS(SELECT 1 FROM episode_evidence WHERE episode_id=${row}.id AND json_extract(envelope_json,'$.policySnapshot.learning')='disabled'),
        ${event === "INSERT" ? 0 : 1}
      FROM ${roots} WHERE 1
      ON CONFLICT(root_ref_json) DO UPDATE SET generation=excluded.generation,
        learning_eligible=MAX(learning_eligible,excluded.learning_eligible),source_changed=MAX(source_changed,excluded.source_changed);
    END;`);
  }
}

export function migrateEpisodicDataV6ToV7(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    // V6 did not distinguish a deletion from captured denial. Rescan pending roots
    // without changing the captured permission flag; readers still filter every source.
    db.exec(`ALTER TABLE learning_notifications ADD COLUMN source_changed INTEGER NOT NULL DEFAULT 0;
      UPDATE learning_clock SET sequence=sequence+1 WHERE singleton=1;
      UPDATE learning_notifications SET source_changed=1,generation=(SELECT sequence FROM learning_clock WHERE singleton=1);
      DROP TRIGGER learning_insert; DROP TRIGGER learning_update; DROP TRIGGER learning_delete;`);
    initializeEpisodicLearningNotificationsV7(db);
    db.exec("PRAGMA user_version=7; COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
