# ADR 055: Mission-owned DSL file drafts

## Status

Accepted

## Context

Pragma originally required an Agent to submit complete YAML strings to `prepare_dsl_changes`.
Changing one character in a long Expert prompt or coordinating one ExpertTeam with several Experts
therefore repeated the full documents through tool arguments, made native diff inspection awkward,
and encouraged expensive retry loops. Field-specific patch tools would reduce some payload but would
duplicate DSL semantics and could not cover future or unknown fields safely.

## Decision

Expert and ExpertTeam authoring uses a Mission-owned, multi-resource file draft. The Host creates the
draft with `start_dsl_draft`, allocates identities for new resources, and materializes canonical YAML
files under the Mission Workspace at `.pragma/dsl-drafts/<draftId>/worktree/`. The Agent edits those
files with its Runtime-native file tools and submits only the opaque `draftId` to
`prepare_dsl_draft`. Mission identity and Workspace path are Host-injected and are not tool inputs.

Authoritative draft records and content-addressed immutable submissions live in Host-private state
under `dsl-resource-drafts/<draftId>/`. These paths are never returned to the Runtime. The Host
accepts only the exact regular files declared by the draft, rejects links, special files, path
escapes, additions, deletions, renames and oversized files, and creates a stable double-scanned
snapshot before parsing or validation. It verifies an existing content-addressed submission against
its directory hash before reuse and rechecks the editable tree after validation so edits arriving
during prepare are preserved for the next attempt. Invalid prepare attempts remove their private
snapshots. Resource kind and semantic
identity cannot be changed through a draft. A successful prepare feeds the existing Project change-set
and commit pipeline; the editable Workspace tree is then removed. Prepare, restart and discard are
serialized by a per-draft cross-process lock. Mission identity and Workspace path participate in the
management binding fingerprint so a compiled binding cannot be reused across Mission scopes.

The generic full-source `prepare_dsl_changes` entry and Flow `additionalSources` reject Expert and
ExpertTeam resources. This makes the file-draft route mandatory for Agent-facing authoring while the
Host's internal project adapter can still seed trusted resources.

One draft can create or edit multiple Experts and ExpertTeams atomically. New resources receive their
canonical IDs before editing and begin as intentionally incomplete YAML skeletons. This lets files in
the same draft refer to one another without adding an Agent-side ID or patch protocol.

Concurrency is resource-scoped as defined by [ADR 022](./022-resource-scoped-project-change-sets.md).
Unrelated Project revisions can rebase, while a changed target moves the draft to `conflicted`. The
conflicting candidate is first frozen as an immutable reference and its editable tree is removed.
`restart_dsl_draft` creates a fresh draft from current resources, preserves still-available create
IDs, and returns the old immutable candidate for manual comparison; if a create ID was occupied
concurrently, the Host allocates a fresh ID instead. The Host does not guess a textual merge.
A restart copies the old candidate into a read-only reference directory in the new Mission Workspace;
it does not expose the authoritative private submission path.
A prepared draft can also restart after a later commit conflict when its candidate resources have
been superseded by current resources that match neither the base nor the prepared candidate.

Draft records start at `pragma.dsl-draft/v1`; discard journals start at
`pragma.dsl-draft-discard/v1`. These are new persistent-state families and have no historical source
version to migrate. Future incompatible versions require adjacent migrations under the repository's
persistent-state rules. Discard first writes a stable journal, moves the Workspace draft into Host
Trash, and marks the record discarded. Listing or accessing drafts replays an interrupted journal.
Replay treats a completed cross-device copy with a still-present source as an interrupted move and
rebuilds the Trash destination idempotently. A committed change-set moves its originating draft from
`prepared` to terminal `committed`, records the Project revision and removes the private submission.
Mission deletion discards its remaining editable, conflicted or prepared drafts before completing
cleanup. Recognized corrupt draft records fail listing closed instead of disappearing from results.

## Consequences

- A one-character prompt change transfers only the file edit plus a small draft identifier at prepare
  time, instead of embedding the full resource in a management-tool call.
- Agents get ordinary file editing, diffing and validation while the Interpreter remains the sole DSL
  parser and schema authority.
- Multi-resource ExpertTeam changes remain atomic without requiring full Project submission.
- Conflict handling is deterministic and preserves the old candidate, but intentional reconciliation
  happens in a newly based draft.
- The Host owns path safety, immutable snapshots, Mission authorization, cleanup and crash recovery;
  Runtime agents never receive authoritative storage paths.
