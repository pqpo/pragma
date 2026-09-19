# ADR 051: Raw Skill revision drafts

## Status

Accepted

## Context

Skill packages are directories rather than text documents. They may contain Markdown, scripts,
images, binary fixtures, and executable files. A text-only change-set cannot preserve them faithfully.

## Decision

Desktop stores each draft under `data/skill-revision-drafts/<draftId>/` with a private control record,
a writable `worktree/`, and content-addressed immutable `submissions/`. Only the exact worktree is
made writable to its owning Mission. Runtime-native file and shell tools perform edits; the six
management tools only discover, create, inspect, submit, and discard drafts.

The Host preserves regular-file bytes and legal executable bits and rejects links, special files,
path escapes, packages without `SKILL.md`, and packages beyond the file and byte limits. Submission
checks the caller's tree hash, copies while verifying file hashes, rescans source and candidate, and
atomically publishes an immutable candidate. Evaluation and publication read only that candidate.

There is no rebase or merge protocol. A base change before submission or approval rejects the draft
with `skill_revision_base_changed`, revokes write ownership, and retains a read-only reference. The
Agent starts a new draft from the latest revision and regenerates still-valid work. Ordinary candidates
require user approval; authenticated `memory-learning` requests may auto-approve after evaluation.

Mission storage v11 adds the `skill-revision-draft` mount so ownership participates in session context
fingerprints and permission rebuilding. A Runtime without native file access must fail before a usable
draft is claimed.

## Consequences

- Binary and executable package content survives revision without a Skill-specific file API.
- Formal revisions remain immutable and publication stays idempotent.
- Conflicts are deterministic but require regenerating a new proposal.
- Draft cleanup uses Host Trash; published revisions and completed history are never draft-deleted.
