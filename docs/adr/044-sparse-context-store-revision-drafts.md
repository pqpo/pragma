# ADR 044: Sparse Context Store Revision Drafts

- Status: Accepted
- Date: 2026-08-27
- Supersedes in part: [ADR 039](./039-promoted-knowledge-stores-and-agent-revision.md)

## Context

ADR 039 made published knowledge immutable to Agents, but its read-only Store plus complete JSON
change-set output forced the Agent to reconstruct a second editing protocol. It also hid the Store
Revision Agent and removed its Mission after execution, preventing collaborative editing and normal
task observability.

## Decision

Every Agent-driven knowledge revision targets a named sparse draft. A draft pins the published
Store id, revision, and snapshot hash and persists only changed files and metadata, deletion
tombstones, and required directory changes under
`~/.pragma/data/context-store-drafts/<draftId>/`. Reads, lists, and searches merge this overlay with
the pinned base snapshot; the overlay wins and tombstones hide base entries. Unchanged published
content is never copied.

The Studio editor uses the same canonical overlay and materialization functions for one recoverable
editor draft per Store under `~/.pragma/state/context-store-editor-drafts/`. Background backup only
updates that sparse draft. It does not publish a Store revision. The explicit Save action atomically
publishes all pending paths as one revision; leaving the editor requires Save, Discard, or Cancel.

Published revision files contain only a compact immutable manifest and Merkle root. File payloads and
tree objects are addressed by SHA-256 in the global `~/.pragma/data/objects/sha256/` pool, so an
unchanged file references the same object across revisions and Stores. Historical full-snapshot
files are upgraded lazily on first access to their owning Store, with a recoverable backup and a
versioned completion marker. Object garbage collection scans every published revision root and is
performed only by the globally locked storage-maintenance pass, never on the user-visible revision
commit path.

The draft implements `ExpertAgentContextStore`, so the mounted Store Revision Agent uses the normal
`add_expert_context`, `edit_expert_context`, and `delete_expert_context` tools. Draft mutations do
not require publication approval, but use draft and entry CAS. A mutation after submission returns
the draft to `editing` and invalidates its prior review.

The lifecycle is `editing -> pending_review -> merging -> merged`, with `needs_rebase` and
`needs_attention` recovery states. Submission requires a non-empty overlay and validates progressive
disclosure and internal Markdown links. Approval converts the overlay to a minimal change set and
reuses the published Store journal, atomic replacement, revision record, and revision/hash CAS.
Published drift moves the task to `needs_rebase`; it never overwrites or creates a replacement task.
Explicit three-way rebase detects path, delete/modify, rename-equivalent, and directory-ancestor
conflicts and updates the base exactly once after every conflict has a resolution.

Store Revision remains a statically defined YAML built-in Expert, but is listed, editable, resettable,
and selectable as an ordinary Mission executor like Pragma. Its Pragma management capability is an
opaque system requirement and cannot be removed by customization. The editor exposes these fixed
tools as locked system tools rather than hiding them.

Mission Knowledge is the authority and recovery model for both published Stores and sparse drafts.
Mission schema v10 replaces `contextStoreIds` with typed `contextMounts`; the adjacent v9-to-v10
migration converts every old id to a published Store mount using a backup, stable journal, and atomic
replacement. Published Store mounts and ordinary draft mounts are read-only. A draft mount is
writable only when it carries a revision-job claim owned by the current Mission. Context operations
also verify the caller's durable Runtime Context against the job's originating Invocation. For a
standalone Store Revision Mission, only its root Invocation can access the claimed draft. A Mission's
root caller retains its root-owned draft after context binding changes rebuild its Runtime Context;
this continuity does not grant another teammate access.

When an Expert or Team member starts a revision inside a Mission, the Host attaches the draft to
that same Mission before returning. With pre-registered dynamic draft namespaces, the existing
published Store mount remains read-only for other members; an explicitly selected, previously
unmounted target receives a claimed draft mount. The Host acknowledges the new mount fingerprint
in that same atomic Mission write and retains the ExpertSession, so a later `continue_expert`
still resolves the original teammate Context, including after reopening storage. Concurrent mounts
keep the message gate closed until all changes finish. The eligible namespace list is refreshed
for every Invocation, including knowledge bases created after the Mission started. Each Context operation resolves that knowledge base's current claimed draft,
so `start -> edit -> submit` works in one turn even though the Invocation's original Context index was
assembled before the draft existed. `knowledge_revision_start` returns the exact writable namespace.
The mount remains the authority for ownership, later-Session indexing, recovery, and cleanup; draft
existence alone never grants write access.

One Mission may claim drafts for multiple explicitly selected knowledge bases. Claims and writable
namespaces are unique per Store, and each draft is rebased and submitted independently. A durable,
per-(Mission, Store) claim journal is written before creating or attaching the draft and job, so
concurrent starts with different inputs converge on one claim. Managed background revision Missions
use the same claimed draft mounts. On the next access to that Mission target, recovery materializes
the exact journaled job and draft, completes a missing mount, or releases a claim whose Mission no
longer exists; startup never scans every Mission or revision job.

Draft mounts are Host-owned and are never offered by Home, Mission settings, branches, or other user
resource pickers. A Store Revision Agent can continue an existing draft by passing its `draftId` to
`knowledge_revision_start`. If another Mission owns the claim, the Host transfers it only after the
previous Mission has no active execution or queued prompt: the previous Mission restores its
published Store mount, then the new Mission receives the same revision job and draft. Active work is
never preempted, and transfer failure restores the previous claim when it is still unowned.

