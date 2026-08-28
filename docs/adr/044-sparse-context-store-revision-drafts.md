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
opaque system requirement and cannot be removed by customization. Without a draft binding it can
use management tools to create or select one and start a bound Mission. With a binding it edits the
draft through native Context tools and must submit before finishing.

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
