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
