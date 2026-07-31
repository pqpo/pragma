# ADR 024: Interpreter-Owned DSL Migrations

## Status

Accepted.

## Context

Pragma DSL projects are persisted by Desktop today and will also be persisted by Server. The
bounded `pragma/v2` to `pragma/v3` conversion was originally embedded in the Desktop project store.
Keeping semantic conversion there would require every future Host to duplicate resource identity,
reference rewriting, validation, and compatibility policy.

DSL source compatibility is distinct from a Host's storage schema and from Core recoverable runtime
state. These version axes must not share migration switches or transaction implementations.
Compiler compatibility for an already-current DSL is also a separate axis; ADR 029 governs that
path and does not republish immutable history.

## Decision

`@pragma/interpreter` owns a static, forward-only chain of pure adjacent DSL migrations. It exposes
version inspection and upgrade-to-current operations over an in-memory project file snapshot.
Migration steps perform no filesystem or database I/O. They return current resources, preserved
artifacts, and semantic resource identity mappings needed by Host-owned dependent data.

The Interpreter parser and compiler continue to accept only the current DSL. A Host must invoke the
migrator before publishing an old project through `PragmaProjectService`.

Each Host owns its persistence transaction:

- Desktop materializes legacy revisions, holds file locks, journals, backs up, republishes, and
  atomically replaces its local project storage.
- Server will perform the equivalent operation inside its database transaction.
- Host-specific records such as Desktop Flow layouts remain Host-owned but consume identity
  mappings returned by the Interpreter.

All legacy historical revisions are upgraded transactionally while retaining their revision numbers, so
Mission pins remain stable. Snapshot hashes and compiler fingerprints are regenerated from the
current canonical DSL. A migration commit must force the next revision number even when two
historical revisions normalize to identical current content; ordinary publishing continues to
deduplicate identical snapshots. The Host retains the pre-migration backup and audit information.

This whole-Project transaction is limited to a DSL `apiVersion` migration that changes semantic
resource identity. Project is the minimum safe owner because one identity map must cover historical
Revision pins and dependent Mission, Automation, and layout references. Desktop starts it on first
actual access to that Project, never while constructing stores, creating the application window, or
scanning storage for upgrade candidates. Failure leaves the backup authoritative, makes that
Project unavailable, and does not block the Desktop shell or unrelated persisted owners.

The supported migration window is explicit. All adjacent steps in that window remain registered.
Removing an old step is a DSL compatibility cutover that requires a separate ADR and an export,
backup, or offline-upgrade path.

Terminology is fixed as follows:

- `apiVersion`: Pragma DSL language version.
- `schemaVersion`: serialized Host or runtime-state format version.
- `revision`: immutable project content sequence.
- adapter or plugin version: independently shipped extension contract version.

## Consequences

- Desktop and Server share one DSL compatibility implementation without sharing persistence code.
- Historical DSL shapes and transformations stay out of normal parsing, compilation, and Host
  application logic.
- Hosts fail closed for mixed versions, future versions, missing migration steps, invalid migrated
  resources, identity conflicts, and unresolved references.
- Adding a DSL version requires a historical input schema, one adjacent migration step, fixtures,
  current-version no-op coverage, chained-upgrade coverage, and future-version rejection coverage.
- These whole-project publication rules apply to a DSL `apiVersion` migration with identity
  rewriting. A `compilerVersion` upgrade over immutable revisions instead uses the revision-scoped,
  derived-view policy in ADR 029.
