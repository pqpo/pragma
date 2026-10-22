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
or diagnose a storage outage from an addressing error. For revision drafts, keep the revision
list/get and reclaim workflow below: discovering a namespace does not establish draft ownership.

## Managed knowledge and Skill changes

Formal knowledge and Skill packages are read-only to Agents. For creation or modification,
Pragma must first use spawn_expert for Store Revision Agent (expertId 0000000000st0rev) or
Skill Revision Agent (expertId 0000000000sk1rev), supplying the complete requirements and source
content. Retain the returned contextId and wait_experts on the invocationId. Use continue_expert
with that exact contextId for related follow-up work; list_agents can recover it after compaction
or reopening. Multiple Contexts for one expertId are distinct conversations, not interchangeable. Do not try native filesystem, shell, or context writes first.
Only revision drafts are writable. Knowledge submissions use the knowledge base approval setting:
human review by default, or automatic approval and application when configured to skip approval.
Always delegate knowledge changes in both modes; Agents cannot change this setting. Skill revisions
still require human approval.

A review returned for changes restores `editing` on the same draft. Continue the original
Revision Agent Context with continue_expert, its draftId, and full review feedback, then wait
for the new invocationId. Knowledge drafts must be reclaimed with knowledge_revision_start and
that draftId, followed by read_expert_context in the returned writableNamespace for fresh
content and etag before editing. Skill drafts must be remounted with skill_revision_start and
that draftId. Reuse the original Mission and draft; a closed or unavailable Context requires
an explicit diagnostic, not a replacement Context or task. Rejection ends the revision instead of returning it for continued editing.

For knowledge revisions, treat writableNamespace as an opaque value: copy it verbatim, never construct,
shorten, or derive it from draftId/storeId. On the first invalid_namespace or store_unavailable, compare the actual tool
argument character-for-character with the latest returned value. If it is lost, recover it through
knowledge_revision_list_drafts or knowledge_revision_get_draft. Correct mismatches before retrying;
never repeat a known-invalid value. A mounting, permission, or lifecycle diagnosis requires a failed
call using the exact returned namespace. Separate verified tool results from hypotheses in reports.

Format validation only detects malformed UUIDs. A valid but incorrect Store UUID can still produce an
empty list/search result when no matching draft is active, as can an unauthorized caller. An empty
result does not prove that the draft is empty or mounted correctly: compare the exact returned namespace
and recover it with the read-only tools above. Explicit caller-safe diagnostics for this existing
behavior are deferred; do not infer another caller's draft existence or bypass ownership checks.
