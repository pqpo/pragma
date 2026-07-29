# ADR 016: Local storage lifecycle and content addressing

## Status

Accepted; the Codex cache-base decision is superseded by ADR 026.

## Context

Runtime Sessions copied complete Codex homes, Studio revisions copied complete projects, Execution
event logs were never archived, and Agent plugin caches repeated identical package bytes. Closing a
Runtime process or deleting a Mission did not establish a storage deletion boundary.

## Decision

Pragma storage uses the breaking `pragma.storage/v3` layout. `data/` contains authoritative Mission,
Project, content-addressed object, plugin, and credential data. `state/` contains owner-scoped active
and recoverable state. `archives/` contains bounded compressed diagnostics. `cache/` is rebuildable,
TTL/LRU managed data. `tmp/` and `trash/` have short retention windows. Filesystem manifests are the
reference graph's source of truth; `state/storage/catalog.sqlite` is a rebuildable size and owner
index. Desktop's built-in default Agent workspace is `~/.pragma/workspace`, directly below the
Pragma root rather than inside `data/`; it contains only task-scoped repositories, inputs,
artifacts, and Agent-authored files.

Project revisions are permanent immutable manifests. A revision references one SHA-256 Merkle tree;
trees reference immutable blob or child-tree objects. Unchanged files are therefore stored once
across every revision and project. All revision manifests are GC roots until their Project is
explicitly deleted. Checkout directories are rebuildable hard-link views and never constitute
authoritative project data.

Codex Runtime Context storage originally used one Pragma-managed immutable cache base per
fingerprint and a private overlay. ADR 026 replaces that cache-base portion with a minimal
per-Context Home projection. Generated configuration, copied Agent Skills, native sessions, logs,
temporary files, and `CODEX_SQLITE_HOME` remain private. Authentication continues to use one Pragma
credential projection. Mission-owned native sessions are retained until Mission deletion; stopping
a process is not a storage deletion operation.

Terminal Executions first materialize a Mission conversation projection, then move their canonical
JSONL events into a gzip archive. The archive is readable through `ExecutionStore` while retained,
but is diagnostic rather than the durable Mission chat source. Plugin packages are expanded once at
`cache/plugins/sha256/<fingerprint>`; Agent directories contain binding metadata only.

Mission deletion is an owner-graph operation. It writes a deletion journal and moves uniquely owned
ExpertSession, Execution, Runtime Session, ownership-claim, and archive data to a seven-day trash
area. GC uses mark-sweep plus a grace period instead of mutable reference counts. Leased or referenced
objects cannot be collected.

Default limits are 4 GiB soft and 6 GiB hard globally, 1 GiB for rebuildable cache, and 512 MiB or 90
days for Execution archives. Persistent data is never silently evicted. At the hard limit Pragma
allows completion, deletion, export, and GC, but rejects new executions, project publications, and
plugin installations.

The first v3 Desktop launch atomically renames an existing unversioned Pragma root to a dated sibling
backup and starts empty. There is no old-format reader or dual-write path. The backup is offered for
seven days before the Desktop asks the operating system to move it to trash. A sibling bootstrap
journal bridges the rename, v3 marker creation, and backup-manifest write so startup can resume after
a process or machine failure without orphaning the legacy backup.

## Consequences

- One small project change adds one blob, its ancestor trees, and a revision manifest instead of a
  complete project directory.
- Mutable Codex session data remains isolated; ADR 026 defines how rebuildable native caches are
  projected without a Pragma-owned full cache snapshot.
- Keeping all Missions and all revisions can still consume the configured persistent capacity; the
  hard limit makes this bounded and requires an explicit owner deletion decision.
- Mission chat remains readable after Execution diagnostic archives expire.
- `RuntimeSessionRecord.processState` and `retentionState` replace the ambiguous persisted `status`.
- Storage v1/v2 data is not migrated into v3.
