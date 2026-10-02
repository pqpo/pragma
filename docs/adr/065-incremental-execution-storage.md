# ADR 065: Incremental Host-owned Execution storage

- Status: Accepted for implementation
- Date: 2026-10-01
- Related: ADR 019, ADR 032, ADR 043, ADR 064

## Decision

Execution transactions use an owner-local SQLite database in the existing Execution root.
Core owns schemas, pure transition validation and commit identity. Local Host owns SQLite,
worker connections, conversion and delivery; Desktop and CLI inject the same adapter.
Execution, changed records, added events, commit receipts and canonical outbox are committed
atomically. SQLite uses WAL and FULL synchronous durability. Ordinary reads never discover
all executions or handoffs. Control and history reads are separate; history supports cursor
and limit. ExpertSession and Mission controller keep their existing storage families.

## Conversion and authority

On first access under the existing cross-process Execution lock, recover the historical
file transaction and canonical handoff using the supported migration chains. Preserve the
original owner files in an owner-local backup, then import a temporary SQLite database,
including commit receipts and canonical events that have not yet been delivered. A stable
conversion journal precedes import. Validate identities, row counts and the last cursor,
checkpoint/close the temporary database, atomically rename it and write the authority marker.
Before the marker, JSON is authoritative. After the marker, only SQLite is authoritative.
Restart replays the same journal; source files are never deleted or dual-written. A future
marker/database version fails closed. Conversion errors affect only this owner. No startup
scan or historical Memory import is introduced. Export reads the authoritative SQLite rows
and produces the current JSON document formats; reverting the application does not silently
choose the preserved, now-stale backup.

The original transaction journal is backed up before recovery. The v1 handoff envelope
can embed older transaction generations; upgrade that transaction through Core's registered
adjacent chain before current-domain parsing. Preserve the original handoff and replay a
stable atomic migration journal. Canonical event IDs and observation IDs remain unchanged.

For offline recovery, stop every Host accessing the owner and preserve the entire current
Execution directory (database, authority marker and any WAL/SHM), together with its pending
canonical registration. Restore that consistent directory to the same owner and let bounded
delivery replay idempotently. `exportSnapshot` supplies a validated portable inspection export
including receipts and undelivered events; it is not an automatic downgrade/import mechanism.
Never restore the pre-conversion JSON backup over a newer SQLite authority. A failed conversion
before marker creation resumes from its journal and original JSON; a completed conversion
recovers from its database backup. Session/Mission ownership must come from the same recovery
point, rather than independently rewinding Execution state beneath a live Runtime.

Database format version is independent of domain schema versions. Domain upgrades retain
Core's static adjacent migrations; database upgrades require their own static adjacent steps.
Historical fixtures must come from historical writers, never current objects with edited versions.

## Delivery, lifecycle and deletion

The canonical outbox contains only new envelopes, ordered by source sequence. Feed insertion
is idempotent. Delivery failure retains the source; it is not Execution failure. Background
batches yield between owners and never hold the Execution lock during feed I/O. Durable
pending-owner registration allows bounded recovery without scanning every owner at startup.
After an empty outbox is acknowledged, move its registration into the owner directory as
an idle record. Reactivation atomically moves that same record into the pending directory
and synchronizes that directory before committing source facts. This avoids repeatedly
writing and synchronizing identical registration contents. The idle record is not pending
work or another Execution authority; owner deletion removes it with the owner directory.
A crash before the SQL commit may leave an empty pending registration, which replay retires
without manufacturing events. Foreground registration takes place inside the source write
transaction, under the cross-process Execution lock. Delivery holds the canonical
delivery/deletion fence, durably deletes delivered rows, then rechecks and retires an empty
registration in a second SQLite write transaction. Thus a concurrent source commit either
precedes the recheck or reactivates the registration afterward. Confirmation does not take
another Execution file lock; SQLite serializes it with source writes and the delivery fence
prevents owner deletion. Idle retirement needs no durability wait because replaying an empty
registration is safe and recreating a missing idle record preserves the same source identity.
Unconverted historical handoffs are read only by conversion or the existing bounded recovery
worker. Malformed source records remain quarantined and their owner fails closed.

The existing deletion transaction, canonical deletion lock and ownership pending catalog
remain mandatory. Connections close before moving an Execution root, including WAL/SHM,
into journaled Trash. Deletion cannot recreate an outbox or resurrect an owner. Session active
release stays a separate owner transaction, conditional on the original Execution/request;
restart derives the release obligation from the persisted terminal Execution and running prompt.

