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

## Current Context stores

Use the native `list_context_stores({})` tool to discover concrete Store namespaces and names
registered for this execution context, including mounted knowledge, Memory and Board stores.
This is separate from `pragma manage knowledge-store list`, which discovers formal knowledge
resources that may be selected for mounting. A host storeId or DSL ContextStore ref is not a namespace.

`list_context_stores` does not query document indexes or contents. Follow its `nextCursor` with
`cursor` until the desired Store is found; restart with `{}` if registrations change and the cursor
expires. Copy namespace verbatim. Registration alone does not establish Store health or authorize
an operation. Dynamic namespace prefixes are not concrete Stores and are omitted.

Use `list_expert_context` to page through document ids and descriptions, normally with the chosen
namespace; it does not return a Store directory, Store names, or Store item counts. Its document
cursor is separate from the Store directory cursor. Read documents with `read_expert_context`.

For an unregistered or malformed namespace error, follow the tool's recovery instruction to call
`list_context_stores`, copy an exact namespace, and retry. Never repeat the unchanged invalid value
or diagnose a storage outage from an addressing error. For revision drafts, read [Knowledge](knowledge.md) or [Skills](skills.md): discovering a namespace does not establish draft ownership.

## Formal content and revisions

Read [Skills](skills.md) to find and read Skill Capabilities and request repairs.
Read [Knowledge](knowledge.md) to list/search/read formal knowledge documents and request revisions.
These authorized CLI queries work for unmounted resources. Context tools above query only registered
Stores; they do not replace formal catalog or content queries.
