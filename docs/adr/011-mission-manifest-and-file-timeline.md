# ADR 011: Mission Manifest and Durable Timeline

## Status

Accepted. Storage versions and migration chains are owned by the current Mission storage schemas; this ADR defines
the stable separation of responsibilities without duplicating a version literal.

## Context

Mission identity, user messages, execution events and UI projections have different update frequency, retention and
recovery semantics. Keeping them in one aggregate document would make every message rewrite the complete Mission and
would duplicate the canonical Execution history.

## Decision

Each Mission directory separates four concerns:

- a bounded manifest owns Mission identity, pinned Project/executor binding, workspace, lifecycle and current
  ExpertSession/Execution references;
- an append-oriented timeline owns user messages and Execution references with monotonic sequence numbers;
- Core Execution storage owns recoverable Invocation state and the Canonical Event Log;
- an immutable per-Execution projection preserves the bounded Mission-visible terminal history.

The manifest does not embed chat content or a second Runtime environment fingerprint. The timeline does not duplicate
assistant output. Active output is projected from the Execution event/output channels; after terminal settlement, the
Mission projection preserves assistant, thinking, tool-summary and activity entries required by the UI.

The terminal projection is a Mission-owned read model, not an Execution recovery source. It uses one JSONL file per
Execution as the rotation boundary, is written to an atomic temporary file and flushed before publication, and records
truncation metadata whenever configured entry, byte or field bounds apply. Deleting the owning Mission removes these
projections through the owner-graph deletion lifecycle.

Timeline appends use a per-Mission cross-process lock and recoverable transaction journal. Only a torn final record
associated with that journal may be truncated and replayed; corruption in committed records fails closed. Mission
listing reads only bounded manifest data, while chat and events use cursor-based pagination.

Every historical Mission schema in the support window lives in a static adjacent migration chain. The Host upgrades
the smallest owner on first access using a backup, stable journal and atomic replacement before business reads begin.
Current code consumes only the current schema exported by the authoritative storage module.

## Consequences

- Mission listing cost is independent of conversation length.
- User input, recoverable execution state and terminal UI history each have one authority.
- Cursor-based readers and bounded projections keep renderer and IPC memory predictable.
- Crash recovery can replay the exact journaled append or migration without scanning unrelated Missions.