Usage source events join existing necessary commits. Preview computation and accounting are
not completion conditions. Exact Runtime usage wins; fallback is computed once at the attempt
boundary. Host consumers own durable, idempotent accounting and failure reporting.

## Closure: preparation and shared worker custody

Owner preparation is an explicit Host operation. Ready execution RPCs never import JSON;
`getPrepared` reports pending without transferring authority to a projection. A shared pool
has at most two storage workers. Foreground execution and short receipt operations use lane A;
owner conversion and bounded accounting/delivery batches use lane B. B assists foreground
when it has no conversion, accounting/receipt batch, archive, large outbox read or
oversized input. ID-only acknowledgements may share B with foreground requests;
worker foreground priority and bounded fairness keep them from reserving the lane
while queued. Ordinary accepted requests, waiting inputs and owner chains are bounded by count and
bytes. Since the protocol has no maximum single-fact size, one oversized input can enter
only an empty background lane exclusively; the foreground lane retains its ordinary
capacity for other owners. Necessary Execution RPCs retain their input and retry capacity
contention with bounded backoff, rather than failing a Runtime turn. This is
not an absolute 32 MiB process-memory guarantee. Receipt projection excludes valid
unrelated conversation facts and terminal bodies before transfer, preserving invalid
sources for quarantine. Oversized canonical pages split into durable prefixes; no cursor acknowledges facts
that have not been stored. Worker failure increments generation before reuse; close drains
accepted calls before termination, preventing overlapping worker generations.

Canonical delivery wakeups coalesce for 250 ms from the first pending commit,
without resetting the deadline during continued output. At most 128 owner timers
are retained per store; additional owners dispatch directly. Facts and outbox
custody are already durable before scheduling. Running delivery uses its existing
dirty flag. Drain and close cancel timers and dispatch directly; deletion cancels
the owner timer and retains its existing delivery fence. This window applies only
to product projections, not live output, authoritative terminal publication or
Memory's active-conversation invalidation barrier.

Conversion journal v2 is a distinct storage family with a static v1-to-v2 step and historical
schema snapshot. It records source fingerprint, imported event count and import/publish phase.
Events are streamed in chunks bounded by 4,096 records or 1 MiB. Resume verifies the same source;
base rows are restored even when the first transaction rolled back. Publish replay validates
identities, rows, cursor, receipt signatures, undelivered envelopes and SQLite integrity before
atomically publishing authority. Original backups use a synced temporary file and rename.
No database marker permits falling back to stale JSON.

Desktop accounting and Mission delivery SQL run in these workers, not Electron Main.
Accounting keeps indexed incremental Mission totals. Local Host's previous JSON Usage ledger
has its own owner lock, preserved JSON backup, replayable conversion journal and SQLite marker;
a missing authoritative database fails closed. Durable feed changes are wake hints, with a
30-second bounded recovery fallback and error backoff. No healthy half-second consumer polling
is retained. Receipt eligibility accounts for blocked predecessors and live claims, so blocked
work cannot produce an empty retry storm.

Core no longer supplies a default file execution engine. Desktop, CLI and the three explicitly
listed examples composition roots inject Host SQLite; all other examples and Runtime packages
remain independent of Host. Persistent integration tests belong to Host; neutral Core tests
inject an in-memory authority with the same transition rules. The legacy file writer is retained
only as historical fixture provenance, not as a production adapter or parallel authority.

A pending/unavailable history source is distinct from execution status. Existing durable
projections can be shown, with entry identities/cursors preserved, while preparing only the
visible page. Team projections without trustworthy root identity omit invocation-scoped
entries until verification; they must not expose child conversations by relaxing that filter.

Outbox reads and event-ID acknowledgements use a separate owner sequence and bounded
64-request/8 MiB admission budget. They cannot occupy a prerequisite Promise or capacity
slot for the same owner's next control read/necessary commit while B prepares another owner.
SQL transactions and the canonical delivery/deletion fence still arbitrate confirmation
against new facts and deletion. Archive retains the real control sequence. The isolated
33 MiB commit and blocked preparation/outbox tests require a warm owner's terminal facts
to commit before releasing the injected background obstruction. Capacity retry retains
necessary inputs in the producer; worker admission limits are not total-process memory limits.
