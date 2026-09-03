# ADR 016: Local Storage Lifecycle and Content Addressing

## Status

Accepted. Current storage version constants and adjacent migrations are owned by their authoritative storage modules;
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

Completed trash entries are retained until the first configured age, total-size or entry-count bound is reached.
Incomplete or invalid deletion journals are retained for recovery. Desktop performs targeted maintenance after the
first window exists and after successful owner deletion; startup does not scan every owner.

Storage capacity uses separate soft and hard bounds. Rebuildable cache and diagnostic archives are eligible for their
defined retention policy; authoritative data is removed only through explicit owner deletion. At the write gate, the
hard bound permits completion, deletion, export and GC while rejecting new capacity-growing work.

Storage schema upgrades run on first access to the smallest owner. Each supported step uses a static adjacent migration,
backup, aggregate lock, stable journal and atomic replacement. The business parser reads only the current schema.

## Consequences

- Small Project changes add only new blobs, ancestor trees and a revision manifest.
- Mission-visible history remains available independently from bounded diagnostic archives.
- Stopping a Runtime process never implies deletion of its recoverable Session.
- Owner deletion remains crash-recoverable and bounded retention never removes an unfinished journal.
- Runtime caches can be reused without sharing writable Session state.
