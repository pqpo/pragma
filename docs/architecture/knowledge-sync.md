# Knowledge-base synchronization

Pragma synchronizes only the current published state of managed knowledge bases. Drafts, revision
records, Missions, Memory, bindings, locks, journals, and content-addressed objects remain local.
The synchronization boundary is `ContextStoreSyncProvider`; Git is the first provider, while future
object-storage or WebDAV implementations can keep the same reconciliation semantics. Provider
instances capture provider-specific configuration. The shared boundary exchanges only repository
snapshots, opaque revisions, and an optional human-readable reference; it does not expose Git
branches or Git configuration.

## Portable repository format

One configured repository contains all synchronized knowledge bases. Pragma owns only these paths
and preserves every other repository file:

```text
pragma-knowledge-sync.yaml
knowledge-bases/
  <store UUID>/
    store.yaml
    files/
      **/*.md
```

`store.yaml` contains the store UUID, display metadata, explicit empty directories, and per-file
Context metadata. Markdown remains directly readable and editable with ordinary Git tools. A
repository that already contains `knowledge-bases/` without the root protocol manifest is rejected
to avoid overwriting unrelated content. Symlinks and files outside the declared Markdown set are
also rejected.

Repository manifests reject duplicate paths. Reads are bounded by store count, file count,
individual file size, and total managed-content bytes before content enters synchronization state.

## Reconciliation

The local state records a fingerprint for the last synchronized version of each store. Conflict
records contain fingerprints, names, and file paths only; Markdown content is read again from the
provider when the user resolves a conflict. Different store UUIDs merge independently:

- Remote-only stores are imported and local-only stores are published.
- Equal stores are aligned without creating a commit.
- A change on only one side is applied to the other side.
- Changes on both sides, including delete-versus-edit, create a store-level conflict.

When configuring a target, `merge_and_publish` runs this same bidirectional reconciliation and
publishes local-only changes; it is not a local-authoritative overwrite. `restore_remote` applies the
selected target without publishing local candidates.

Conflict resolution deliberately chooses one complete store rather than merging individual files.
Choosing the remote version writes a Git merge commit whose selected remote state is the merge tree
and whose alternate local candidate remains reachable through the second parent. Choosing the local
version writes it on top of the remote parent. If the local revision changes, resolution stops
instead of overwriting it. If the remote head moves during a push, reconciliation reads the new
head and retries instead of force-pushing.

Local deletion upload is disabled by default. Such a store remains in Git and is marked ignored on
that device until the user restores it. Enabling deletion upload applies to future deletions and
does not silently remove already ignored remote stores.

## Execution and credentials

A successful local publish schedules full background synchronization when automatic upload is
enabled. Local persistence never waits for network access. Desktop startup, application focus, and
network-online events use pull-only synchronization and never publish pending local changes. A
manual sync is explicitly bidirectional, including when automatic upload is disabled.

Git runs non-interactively and relies on the user's system Git credential helper or SSH agent.
Credentials are never accepted in the configured remote URL or persisted by the synchronization
service. Published commits use the user's global Git `user.name` and `user.email`; synchronization
fails with an actionable configuration error when either value is missing. The managed checkout
never substitutes a Pragma service identity for the local user's commit identity. Source identity
normalization trims whitespace and trailing slashes only; remotes that differ by a `.git` suffix are
distinct because generic Git servers need not resolve them to the same repository.
