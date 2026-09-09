# ADR 049: Runtime Session SQLite catalog and Host storage binding

## Status

Accepted.

## Context

Runtime Session metadata and global ownership claims were stored as two JSON files per Context.
Besides wasting filesystem blocks, this allowed the claim and manifest to diverge. Runtime creation
also accepted an omitted Host storage root and fell back to a path resolved while defining an Expert.
Tests that constructed a manager without its temporary `pragmaHome` consequently wrote thousands of
fake Session records into the user's real `~/.pragma`.

## Decision

- A Host must pass `pragmaHome` explicitly through ExpertSession, FlowExecution and
  `RuntimeDriverSessionRequest`. `Expert` no longer exposes a storage root and Runtime code never
  infers one from the Expert definition.
- Runtime Session metadata and the unique `systemSessionId` ownership claim are one row in
  `state/runtime-sessions/catalog.sqlite`. Native Runtime state remains in the owner-scoped filesystem
  directory.
- The catalog uses a versioned metadata table, WAL, a primary-key ownership constraint and an owner
  index. Creation is one atomic insert; updates and owner deletion are transactions.
- First Runtime access performs the one-time JSON import under the catalog migration lock. It writes
  a stable journal and a consolidated JSONL backup before committing, then removes the superseded
  manifests and only their matching claim files. An interrupted post-commit cleanup is replayed from
  the journal. Directory read and record validation failures abort the import; they are never treated
  as an empty legacy store.
- This import is deliberately the shared-global-state exception to owner-lazy migration. A partial
  owner import could not enforce the catalog's global `systemSessionId` uniqueness against claims that
  had not yet been imported, so the first catalog access imports the complete legacy claim domain.
- Catalog version metadata is checked through a read-only connection before every writable open.
  Unknown versions and malformed metadata fail closed without mutating the database.
- Migration backups are retained for seven days by bounded post-window maintenance. Future catalog
  versions fail closed until an adjacent migration is registered.

## Consequences

Runtime Context directories contain only native Runtime data. Mission deletion coordinates filesystem
moves and catalog-row removal through one deletion journal plus a catalog-side pending-deletion record,
under a cross-process lock. Recovery rolls a prepared deletion forward after any crash, so neither a
moved directory with a live ownership row nor a deleted row with an unmoved directory becomes the final
state. Downgrading to a build that only understands JSON Runtime Session manifests is not supported
after migration; recovery uses the consolidated backup.
