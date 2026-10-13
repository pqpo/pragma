# Discover Pragma Resources

Use authorized `pragma manage` commands with bounded JSON via `--input FILE|-`.
Read a subcommand's `--help` only when its input is needed; follow nextCursor with the same filters.
This version requires an owning Execution command channel. A Skill is not an authorization grant.

- `workspace list`: returns absolute workspaceId paths from recorded/default/current workspaces.
- `home-project list|get`: returns saved home-page task presets with executor, workspace and
  knowledge bindings. get takes projectId. These presets are distinct from the DSL Project.
- `knowledge-store list`: returns host storeId values and availability. Only ready stores can be
  selected for contextStoreIds; these IDs are distinct from DSL ContextStore refs.

Use `pragma manage dsl resources list|read` for DSL resources and exact executor refs.
For performing tasks, read [Missions](missions.md); for schedules, discover
the automations reference. Inspect availability and retain actual IDs returned by the Host.
Do not scan managed storage or infer a workspace path from its display label.

## Managed knowledge and Skill changes

Formal knowledge and Skill packages are read-only to Agents. For creation or modification,
Pragma must first use spawn_expert for Store Revision Agent (expertId 0000000000st0rev) or
Skill Revision Agent (expertId 0000000000sk1rev), supplying the complete requirements and source
content. Retain the returned contextId and wait_experts on the invocationId. Use continue_expert
with that exact contextId for related follow-up work; list_agents can recover it after compaction
or reopening. Multiple Contexts for one expertId are distinct conversations, not interchangeable. Do not try native filesystem, shell, or context writes first.
Only revision drafts are writable; human approval applies them.

A review returned for changes restores `editing` on the same draft. Continue the original
Revision Agent Context with continue_expert, its draftId, and full review feedback, then wait
for the new invocationId. Knowledge drafts must be reclaimed with knowledge_revision_start and
that draftId, followed by read_expert_context in the returned writableNamespace for fresh
content and etag before editing. Skill drafts must be remounted with skill_revision_start and
that draftId. Reuse the original Mission and draft; a closed or unavailable Context requires
an explicit diagnostic, not a replacement Context or task. Rejection ends the revision instead of returning it for continued editing.
