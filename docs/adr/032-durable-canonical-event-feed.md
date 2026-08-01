# ADR 032: Durable Canonical Event Feed and Execution Handoff

- Status: Accepted
- Date: 2026-08-01
- Related: [ADR 031](./031-extensible-memory-plane.md)

## Context

Memory requires durable, replayable source events, but `ExecutionLiveBus` is process-local and the
existing `ExecutionEvent` cursor is local to one Execution. Coupling Execution directly to
`@pragma/memory` would reverse the package dependency and make the same delivery mechanism unusable
by future audit, search, metrics, or indexing consumers.

The file Execution Store also cannot atomically update an Execution aggregate and a second global
Feed file. A callback after commit has a crash window; scanning every Execution at Desktop startup
is prohibited.

## Decision

Core owns a Memory-neutral `CanonicalEventFeed`. The local implementation is an append-only SQLite
Feed with a global sequence and idempotent event id. `@pragma/memory` consumes this Feed and publishes
versioned `MemoryEvidenceEnvelope` values back through the same transport.

Execution commits that contain new events use `pragma.canonical-event-handoff/v1`. The handoff is a
global, durable wrapper around the current `pragma.execution-transaction/v9` plus the derived
Canonical Events. Writing the handoff is the durable commit point. Core then applies the Execution
transaction, appends the Feed, and removes the handoff.

If Feed delivery fails, the Execution remains committed and the handoff remains pending. Desktop
retries only the bounded handoff directory after the window is created. Recovery checks the
Execution commit record before applying the nested transaction, so an old pending handoff cannot
overwrite a newer aggregate. Feed insertion is idempotent, making crashes after append safe.
Recovery publishes handoffs for one Execution in source-version order and stops that Execution at
the first delivery failure; a later event is never published ahead of its predecessor.

An unreadable, owner-mismatched, or unsupported future-version handoff is moved byte-for-byte to
`state/event-bus/handoff-quarantine/`, so it does not create an unbounded retry/log loop. Quarantine
is not data loss or acknowledgement: access to the affected Execution fails closed while a matching
quarantined handoff exists, and Plane health reports the quarantine count for operator repair.
Other Execution owners continue recovery independently. A valid handoff whose transaction cannot
be applied is deliberately not quarantined or skipped because the handoff is already the durable
commit point; it remains pending and blocks later handoffs for that owner.

Existing v6-v9 Execution transaction migrations remain unchanged. Historical pending transactions
are recovered by their existing migration chain and are not treated as a hidden historical Memory
import.

Memory Module completion uses a separate `pragma.memory-derived-event-outbox/v1` record. A Module
first performs its idempotent mutation and returns derived envelopes; the scheduler persists the
completion/outbox record before publishing those envelopes and advancing its checkpoint. Recovery
finishes a pending outbox without invoking the Module again. A crash before outbox persistence may
invoke the Module again, which is why Module mutation idempotency remains mandatory.

## Consequences

- Core remains independent of Memory schemas and Module types.
- Mission execution availability does not depend on the Memory pipeline being healthy.
- A malformed handoff only blocks its owning Execution, while degraded Plane health remains visible.
- The Feed supplies global delivery order; business causality remains explicit through source,
  correlation, and causation ids.
- Phase one retains Feed rows indefinitely. Retention, remote replication, and historical import
  require later decisions.
