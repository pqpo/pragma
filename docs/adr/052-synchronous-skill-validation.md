# ADR 052: Synchronous Skill validation and manual review

## Status

Superseded in part by [ADR 057](./057-unified-memory-revision-learning.md). Synchronous draft validation
and human review remain; the Memory Skill candidate and promotion path are removed.

## Context

Skill submission previously started a second asynchronous Agent workflow that replayed source cases,
judged the result with a model, and stored an evaluation snapshot. This duplicated the revision
workflow, introduced a second model profile and Mission lifecycle, and could strand otherwise valid
drafts in `evaluating` or `needs_attention`. Memory-created candidates could also publish after this
evaluation without a consistent human review step.

## Decision

Remove the Skill Evaluation Agent and its replay protocol, model profile, IPC, UI, and asynchronous
processing path. `skill_revision_submit_draft` now performs deterministic validation synchronously.
It checks package/frontmatter consistency and package integrity only. The same validation applies to
creation, ordinary revision, Memory-generated changes, manual edits, and synchronization. Scripts may
use any language or extension, third-party dependencies, dynamic module loading, network calls, and
process APIs under the existing Runtime permissions. Supporting files may use any safe layout,
including dependency manifests, lockfiles, and assets. Script-to-test import coverage, required test
files, module allowlists, code-pattern scanning, and generated-only layout and per-file limits are
removed. Package limits remain 1000 files and 25 MiB, with safe unique relative paths, a root SKILL.md,
and regular files/directories only; symlinks, hard links, and special files remain unsupported.

Creators are responsible for testing affected behavior before submission, documenting interpreter and
dependency setup, and accurately summarizing checks and limitations. No test evidence field or new
approval step is required. Pragma does not automatically provision interpreters or dependencies.
Submission, approval, and synchronization never execute candidate scripts or tests and do not certify
code safety or correctness. Runtime execution permissions, human review, immutable snapshots,
concurrency checks, executable metadata, and publication integrity remain unchanged. This policy
relaxation does not change stored schemas or require data migration.

Validation failure returns `invalid_input` with path-addressed diagnostics and leaves the draft
editable. The Skill Revision Agent repairs the reported files and resubmits until validation passes.
For new Skills, the creation request supplies initial metadata. A successful submission copies the
validated SKILL.md name and description into the draft as part of the existing journaled transition;
the original request remains the creation intent. Review, rework, recovery, and publication use the
submitted draft metadata, including creation ID conflict recovery. Submission validates the immutable
temporary snapshot before publishing its canonical hash directory, and submission and publication
share the same YAML metadata parser. Invalid packages leave the editable draft metadata unchanged
and their temporary snapshots are removed. An existing same-hash submission is never deleted by
a failed validation. Edits made during validation return a working-tree conflict and remain editable.

A successful submission enters `pending_review`; approval repeats deterministic validation against
the immutable submission before publication. Memory-created and Memory-revised Skills follow the
same manual-review rule and are never auto-published.

Memory revisions of an existing Skill start a managed Skill Revision Mission with the draft mounted.
The Mission remains attached while the Agent repairs synchronous validation diagnostics. The Memory
candidate stays `revision_pending`; it becomes `promoted` and updates its routing binding only after
the formal Skill revision reaches `completed`.

Storage advances as follows:

- Skill revision jobs v3 → v4 and requests v3 → v4 remove evaluation and replay fields.
- Skill drafts v2 → v3 remove the `evaluating` state.
- Memory Skill candidates v1 → v2 remove evaluation and replay fields.

Legacy `evaluating` and `skill_evaluation_failed` records migrate to `needs_attention` with a stable
validation-required error. Their original records are backed up through the normal per-owner journal
before atomic replacement, so users can reopen and resubmit instead of losing the candidate.

## Consequences

- Draft submission has one deterministic result and no background evaluator to schedule or recover.
- Validation feedback is available directly to the revision Agent in the failing tool call.
- Candidate code is never executed as part of validation.
- Human approval is required for both user-created and Memory-derived Skill changes.
- Historical Skill Evaluation Mission origins remain readable only for persisted-history compatibility;
  no active code creates or executes them.

## Concurrent writers during submission

The Host serializes submission against Draft/Job control changes and rechecks the editable tree
following temporary-snapshot validation. Runtime-native writers do not participate in Host file
locks, so a final hash check cannot safely authorize unlinking their files. Successful submission
and cleanup-journal replay therefore rename the Workspace draft root atomically to a sibling named
`<draftId>.submitted-<revision>-<uuid>` instead of deleting it. This fences the old directory path
and preserves writes through already-open file handles, including writes after the last hash check.
The immutable submission remains the only review and publication input. Rework restores that
submission to a fresh editable directory; retained source directories are recovery artifacts and
are never overwritten or automatically deleted by submission or rework. They can be inspected and
removed by the user after writers have stopped. Replay is idempotent when the source is already
absent and preserves another directory if a stale writer recreated the source path.

No record or journal schema changes: the existing cleanup journal still records removal of the
original editable path; the retained sibling is a Workspace recovery artifact, not a new authority.
