# ADR 064: Mission durable delivery

Status: Accepted

Date: 2026-10-01

## Problem

Mission admission repeatedly inspects historical storage and readiness resources. Runtime completion
also awaits Host Usage attribution and product projections before releasing the next round. Moving
these writes into detached promises would lose accounting or history after a crash, and an old
Memory cleanup could cancel a newly admitted round.

## Decision

Core commits `runtime.usage.observed` with the Invocation Usage update in the same Execution
transaction. Its payload is validated by `RuntimeUsageObservedSchema`; its observation ID remains
the accounting idempotency key. The existing canonical handoff publishes this fact. Live previews
remain ephemeral. Host consumers acknowledge source custody only after staging work and their
cursor in one SQLite transaction. A stale competing Feed page is rejected using the cursor read
inside that transaction.

Desktop owns a finite Mission delivery worker, rather than a general background job framework.
Usage and the five terminal projections (Mission event, metadata, Memory, history, archive) have
separate rows, retry state and claims. History must finish before archive; a failed Memory step does
not prevent history or archive. Claims expire after 60 seconds and heartbeat every 10 seconds.
At most two owners run concurrently. Invalid facts/tasks are retained with stable error codes and
`needs_attention`; unrelated facts continue. Terminal writes still run under the Mission owner
scope and guard. Metadata updates compare Execution identity. Memory cleanup rechecks that identity
under admission, detaches the old generation synchronously, and awaits cancelled work outside
admission. Closing has a five-second wait budget; unfinished claims remain durable for restart.

Execution association may arrive after the source fact. Unlinked tasks remain staged until the
Host registers that Execution. Rebinding it to a different Mission or request fails. On owner
access, a persisted current association is registered without scanning all Missions at startup.
Deletion settles accounting from that owner's durable Execution facts before the Feed correlation
can be forgotten, tombstones the owner and its linked Executions, waits only for that owner's
in-flight delivery, and removes product work. Existing ownership/deletion journals remain authoritative.

The Local Host Usage sink uses the same source-custody rule and retains the existing JSON accounting
ledger and idempotency check. CLI drains delivery only after its final concurrent Mission releases.
Desktop also receives this consumer so an inactive CLI cursor cannot indefinitely pin Feed history.
Feed retention takes the minimum of Memory, Mission delivery and Local Host Usage custody watermarks.
Delivery failures appear in Host diagnostics and the Desktop health view with module and error code.

Admission readiness is distinct from full observer settlement: it includes Session active-turn
release, required cancellation snapshot and detachment of the old live observer. It excludes
queued-turn attachment and durable product delivery. Human checkpoints remain waiting rather than
terminal. Public Core Usage sinks that do not opt into source delivery retain their direct semantics.

Bundle readiness shares a request-local Project snapshot and Runtime availability list. It does not
cache readiness across admissions. Normal controller append reuses only data already read under its
aggregate lock; recovery still reads the durable journal. Fencing, expected version, idempotency,
sync/rename and retention semantics remain in force.

## Protocol and recovery boundaries

New databases use independent namespaces:

- `state/mission-delivery/delivery.sqlite`: `pragma.mission-delivery/v1`, durable delivery custody.
- `state/usage-delivery/local-host.sqlite`: `pragma.local-host-usage-delivery/v1`, durable Usage custody.

Unknown future versions are rejected before modifying their contents. Existing Execution, Session,
Mission, controller, DSL, Usage ledger and deletion journal schemas are unchanged. The new Usage
fact is additive to the existing open Execution event type/payload protocol. No old storage is
silently deleted or converted, and no exception to historical migration requirements is used.
Existing historical events without this fact retain their existing accounting; source consumers do
not synthesize a new billing observation from aggregate Usage totals.

## Verification and limits

Real filesystem/database tests cover atomic Usage source publication, staged restart, competing
Feed intake, association races, future protocol refusal, deletion tombstones and independent terminal
failure. The Execution and Session JSON engines remain unchanged. Real cold/warm/next-round Pi
samples and end-to-end P50/P95 acceptance remain pending.

## Capacity accounting withdrawn

The initial phase-three implementation also introduced global filesystem metering and a derived
capacity ledger. Real Desktop use revealed a severe page-loading regression: filesystem lock
operations repeatedly triggered synchronous full-table capacity queries. This integration, its
adapter export, Runtime hooks, ledger implementation and dedicated tests/benchmark have been
removed. Production filesystem imports use `node:fs/promises` again. Synchronous capacity write gates have also been removed from Mission creation/send/compaction,
Local Host commands, Project publication and plugin import. Capacity thresholds are advisory for
interactive work; reaching them does not reject Missions. Physical write failures still propagate.
Desktop inspects only after five minutes of startup delay and system inactivity, with no warm
Mission Sessions, at most once every six hours including failed/cancelled attempts. Inspection
runs in a separately built worker with a two-millisecond delay per directory entry. User activity,
resume or shutdown cancels the worker; a ten-minute budget bounds each attempt. Idle polling once
per minute only reads OS/in-memory activity and does not touch storage. Exceeding the advisory
threshold logs a manual cleanup recommendation. Existing explicit Settings inspection/cleanup
and journal-aware Trash retention remain available. CLI does not create another capacity poller.
Previously created capacity database files are left untouched and are no longer opened by this
implementation. They do not contain delivery custody and must not be confused with the retained
Mission and Usage delivery databases.

## Temporary Desktop placement and Local Host ownership

The worker's current Desktop location is an implementation boundary for this delivery, not the
long-term Mission ownership model. Local Host remains the authority for Mission admission, owner
leases, fencing and deletion. Desktop only composes the delivery callbacks with its existing product
stores and UI; the worker must not independently decide execution or Mission lifecycle transitions.

The follow-up extraction must move the durable receipt schema, intake, claims, retries, association,
watermarks and deletion coordination into `packages/local-host/src/missions/`. Desktop and CLI will
inject Host-specific Usage, Memory, history and archive ports; the application callbacks and renderer
notifications stay in their respective composition roots. The shared worker must not depend on
Electron or Desktop contracts: its Mission/Execution identities and callback payloads need Local Host
contracts. Preserve the existing database namespace and version, or provide a journaled migration;
do not create a second authority or a parallel CLI worker with different custody rules. Acceptance
must cover Desktop and CLI, late association, cross-process claims, source failures, deletion and
restart against the same durable database. This extraction is a separate structural change from
phase-four latency work, so this PR does not claim Desktop/CLI delivery ownership is already unified.

## Initialization recovery and retention

A failed Mission delivery initialization keeps direct projection enabled and reports
`MISSION_DELIVERY_UNAVAILABLE`. After the window has been created, the consumer retries initialization
with exponential backoff bounded at one minute, with only one attempt in flight. Successful recovery
clears the initialization diagnostic and starts delivery from its persisted receipt cursor. Shutdown
cancels the retry timer and closes a database opened by an already-running attempt without publishing
or starting it.

An unavailable consumer is not equivalent to a consumer which has acknowledged all events. Until its
receipt cursor can be read, retention conservatively uses zero; retries make transient failure
recoverable within the running process. Persistent corruption or a future version remains degraded
and preserves source history for intervention. Dropping this consumer from the retention minimum
would discard unacknowledged custody and is not an acceptable recovery shortcut.
