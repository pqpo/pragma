export const CANONICAL_EVENT_FEED_V2_SCHEMA_SQL = `
  CREATE TABLE canonical_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    topic TEXT NOT NULL,
    schema_ref TEXT NOT NULL,
    correlation_id TEXT,
    occurred_at TEXT NOT NULL,
    envelope_bytes INTEGER NOT NULL,
    envelope_json TEXT NOT NULL
  );
  CREATE INDEX canonical_events_topic_sequence ON canonical_events(topic, sequence);
  CREATE INDEX canonical_events_correlation ON canonical_events(correlation_id, sequence);
  CREATE TABLE event_receipts (
    event_id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL,
    correlation_id TEXT,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_cursor TEXT
  );
  CREATE INDEX event_receipts_correlation ON event_receipts(correlation_id);
  CREATE TABLE feed_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO feed_metadata(key, value) VALUES ('last_sequence', '0');
  PRAGMA user_version = 2;
`;
