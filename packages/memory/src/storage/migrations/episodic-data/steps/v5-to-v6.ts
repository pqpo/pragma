import type { DatabaseSync } from "node:sqlite";

export function initializeEpisodicLearningNotifications(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS episode_evidence (
    episode_id TEXT NOT NULL, evidence_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
    envelope_json TEXT NOT NULL, PRIMARY KEY(episode_id,evidence_id),
    FOREIGN KEY(episode_id) REFERENCES episodes(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS learning_notifications (
    root_ref_json TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 1, learning_eligible INTEGER NOT NULL DEFAULT 0
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
      INSERT INTO learning_notifications(root_ref_json,generation,learning_eligible)
      SELECT value,(SELECT sequence FROM learning_clock WHERE singleton=1),
        EXISTS(SELECT 1 FROM episode_evidence WHERE episode_id=${row}.id) AND
        NOT EXISTS(SELECT 1 FROM episode_evidence WHERE episode_id=${row}.id AND json_extract(envelope_json,'$.policySnapshot.learning')='disabled')
      FROM ${roots} WHERE 1
      ON CONFLICT(root_ref_json) DO UPDATE SET generation=excluded.generation,learning_eligible=MAX(learning_eligible,excluded.learning_eligible);
    END;`);
  }
}
export function migrateEpisodicDataV5ToV6(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    initializeEpisodicLearningNotifications(db);
    db.exec(`UPDATE learning_clock SET sequence=1 WHERE singleton=1;
      INSERT OR IGNORE INTO learning_notifications(root_ref_json,generation,learning_eligible)
      SELECT j.value,1,MAX(EXISTS(SELECT 1 FROM episode_evidence WHERE episode_id=e.id) AND
        NOT EXISTS(SELECT 1 FROM episode_evidence WHERE episode_id=e.id AND json_extract(envelope_json,'$.policySnapshot.learning')='disabled'))
      FROM episodes e,json_each(e.record_json,'$.rootRefs') j GROUP BY j.value;
      PRAGMA user_version=6; COMMIT;`);
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
