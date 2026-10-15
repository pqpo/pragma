-- Written by createSemanticMemoryStore at git 6aeca6e8; dumped without schema edits.
BEGIN TRANSACTION;
CREATE TABLE applied_jobs (
      job_id TEXT NOT NULL,
      input_watermark TEXT NOT NULL,
      terminal_message_id TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (job_id, input_watermark)
    );
CREATE TABLE current_facts (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
CREATE TABLE evidence (
      message_id TEXT PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      envelope_json TEXT NOT NULL
    );
CREATE TABLE fact_evidence (
      fact_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      PRIMARY KEY (fact_id, evidence_id),
      FOREIGN KEY (fact_id) REFERENCES current_facts(id) ON DELETE CASCADE,
      FOREIGN KEY (evidence_id) REFERENCES evidence(message_id) ON DELETE CASCADE
    );
CREATE TABLE fact_revisions (
      fact_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (fact_id, revision)
    );
CREATE TABLE governance_events (
      id TEXT PRIMARY KEY,
      fact_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_json TEXT NOT NULL
    );
CREATE TABLE tombstones (
      id TEXT PRIMARY KEY,
      last_revision INTEGER NOT NULL,
      forgotten_at TEXT NOT NULL,
      tombstone_json TEXT NOT NULL
    );
CREATE INDEX semantic_facts_status_updated
      ON current_facts(status, updated_at DESC);
COMMIT;
PRAGMA user_version = 3;
