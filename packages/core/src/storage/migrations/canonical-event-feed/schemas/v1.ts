export const CANONICAL_EVENT_FEED_V1_SCHEMA_SQL = `
  CREATE TABLE canonical_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    topic TEXT NOT NULL,
    schema_ref TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    envelope_json TEXT NOT NULL
  );
  CREATE INDEX canonical_events_topic_sequence ON canonical_events(topic, sequence);
  PRAGMA user_version = 1;
`;
