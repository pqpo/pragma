# ADR 016: Local Storage Lifecycle and Content Addressing

## Status

Accepted. The former synchronous capacity write gate is superseded by
[ADR 064: Capacity accounting withdrawn](064-mission-durable-delivery-and-capacity-accounting.md#capacity-accounting-withdrawn).
Current storage version constants and adjacent migrations are owned by their authoritative storage modules;
this ADR defines the stable layout and lifecycle rules.

## Context

Authoritative resources, recoverable execution state, diagnostic archives, rebuildable caches, temporary files and
Agent workspaces require different retention rules. Project revisions and plugin packages also contain repeated bytes
that should be content-addressed rather than copied per owner.

## Decision

Pragma separates local storage by purpose:

```text
~/.pragma/workspace/   # task repositories, inputs, artifacts and Agent-authored files
~/.pragma/data/        # authoritative resources and content-addressed objects
~/.pragma/state/       # active and recoverable runtime state
~/.pragma/archives/    # bounded diagnostic archives
~/.pragma/cache/       # rebuildable TTL/LRU-managed content
~/.pragma/tmp/         # short-lived staging
~/.pragma/trash/       # journaled recoverable deletion
```

Filesystem manifests are the reference graph authority. Rebuildable indexes live under state or cache according to
their recovery role and never replace those manifests.

Project Revision manifests are immutable GC roots until Project deletion. Each revision references a SHA-256 Merkle
tree whose tree and blob objects are globally deduplicated. Checkout directories are rebuildable views and do not own
Project data.

Runtime Session state is private to its owning ExpertSession context or FlowExecution Invocation. Generated config,
native sessions, logs and writable homes are not stored in the Agent workspace. Adapter-specific shared caches may be
projected only from the designated rebuildable runtime cache and must preserve each Runtime's authentication and
session isolation rules.

Terminal Executions materialize their bounded Mission-visible projection before Canonical Event data moves to bounded
diagnostic archives. Mission deletion is an owner-graph transaction: it writes a stable journal and moves uniquely
owned ExpertSession, Execution, Runtime Session, ownership claim and archive data to managed trash.
Desktop persists a versioned, owner-validated deletion intent inside the Mission owner directory, seals new
admission, initiates Native stop, and commits the owner-graph move without waiting for Runtime stop acknowledgement.
A stale Runtime state, failed close or unresponsive child must not prevent an explicitly requested deletion.
Owner fences reject late writes. Native teardown, observers and Unix orphan processes identified by private Runtime
owner directories are cleaned up after commit with bounded retries; Unix orphan cleanup escalates from SIGTERM to
SIGKILL after a short grace period or on retry. The deletion payload retains the owner IDs so orphan cleanup also resumes after Host restart.
If the process exits before the owner-graph move journal is created, the Mission is reported as `deletion_pending`
and the same explicit delete action resumes the transaction without losing the operator's intent.

Background deletion retries share one durable budget of ten retries per Mission, across all cleanup steps and
storage-transaction recovery. Each cleanup step gets its initial attempt; later attempts reserve the shared budget
under the deletion-record lock before invoking side effects. Host restart does not replenish the budget. Exhausted
records retain their failure evidence and report degraded status, while the deleted conversation remains removed.
Mission deletion v2 persists step run counts and the shared retry count; its adjacent v1 migration reconstructs
already observed retries from the original writer's failure/success counters, with a backup and replayable journal.

Completed trash entries are retained until the first configured age, total-size or entry-count bound is reached.
Incomplete or invalid deletion journals are retained for recovery. Desktop performs targeted maintenance after the
first window exists and after successful owner deletion; startup does not scan every owner.

Storage capacity is an advisory, low-frequency idle background inspection. It must not block page
reads, Mission admission or normal writes. Over-limit diagnostics ask the user to clean up manually;
there is no global write gate. Rebuildable caches and archives follow their own bounded retention,
and authority data is removed only through explicit owner deletion.

Storage schema upgrades run on first access to the smallest owner. Each supported step uses a static adjacent migration,
backup, aggregate lock, stable journal and atomic replacement. The business parser reads only the current schema.

## Consequences

- Small Project changes add only new blobs, ancestor trees and a revision manifest.
- Mission-visible history remains available independently from bounded diagnostic archives.
- Stopping a Runtime process never implies deletion of its recoverable Session.
- Owner deletion remains crash-recoverable and bounded retention never removes an unfinished journal.
- Runtime caches can be reused without sharing writable Session state.