Mission-claim release is journaled after the Mission deletion owner transaction commits, or when a
missing Mission is recovered. This ordering never marks a live Mission's draft as deleted if owner
deletion aborts. A release preserves the sparse overlay, clears both draft and job claims, and moves
unfinished work to `needs_attention` with a stable `mission_deleted` or `mission_orphaned` error. It
never automatically discards user changes or re-runs the revision. Draft and revision lists isolate
unreadable records so one damaged or stale association cannot block healthy records or the recovery
controls.

The Tasks automation list is an inbox for independent background work whose process is not already
visible in the user's current Mission. Automation-triggered Missions, user-submitted Knowledge
revisions, and Memory learning's Knowledge revisions appear there. Background revision Missions
retain `system-store-revision` origin and link to their job without inventing an Automation ref.
Foreground Expert/Team revisions stay in their originating Mission and create no extra Mission.
Historical independent revisions with job source `expert-reflection` remain accessible through
Knowledge revision details but are excluded from both top-level task lists. Host list queries and
updates share one source resolver; unreadable source records report `mission_revision_source_unavailable`
and do not block unrelated tasks. A filtered task list is not evidence of deletion: composer cleanup
only removes confirmed completed/deleted entries, and an asynchronous detail-source lookup must
not override a newer selection. No historical Mission, Execution, or Session is rewritten.
Memory Curator extraction is a future addition to this inbox; its visibility is unchanged here.
One draft has at most one active Mission; concurrent user edits remain protected by CAS.

The v2 revision-job reader performs a statically registered v1-to-v2 migration. Pending review
change sets become sparse overlays; active legacy work becomes a draft plus runnable Mission; terminal
and recovery meaning is preserved. The host writes a backup and stable migration record before using
the upgraded job, and rejects future versions.

Discard moves an unmerged draft to recoverable trash. Published Store deletion is blocked only by
unmerged, undiscarded drafts; deleting a Mission does not delete its draft.

## Consequences

- Published knowledge remains impossible for an Agent to mutate directly.
- Draft storage scales with changed content rather than Store size.
- Published revision storage scales with changed objects rather than full Store copies.
- Human and Agent editing share one Context Store protocol and one conflict model.
- Review, rebase, Mission history, and publication become independently observable stages.
- Hosts must preserve pinned base snapshots while a live draft references them.

## Revision entry points and regression protection (#246)

An authorized caller may request a revision of any listed knowledge base, including an unmounted
target. Mission-bound submissions use the original Mission and return its writable namespace;
no missing mount or teammate call implicitly starts background work. Unknown or unavailable targets
fail with an actionable error. The caller must retain access through the revision's Runtime Context;
another teammate does not inherit draft writes merely by sharing the Mission.
Submissions without a Mission (Knowledge UI and Memory learning) retain the managed background path.
Background Missions do not inherit another Mission's Board or relative paths.

`pnpm test:revision` protects both entry points in PR and release CI, independently of `test:core`.
The #241 regression changed existing successful entry-point tests to assert rejection; narrowing
supported behavior requires an explicit product requirement, not merely updated implementation tests.

### Historical verification for #246 (2026-09-15, before foreground ownership update)

- The business regression suite covers ordinary Experts, Team delegation to Store Revision Agent,
  unmounted targets, inline writes, historical jobs, deletion recovery, and requests arriving during
  background processing. It uses temporary stores and the real Host services with a test Runtime.
- Reintroducing the #241 `inlineMission === undefined` rejection makes the unmounted-target
  regression test fail with `knowledge_revision_mission_unavailable`. Restoring the fix passes it.
- Real Runtime acceptance is still outstanding: Qoder CLI exited with code 41 before completing the
  flow; Antigravity reported that it was not signed in. Neither attempt counts as successful smoke
  validation. After authenticating Antigravity outside Pragma, rerun the isolated smoke:

```sh
PRAGMA_LOG_LEVEL=error PRAGMA_REVISION_REAL_SMOKE=1 pnpm --filter @pragma/desktop exec vitest run src/main/features/missions/mission-runner.test.ts -t 'background Mission from expert:0000000000000002'
```

The smoke uses a temporary knowledge base and Antigravity's real Runtime adapter. Management-tool
approval is disabled only in this opt-in test fixture. Success requires a background Mission, a
written draft in `pending_review`, and an unchanged formal Store snapshot; no publication occurs.

### Follow-up code review

- Continuing an attached background draft now enqueues the new prompt on its existing Mission
  through the Host controller, with a stable request ID per tool operation. Replayed deliveries are
  detected in the persisted prompt history, including after the draft reaches review. A task that
  has not acquired a Mission reports an actionable rejection instead of silently dropping new input.
- Explicit draft selection is checked inside the Mission claim lock as well as at the tool entry
  point, preventing concurrent callers from receiving a different draft than requested.
- Submission resolves the active task by draft and Mission ownership. It never revives the first
  historical task returned by filesystem enumeration. Stopped Mission owners must be recovered
  before another task can be created for their draft.
- The background drain also rechecks wakeups during completion cleanup so requests cannot be lost
  between resolving the drain promise and clearing its active marker.
