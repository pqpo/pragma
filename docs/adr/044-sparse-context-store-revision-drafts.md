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
writable only when it carries a revision-job claim and the current Mission is owned by that job's
Store Revision Agent.

When Store Revision is selected directly and starts a revision for an already mounted published
Store, the Host attaches the draft to the same Mission and replaces that Store mount with a claimed
draft mount before returning. The Invocation pre-registers one dynamic writable namespace for every
eligible knowledge base. Each Context operation resolves that knowledge base's current claimed draft,
so `start -> edit -> submit` works in one turn even though the Invocation's original Context index was
assembled before the draft existed. `knowledge_revision_start` returns the exact writable namespace.
The mount remains the authority for ownership, later-Session indexing, recovery, and cleanup; draft
existence alone never grants write access.

One Store Revision Mission may claim drafts for multiple mounted knowledge bases. Claims and writable
namespaces are unique per Store, and each draft is rebased and submitted independently. Starting a
second active draft for the same Store is rejected. Managed background revision Missions use the same
claimed draft mounts. The attached running revision job is the stable transition journal: startup
recovery completes a missing Mission mount or detaches a job whose Mission no longer exists.

Draft mounts are Host-owned and are never offered by Home, Mission settings, branches, or other user
resource pickers. A Store Revision Agent can continue an existing draft by passing its `draftId` to
`knowledge_revision_start`. If another Mission owns the claim, the Host transfers it only after the
previous Mission has no active execution or queued prompt: the previous Mission restores its
published Store mount, then the new Mission receives the same revision job and draft. Active work is
never preempted, and transfer failure restores the previous claim when it is still unowned.

Revision Missions retain the authoritative `system-store-revision` origin and are shown as managed
automation Missions in Tasks. They retain their conversation and tool trace after completion. The
revision job and Mission link to each other without inventing an Automation resource id. One draft
has at most one active Agent Mission; user edits remain concurrent and are protected by CAS.

The v2 revision-job reader performs a statically registered v1-to-v2 migration. Pending review
change sets become sparse overlays; active legacy work becomes a draft plus runnable Mission; terminal
and recovery meaning is preserved. The host writes a backup and stable migration record before using
the upgraded job, and rejects future versions.

Discard moves an unmerged draft to recoverable trash. Published Store deletion is blocked only by
unmerged, undiscarded drafts; deleting a Mission does not delete its draft.

## Consequences

- Published knowledge remains impossible for an Agent to mutate directly.
- Draft storage scales with changed content rather than Store size.
- Human and Agent editing share one Context Store protocol and one conflict model.
- Review, rebase, Mission history, and publication become independently observable stages.
- Hosts must preserve pinned base snapshots while a live draft references them.
