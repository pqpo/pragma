# ADR 022: Resource-Scoped Project Change Sets

## Status

Superseded in part by ADR 023. Change-set concurrency remains accepted; resource-version identity
and “Create new version” do not.

## Context

Desktop edits Expert, ExpertTeam, and Flow resources inside one immutable Pragma project snapshot.
The project revision is global, so treating every stale revision as a conflict made independent
resource edits block each other. Desktop then accumulated its own merge and retry logic around
`PragmaProjectService`, while strict full-project publication and form-specific writes developed
different concurrency behavior.

Resource versions and project revisions also have different meanings:

- a resource version is part of the canonical resource identity;
- a project revision is an immutable snapshot used for compare-and-swap publication.

Changing a resource version during an ordinary edit silently changes identity and can invalidate
references. Creating a new version must instead preserve the source resource.

## Decision

### 1. Interpreter owns change-set concurrency

`@pragma/interpreter` defines the runtime-validated `PragmaProjectChangeSet`:

```text
baseRevision
upserts[]
removals[]
requiredUnchangedRefs[]
```

`PragmaProjectService.materializeChangeSet()` is the single merge implementation.
`validateChangeSet()` validates that materialized candidate, and `applyChangeSet()` validates and
publishes it with bounded compare-and-swap retries.

Desktop may add authoring policy and managed-resource cleanup, but it does not implement another
resource merge algorithm or retry loop.

### 2. Conflict detection is resource scoped

When `baseRevision` is stale, the service compares the base and current value of every ref in the
change set:

- a changed ref being upserted or removed is a conflict;
- an unchanged ref rebases onto the current project;
- an upsert already equal to the current value and a removal already absent are idempotent;
- every `requiredUnchangedRefs` entry must remain equal to its base value.

Therefore independent Expert, ExpertTeam, and Flow edits can commit, while concurrent edits to the
same canonical ref fail with the exact `conflictingRefs`.

The final repository commit remains a global project-revision compare-and-swap. A race after
materialization is retried by rematerializing the original change set. Exhausted transient races are
reported separately from semantic resource conflicts through `retryable`.

### 3. Full publication remains strict

`PragmaProjectService.publish()` replaces a complete project snapshot and requires its
`expectedRevision` to equal the current head. It does not rebase. Import, restore, and other
full-snapshot callers must resolve stale state explicitly.

### 4. Resource version changes are explicit creation

Ordinary Expert, ExpertTeam, and Flow editors lock both resource ID and resource version. An Expert
update contract does not contain a version field.

The explicit **Create new version** action:

- copies the selected resource into a create editor;
- locks its ID and allows a new version;
- upserts the new canonical ref without removing the source ref;
- captures the project revision at the start of editing;
- includes the source ref in `requiredUnchangedRefs`.

This allows unrelated concurrent changes to rebase while refusing to derive a new version from a
source that changed during editing.

### 5. IPC failures use data envelopes

Mutation IPC handlers return a discriminated success/error envelope. Project conflicts carry
`baseRevision`, `currentRevision`, `conflictingRefs`, and `retryable`; validation failures carry
diagnostics. Preload reconstructs a typed renderer error from this data.

Electron-native thrown `Error` serialization is not used as the domain-error protocol because it
does not reliably preserve custom fields.

## Consequences

- Expert, ExpertTeam, and Flow share one conflict, merge, validation, and retry engine.
- Adding another Pragma resource editor requires only a resource change set and optional Desktop
  policy; it must not add another project merge loop.
- A global project revision no longer causes false conflicts between unrelated resources.
- Dependencies read while constructing a change can opt into the same unchanged precondition
  mechanism.
- Creating a resource version and editing a resource are distinct commands with distinct contracts.
- Full-snapshot publication remains intentionally stricter than resource mutation.
