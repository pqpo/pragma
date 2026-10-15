-- Written by createEpisodicMemoryStore at git 6aeca6e8; dumped without schema edits.
BEGIN TRANSACTION;
CREATE TABLE episode_evidence (
      episode_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      PRIMARY KEY (episode_id, evidence_id),
      FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
    );
CREATE TABLE episode_revisions (
      episode_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (episode_id, revision)
    );
CREATE TABLE episode_source_executions (
      episode_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      PRIMARY KEY (episode_id, execution_id),
      FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
    );
CREATE TABLE episodes (
      id TEXT PRIMARY KEY,
      conversation_key TEXT NOT NULL UNIQUE,
      execution_id TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
CREATE TABLE governance_events (
      id TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_json TEXT NOT NULL
    );
CREATE TABLE tombstones (
      id TEXT PRIMARY KEY,
      last_revision INTEGER NOT NULL,
      forgotten_at TEXT NOT NULL,
      tombstone_json TEXT NOT NULL
    );
CREATE INDEX episodes_status_updated ON episodes(status, updated_at DESC);
CREATE INDEX episode_source_executions_execution
      ON episode_source_executions(execution_id, episode_id);
COMMIT;
PRAGMA user_version = 3;
