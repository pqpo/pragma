# ADR 049: Runtime Session SQLite catalog and Host storage binding

## Status

Accepted. Consolidates the former ADR 005 ownership/storage summary; lifecycle and leases remain
defined by [ADR 006](006-runtime-session-ownership-and-leases.md).

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

## Owner and recovery identity

Runtime Session owners are either `{ type: "expert-session", ownerId, contextId }` or
`{ type: "flow-execution", ownerId, invocationId }`. Native data stays below the encoded owner
and system Session directories. Recovery must match owner, original `systemSessionId`, Expert,
Runtime, `RuntimeSessionRef` and workspace history. Business readers do not retain old JSON
manifest/claim branches after import.

## In-process Host identity and crash recovery

Runtime Session v4 adds `processOwner`. Native sessions that execute inside the Node Host (Pi)
record its PID, a Host instance ID and an OS process birth token. The managed driver writes this
identity before native preparation, refreshes it on an explicit restore, and records a confirmed
stop after native close. External CLI adapters retain their independent process semantics.

A targeted Session/owner read reconciles a nonterminal in-process record only when the original
Host is proven gone: ESRCH, or a different OS birth token for a reused PID. Permission errors and
unavailable inspection preserve uncertainty. Linux uses the boot ID plus process start ticks;
macOS uses `ps lstart` in UTC/C locale and never reads arguments or provider environments for Host
identity. A late probe may not overwrite a successor Host's identity or state. No startup scan of
all owners is introduced, and Mission deletion remains independent of stop acknowledgement.

The adjacent v3-to-v4 migration marks historical `cloud-pi-agent` records as `legacy-host`; it does
not fabricate a PID or change `running` into `stopped`. An ExpertSession's existing lease can prove
that its historical Host PID exited. Recovery checks that lease under the same lock used for
lease takeover. A missing lease/PID, expired-but-live lease, or legacy Flow owner without a Host
identity remains unconfirmed; explicit user deletion still removes the owner graph.

Catalog v2 adds transactional per-row migration backups. The v1-to-v2 catalog migration first saves
a consistent SQLite backup, then publishes its DDL/version atomically using SQLite WAL. Record
migration is lazy by selected owner: original writer JSON and upgraded JSON commit in the same
SQLite transaction. An interrupted transaction rolls back and the reader retries the registered
migration. Owner deletion also removes its per-row backups; future catalog/record versions remain
rejected without rewriting their contents. Historical v2/v3 schemas and the real v1 catalog/v3 Pi
writer fixture remain in the migration/test tree.

## Consequences

Runtime Context directories contain only native Runtime data. Mission deletion coordinates filesystem
moves and catalog-row removal through one deletion journal plus a catalog-side pending-deletion record,
under a cross-process lock. Recovery rolls a prepared deletion forward after any crash, so neither a
moved directory with a live ownership row nor a deleted row with an unmoved directory becomes the final
state. Downgrading to a build that only understands JSON Runtime Session manifests is not supported
after migration; recovery uses the consolidated backup.
