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
Pragma must first call the Store Revision Agent or Skill Revision Agent with the complete
requirements and source content. Do not try native filesystem, shell, or context writes first.
Only revision drafts are writable; human approval applies them.

A review returned for changes restores `editing` on the same draft. Continue the original
Revision Agent conversation with its draftId and review feedback; inspect, edit, and submit
again in the original Mission. Skill drafts must be remounted with `skill_revision_start`
and that draftId. Rejection ends the revision instead of returning it for continued editing.
