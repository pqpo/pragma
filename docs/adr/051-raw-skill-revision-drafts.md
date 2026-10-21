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
- Submission removes the active editable path; immutable review history remains in authoritative
  Desktop storage. Source directories are retained as Workspace recovery artifacts to preserve
  concurrent writes, as specified in [ADR 052](./052-synchronous-skill-validation.md).
- Draft cleanup uses Host Trash; published revisions and completed history are never draft-deleted.

## Desktop manual edits and revision history

The Desktop file editor publishes a validated immutable Skill revision directly through the existing
Capability mutation coordinator. It does not create a revision Agent Job or a pending-review Draft.
The revision includes `manual-revision.json`, with schema `pragma.skill-manual-revision/v1`, in the
same staged revision directory as its definition and payload. The existing publication transaction
therefore commits the file snapshot and its history record together. Identical saves create neither
a revision nor an additional record; conflicts and failed publication do not create visible history.

This new metadata family does not change the Capability manifest, existing snapshot hashes, or the
Job/Draft schemas. Published revisions that predate the metadata remain readable and are not labeled
as manual edits without evidence. No historical manual records existed before v1, so no prior-version
migration applies. Readers reject unknown record versions or identity/hash mismatches while keeping
the Skill payload available through its ordinary resource API.

The revision screen combines Agent Jobs with immutable manual records and filters them by Skill and
status. Manual records expose the saved revision, its parent, timestamp, and changed file/directory
entries. File previews use the same metadata, size/line limits, binary handling, and line-diff view as
Agent reviews; bytes are loaded from the two published immutable revisions. Directory-only edits are
recorded even when the existing file-content snapshot hash is unchanged.

## Return a review for changes (#383)

The review has three distinct actions: approve applies the candidate, return for changes preserves
the draft and returns it to `editing`, and reject ends the revision without applying it. Returning
retains the same draft/job identities, request, base, summary, and original Mission association; it
clears the submission pin so the Agent can inspect, edit, and submit the same candidate repeatedly.
The Host restores the immutable submitted package into the original Workspace draft directory and
restores ownership from the job's Mission before exposing a writable draftPath. The original Agent
uses `skill_revision_start` with that draftId to remount it; a different Mission cannot claim it.
Repeated submissions with the same content reuse the verified immutable snapshot.

The selected draft and job are updated under their existing aggregate locks with a versioned
`rework.json` journal in that draft's authority directory. First owner access replays interrupted
updates without overwriting an already restored editable tree. Future journals fail closed and
remain available for diagnosis; unrelated owner access continues. Existing draft/job schemas and
state names are unchanged, so existing persisted records require no migration. This adds an
explicit review operation and does not reinterpret prior rejected records.

Pragma delegates managed content changes to the corresponding Revision Agent before trying any
write. Formal content is read-only to Agents; only drafts are writable. Human approval remains
the publication boundary. Continuation carries the draftId and review feedback to the original
Revision Agent conversation rather than creating a replacement.

### CR follow-up for #383

Submission still removes the editable workspace tree and Mission mount. Returning for changes
replays a Host callback before retiring the rework journal. The callback restores a Skill mount
only when that candidate exactly matches the persisted Session's original Context fingerprint.
This restores the original compilation identity and Native Session for both retained owners and
cold recovery, while leaving newly changed Mission authority untouched. The callback runs outside
Skill aggregate locks to avoid an inverse dependency on Mission fencing and resource resolution.

Unreadable rework journals quarantine only their own list entries with a stable recovery diagnostic;
healthy drafts/jobs and background processing continue. Reject and return validate and mutate the
same draft/job pair under the existing locks so concurrent review decisions cannot leave a returned
job paired with a rejected draft. Tests cover retained/cold Native Sessions over two review returns,
interrupted Host callbacks, invalid journal isolation, and competing review decisions.

### PR #384 review corrections

New deliberate rejections persist `revision_user_rejected` in the existing Job error field.
All retry/resume entries and the review UI treat that reason as terminal; a new revision requires
a new draft. Historical stopped/rejected records without that reason keep their existing recovery
semantics. No stored Schema or version changes, or reinterpretation of supported historical data,
are required. A rejected Store draft remains read-only in `needs_attention`, with its Job retaining
the terminal reason; it no longer counts as an actionable unmerged draft.

When the original Skill Mission was deleted during review, the return journal completes by
clearing only that stale Mission ownership and setting the Job to `needs_attention` with
`mission_orphaned`. The editable draft and files remain available. No Mission is automatically
created; the user must explicitly choose a new Mission to continue. The amended journal is
persisted before either owner record is reconciled and remains replayable after a crash.

If a restore callback fails transiently, retrying the same return while its journal still exists
finishes recovery and returns the resulting Job. The journal identifies the exact source Job
revision; unrelated or already completed stale requests continue to conflict. Review-action
failures refresh the UI from persisted state before displaying the error.

Opt-in real-model validation uses isolated temporary resources and the existing authenticated
Codex Runtime. The Store and Skill Mission cases each perform two returns/resubmissions; the Skill
case also compares persisted Native Session refs. A separate selection harness loads the default
Pragma instructions and tool descriptions, supplies controlled delegate receipts, and verifies
that the model calls the matching Revision tool before a direct management write. It does not
claim to test the complete Pragma-to-Revision compiler/Invocation chain.

```sh
PRAGMA_LOG_LEVEL=error PRAGMA_REVISION_REAL_SMOKE=1 PRAGMA_REVISION_REAL_RUNTIME=codex \
  pnpm --filter @pragma/desktop exec vitest run \
  src/main/features/missions/desktop-mission-adapter.test.ts \
  -t 'unmounted target inside the original Mission from expert:0000000000st0rev|Skill revision Session.*cold=false|default Pragma instructions'
```
