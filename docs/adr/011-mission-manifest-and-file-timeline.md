# ADR 011: Mission Manifest and File Timeline

## Status

Accepted.

Amended by ADR 016: terminal generated output is materialized into an immutable per-Execution
Mission projection before the canonical event log moves to bounded diagnostic storage.

## Context

Desktop originally stored Mission identity, lifecycle, current execution, and every top-level chat
message in one `pragma.mission/v2` YAML document. Every message or status update therefore parsed,
validated, and rewrote the complete conversation. Mission listing also loaded and transferred all
message bodies even though the rail only needs summary fields. Assistant text duplicated the
canonical Execution event log.

## Decision

Desktop uses the breaking `pragma.mission/v3` format without a v2 migration path. Each Mission
directory contains a bounded `mission.yaml` manifest and an append-oriented `messages.jsonl`
timeline. The manifest owns Mission identity, pinned project and executor, immutable workspace
path, lifecycle, mutable next-turn model and permission options, and the current
ExpertSession/Execution references. It does not own chat content or a second aggregate environment
recovery fingerprint.

The timeline stores versioned, monotonically sequenced user-message and execution-reference
records. It does not duplicate assistant output inline. Active output is projected from the
Execution canonical event log; after terminal settlement, a separate immutable Execution projection
preserves Mission-visible assistant, thinking, tool-summary, and activity entries. If neither the
Execution nor its projection is available, chat displays an explicit unavailable-history entry.

Timeline appends use a per-Mission cross-process file lock and a recoverable transaction journal.
Only a torn final JSONL record associated with that journal may be truncated and replayed;
corruption in committed records fails closed. The initial file adapter may scan and cache the full
timeline while exposing cursor-based pages to IPC and the renderer. An index or database is deferred
until measured file I/O requires it.

Mission listing returns a bounded summary and does not read the timeline. Chat initially returns the
latest 50 logical turns and supports loading older turns by sequence cursor, with a maximum page
size of 100.

## Consequences

- YAML remains readable and bounded while long conversations grow only in `messages.jsonl`.
- Execution events remain canonical during execution; terminal Mission projections survive bounded
  diagnostic archive expiry.
- IPC and renderer memory scale with loaded pages rather than total conversation size.
- Local timeline reads are still linear until a later index or storage adapter is justified.
- Existing `pragma.mission/v2` directories report an actionable unsupported-schema error and are
  neither migrated nor deleted automatically.
