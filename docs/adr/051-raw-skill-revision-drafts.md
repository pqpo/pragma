# ADR 051: Raw Skill revision drafts

## Status

Superseded in part by [ADR 052](./052-synchronous-skill-validation.md)

## Context

Skill packages are directories rather than text documents. They may contain Markdown, scripts,
images, binary fixtures, and executable files. A text-only change-set cannot preserve them faithfully.

## Decision

Desktop stores the authoritative control record and content-addressed immutable submissions under
`data/skill-revision-drafts/<draftId>/`. The editable tree lives in the owning user Workspace at
`.pragma/skill-revision-drafts/<draftId>/worktree`. The Mission keeps its user-selected Workspace;
the revision Agent receives the draft path from `skill_revision_start` and uses Runtime-native file
and shell tools to edit that path. In Git repositories Desktop adds the Workspace-local `.pragma`
directory to `.git/info/exclude` without changing the repository's tracked `.gitignore`.

Successful submission first publishes an immutable global candidate, atomically advances the Draft
and Job into review through a recoverable journal, and then removes the Workspace draft directory.
Cleanup failure does not make the committed submission unreadable and is retried from the journal.
Legacy globally stored editable trees migrate into their resolved owning Workspace on first access.

The Host preserves regular-file bytes and legal executable bits and rejects links, special files,
path escapes, packages without `SKILL.md`, and packages beyond the file and byte limits. Submission
checks the caller's tree hash, copies while verifying file hashes, rescans source and candidate, and
atomically publishes an immutable candidate. Validation and publication read only that candidate.

There is no rebase or merge protocol. A base change before submission or approval rejects the draft
with `skill_revision_base_changed`, revokes write ownership, and retains a read-only reference. The
Agent starts a new draft from the latest revision and regenerates still-valid work. All candidates,
including authenticated `memory-learning` requests, require user approval after synchronous validation.

Mission storage v11 adds the `skill-revision-draft` mount so ownership participates in session context
fingerprints and permission rebuilding. A Runtime without native file access must fail before a usable
draft is claimed.

## Consequences

- Binary and executable package content survives revision without a Skill-specific file API.
- Formal revisions remain immutable and publication stays idempotent.
- Conflicts are deterministic but require regenerating a new proposal.
- A Mission's configured Workspace does not change when it creates or resumes a Skill draft.
- Submitted editable trees do not remain in the user's Workspace; immutable review history remains
  in authoritative Desktop storage.
- Draft cleanup uses Host Trash; published revisions and completed history are never draft-deleted.
