# ADR 022: Resource-Scoped Project Change Sets

## Status

Accepted for change-set concurrency. Resource identity and revision semantics are defined by
[ADR 023](./023-semantic-resource-identity-and-project-revisions.md).

## Context

Desktop edits multiple resource types inside immutable Pragma Project snapshots. The Project revision is global,
but unrelated resources should not conflict merely because they were edited from different snapshots. Merge,
validation and retry behavior must also remain identical across editors and Host entry points.

## Decision

`@pragma/interpreter` owns the runtime-validated `PragmaProjectChangeSet`:

```text
baseRevision
upserts[]
removals[]
requiredUnchangedRefs[]
```

`PragmaProjectService.materializeChangeSet()` is the single merge implementation.
`validateChangeSet()` validates the materialized candidate, and `applyChangeSet()` validates and publishes it with
bounded compare-and-swap retries. Hosts may add authoring policy and managed-resource cleanup, but do not implement
another resource merge or retry algorithm.

When `baseRevision` is stale, the service compares the base and current value of every ref in the change set:

- a changed ref being upserted or removed is a conflict;
- an unchanged ref rebases onto the current Project;
- an upsert already equal to the current value and a removal already absent are idempotent;
- every `requiredUnchangedRefs` entry must remain equal to its base value.

The final repository commit remains a global Project-revision CAS. A race after materialization is retried by
rematerializing the original change set. Exhausted transient races are reported separately from semantic resource
conflicts through `retryable`.

`PragmaProjectService.publish()` replaces a complete Project snapshot and requires `expectedRevision` to equal the
current head. Import, restore and other full-snapshot callers resolve stale state explicitly.

Mutation IPC returns a discriminated success/error envelope. Project conflicts carry `baseRevision`,
`currentRevision`, `conflictingRefs` and `retryable`; validation failures carry diagnostics. Electron-native thrown
`Error` serialization is not used as the domain-error protocol.

## Consequences

- Resource editors share one conflict, merge, validation and retry engine.
- Independent resource edits can commit without producing false global conflicts.
- Dependencies read while constructing a change can participate in the same unchanged precondition mechanism.
- Full-snapshot publication remains intentionally stricter than resource mutation.
