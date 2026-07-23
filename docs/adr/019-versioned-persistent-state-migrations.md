# ADR 019: Versioned Persistent State Migrations

## Status

Accepted.

## Context

Desktop keeps recoverable Execution, ExpertSession, and Runtime Session state across application
upgrades. A schema change previously replaced the reader with the new Zod schema and rejected every
older record. In particular, changing `pragma.execution/v5` to `pragma.execution/v6` made the
Mission Work projection fail before it could reconstruct an existing ExpertTeam's child
Invocations. The UI consequently showed only the Execution status.

This failure was unrelated to the `pragma/v2` YAML DSL. DSL source compatibility and persisted
runtime-state compatibility are separate policies and must not share version switches.

Pragma will continue to change these schemas. Keeping parallel readers and compatibility branches
throughout the domain model would make every call site harder to reason about, while rejecting all
old state would make routine application upgrades destructive.

## Decision

Persisted recoverable state uses a forward-only migration boundary:

1. Each independently versioned document family has one current Zod schema and a
   `pragma.<family>/vN` discriminator.
2. Compatibility within the current storage major is expressed as explicit adjacent transforms
   (`vN -> vN+1`). Domain code only receives the current schema; it never branches on historical
   fields.
3. A store checks and upgrades state lazily on first access while holding that aggregate's existing
   file lock. Current records take the validation-only fast path and are not rewritten.
4. Multi-document changes first persist a stable `pragma.state-migration/v1` journal containing the
   complete validated target documents. Each target is replaced atomically, and the journal is
   removed last. A later access replays an incomplete journal, making interruption at any write
   point recoverable.
5. Pending business transaction journals are themselves versioned and migrated before replay.
   Their embedded snapshots must be upgraded by the same migration functions as ordinary state.
6. State written by a newer application fails closed with `unsupported-state-version`; Pragma never
   guesses, silently deletes data, or attempts a downgrade.
7. An unsupported old version also fails closed. Removing migration steps requires an explicit
   storage-major cutover with a documented export/import or backup path; it is not part of an
   ordinary schema bump.

Append-only event schemas follow the same version ownership rule, but their future transforms
should be pure read upcasters unless an explicit compaction migration is justified. Snapshot and
event migrations must not be conflated.

The first implementation registers the three core recovery families:

- Execution: migrates `pragma.execution/v5` to `v6`, including Expert, ExpertTeam, and Flow
  Invocation output handoffs; Task and HumanTask output retains its structured-value semantics.
- Execution transaction: migrates `pragma.execution-transaction/v6` to `v7` before replay.
- ExpertSession: registers `pragma.expert-session/v4` as current and migrates transaction journals
  from `v4` to `v5`, including an embedded v5 Execution.
- Runtime Session: registers `pragma.runtime-session/v2` as current and applies the same
  newer/unsupported fail-closed policy.

Migration functions and the atomic journal live in `@pragma/core` because they govern Node-local
recoverable state. Cross-process current schemas remain owned by `@pragma/shared`.

Core organizes these definitions under `src/storage/migrations/<family>/`. Immutable historical
schemas live in `schemas/vN.ts`, each adjacent transform lives in `steps/vN-to-vN+1.ts`, and the
family `index.ts` statically registers the ordered chain. Stores import only the family index; they
do not own historical schemas or transformation logic.

## Consequences

- A normal schema bump adds one current schema, one adjacent transform, and old-state fixture tests;
  historical shapes do not leak into runtime services or UI.
- Opening an old Mission can make a bounded one-time disk write. A failed migration remains
  recoverable from its journal and is retried on the next access.
- Forward-only means installing an older application after migration may make that data unreadable.
  Product update flows must not describe application downgrade as supported.
- Work history now reports a recoverable read error with retry instead of presenting an empty or
  status-only projection when state cannot be loaded.
- Migration coverage is part of the storage contract. Tests must include current-state no-op,
  supported-old upgrade, interrupted-journal recovery, pending-transaction recovery, and
  newer-version rejection where applicable.
