# ADR 036: Memory Storage Retention and Recovery

- Status: Accepted
- Date: 2026-08-04
- Related: [ADR 031](./031-extensible-memory-plane.md), [ADR 032](./032-durable-canonical-event-feed.md), [ADR 033](./033-layered-episodic-memory.md), [ADR 034](./034-conservative-semantic-memory.md)

## Context

Memory extraction deliberately separates continuous Evidence capture from terminal-time model
extraction. Without an explicit retention contract, a stalled consumer, a permanently failing model,
or an unusually large Execution can make the Feed, per-Module Evidence, retry records, dead letters,
and hidden curator Missions grow indefinitely. Deleting a Mission also needs a crash-safe distinction
between transient extraction state and already-materialized long-term Memory.

## Decision

Memory uses one versioned, Host-owned storage policy. It is currently fixed and read-only:

- Canonical Feed payloads have a 30-day retention window and a 512 MiB logical target. Maintenance
  may delete only through the minimum durable checkpoint of every registered consumer. Event receipts
  survive payload pruning, so replaying an old event id remains idempotent. Rows pinned by a lagging
  consumer are never deleted to satisfy the target; health instead reports the blocked bytes.
- Each Module retains at most 2,000 Evidence envelopes or 16 MiB per Execution. A deterministic
  priority selector keeps terminal outcomes, user intent, final assistant output, failures, artifacts,
  and summaries before routine lifecycle events. The prompt is independently bounded to 78 KiB.
  Content-free omission counts remain visible to the curator and diagnostics.
- Episodic Memory stores only Evidence cited by the retained Episode. Semantic Memory already stores
  only Evidence cited by a retained Fact.
- Long-term Memory uses a binding-scoped hot/archive index. Episodic scoring combines value, a
  90-day update half-life, and a 60-day recall half-life; Semantic scoring combines confidence,
  verification, a 180-day update half-life, a 90-day recall half-life, and conflict/review penalties.
  Hot indexes are capped at 200 Episodes and 500 Facts per consumer before their byte budget applies.
- The Episodic Store is capped at 10,000 records or 512 MiB logical content; Semantic is capped at
  20,000 records or 512 MiB. Each Memory keeps at most 100 full revisions. Maintenance removes the
  lowest-scoring archived content first, then low-scoring hot content if necessary, and retains a
  content-free tombstone so replay cannot recreate the removed identity.
- Automatic transient retries are bounded. Configuration failures and exhausted transient failures
  enter `needs_attention`; application startup does not wake them. A matching configuration change or
  an explicit CAS-protected user retry may wake them.
- Failed payloads expire after 30 days. Their content, Evidence, and subject context are deleted and
  replaced by a content-free `expired` diagnostic. Completed job records, expired diagnostics, and
  dead letters use bounded 30-day retention; dead letters are additionally capped at 10,000 records
  and 64 MiB per consumer.
- Mission deletion writes a stable cleanup journal, deletes Feed payload/receipts and transient
  Episodic/Semantic state for the Mission's Executions, then moves the Mission owner graph to trash.
  Already-materialized Episode and Fact revisions remain governed long-term Memory. A short-lived
  deleted-Execution marker prevents an in-flight extractor or replay from recreating transient state.
- Memory SQLite upgrades run through statically registered adjacent migration chains under a file
  lock. Each source version is backed up before mutation; stale migration backups and abandoned
  atomic-write temporary files are removed after 30 days and one day respectively.
- Hidden Memory Curator Missions are registered in a dedicated bounded registry. Normal completion
  deletes them immediately; post-window recovery cleans only registered orphan entries after a
  one-day grace period and never scans all Missions.

Desktop runs targeted maintenance after its first window exists, hourly while active, after owner
deletion, and on explicit maintenance requests. Startup does not scan all owners. Storage upgrades
remain lazy, fail closed on future versions, and preserve the existing backup/journal rules.

## Consequences

- A lagging consumer can cause a visible degraded state, but cannot cause unacknowledged Feed data to
  be silently discarded.
- Large executions remain extractable from a representative, deterministic Evidence set rather than
  growing model prompts without bound.
- Failed extraction remains recoverable for a bounded period and requires an observable trigger;
  repeated application starts no longer create an implicit retry loop.
- Mission deletion is crash-recoverable and does not erase independently governed long-term Memory.
- Receipt and diagnostic metadata can outlive source payloads, but contain no captured content.
