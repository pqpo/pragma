# ADR 070: Automatic core asset reconciliation

Status: Accepted

## Context and authorization

The maintainer requested fewer user decisions and explicitly selected automatic propagation of
known local deletions, including the accumulated deletion backlog; removal of the deletion toggle;
automatic import of remote additions and remote-only edits; and preservation of deletion-versus-edit
competition as a conflict. Internal Context mapping repair was separately authorized as automatic.
This replaces the retention-policy portion of ADR 060, not its repository format or domain boundaries.

## Decision

Use successful per-resource baselines for three-way reconciliation. Single-sided additions, edits
and deletions propagate automatically. Concurrent unequal edits and deletion-versus-edit competition
require a choice. Local absence without a baseline means an incoming remote addition, never deletion.
The autoPush preference remains effective; manual sync uploads queued local changes when it is off.

Check the planned dependency graph. A retained reference competing with deletion becomes an isolated
logical conflict with resource-name diagnostics; independent changes proceed. Whole local graph
deletions can publish together. Reuse the existing import journal, CAS checks, sync lock, remote-head
retry and domain deletion checks. No forced Git push or startup-wide scanning is introduced.

Queued synchronization, genuine conflicts and failures have separate UI counts. Readiness is an
independent diagnostic on a synchronized item and links to Studio setup. Absent internal Context
mappings are repaired automatically and do not create restore/delete decisions or Expert mounts.

## Versions and upgrade

Upgrade settings, state and restore-journal families from v1 to v2. Snapshot historical schemas and
statically register adjacent migrations, including the journal's embedded state. Remove pushDeletions
and ignoredRemote through explicit migration; retain source, baseline hashes, cached remote metadata,
conflicts, expected revisions, target payloads and recovery information. Keep content and Git paths.
Saved ignored flags alone are not proof of deletion; preserved successful baselines determine whether
an absent resource is deleted. Restore-conflict checkpoints continue protecting competing local edits.

Upgrade only the accessed sync owner under its file lock. Preserve source backups, prepare a stable
multi-document migration journal, atomically replace targets and replay after interruption. Validate
all source documents before preparing writes; never replay a stale migration over future data. A
failed owner upgrade does not prevent unrelated projects or application startup. No supported
historical migration is removed. There is currently only one adjacent step; a longer chain does not
yet exist and future steps must be added statically.

Version the overview IPC envelope as pragma.asset-sync-overview/v2 and ship main, preload and renderer
contracts together. Synchronization status and optional readiness diagnostics are separate fields.
The old deletion option is rejected at the current mutation boundary; historical stored settings go
through migration. The repository marker remains pragma.asset-sync-repository/v1.

## Evidence and consequences

Historical v1 fixtures were captured by executing the original service from the commit recorded in
the fixture README, including an interrupted import; v2 fixtures are their migrated results.
Tests cover upgrade/no-op, backups, partial replacement replay, future versions and post-upgrade
execution, plus real Git deletion, dependency conflicts, independent progress and import recovery.
Obsolete deletion-toggle and grandfathered-retention tests are replaced with the newly authorized
automatic-deletion behavior. Existing domain deletion guards and supported explicit APIs remain.

## Review corrections

Local absence must be verified against the authority's existence port; unreadable resources are
reported as errors, preserve their remote copy/baseline and defer dependent imports. Recollect local
state before publishing deletions and retry planning when a selected resource reappears. Current
configuration/checkpoint snapshots are read atomically without waiting on network-held sync locks;
upgrades/recovery retain their exclusive lock, and execution journals remain validated by execution.
Forward-compatible Context fields survive metadata normalization and interrupted automatic repair.
Regression tests reproduce each failure before the correction and validate the corrected outcomes.

Incoming deletions are planned against the resulting local resource graph for full, pull and
automatic synchronization, including resources retained by conflicts. Reference competition is
persisted before calling the transfer executor; unrelated imports continue. Keeping a local owner
also keeps its unchanged dependencies deleted remotely, while competing dependency changes still
require decisions. Choosing the remote deletion removes the owner and its dependencies together.
Unreadable authorities retain last-known identities in a separate `unavailableItems` diagnostic
cache until configuration repair or actual removal. This optional v2 checkpoint field defaults to
empty for existing v2 checkpoints and v1 migration results; it never implies presence in Git.
