# ADR 052: Synchronous Skill validation and manual review

## Status

Accepted

## Context

Skill submission previously started a second asynchronous Agent workflow that replayed source cases,
judged the result with a model, and stored an evaluation snapshot. This duplicated the revision
workflow, introduced a second model profile and Mission lifecycle, and could strand otherwise valid
drafts in `evaluating` or `needs_attention`. Memory-created candidates could also publish after this
evaluation without a consistent human review step.

## Decision

Remove the Skill Evaluation Agent and its replay protocol, model profile, IPC, UI, and asynchronous
processing path. `skill_revision_submit_draft` now performs deterministic validation synchronously.
It checks package/frontmatter consistency, script-to-test import coverage, static import allowlists,
and forbidden dynamic-loading, network, and process escape patterns. It does not execute candidate
scripts or `node:test` files.

Validation failure returns `invalid_input` with path-addressed diagnostics and leaves the draft
editable. The Skill Revision Agent repairs the reported files and resubmits until validation passes.
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
