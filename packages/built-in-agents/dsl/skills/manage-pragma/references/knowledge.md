# Find, read and revise knowledge bases

Use `pragma manage knowledge-store` through the active authorized Execution to query all formal
knowledge bases, including unmounted ones. A host storeId, DSL ContextStore ref and mounted Context
namespace are different identities. For current Context mounts instead, read [Resources](resources.md).

## Discover, search and read

```sh
printf '%s' '{"query":"architecture","status":"ready","limit":10}' | pragma manage knowledge-store list --input -
printf '%s' '{"storeId":"<returned storeId>","query":"routing","scope":"all"}' | pragma manage knowledge-store documents search --input -
printf '%s' '{"storeId":"<returned storeId>","revision":1,"snapshotHash":"<returned snapshotHash>","documentId":"<returned documentId>"}' | pragma manage knowledge-store documents read --input -
```

Replace every placeholder and revision with actual returned values; search returns the revision and
snapshotHash needed by read. For content lookup go directly from list to search: get is optional,
for metadata, approval settings or DSL inspection. Do not fetch help when these examples cover the task.
Known store/document IDs can be
read directly; discovery is not mandatory. get defaults to summary and exposes the formal revision,
snapshotHash and writeApprovalMode. Use view=definition only for associated DSL definitions/dslRefs;
empty dslRefs means there is no associated definition.

List filters query by name/description/ID and status (ready/needs_attention). documents list lists
IDs/descriptions with optional query. documents search searches literal case-insensitive text in one
base; scope is path, content or all (default). Hits carry documentId, matchType, optional one-based
line and a bounded snippet. documents read returns the formal body and metadata, never an editor draft.
Copy revision and snapshotHash across calls so search and reads stay on the same published snapshot.

List pages default to 25 items (maximum 100). Existing knowledge-store list uses nextCursor: repeat
with the same filters. New document pages and content reads supply continuation.command and
continuation.input; pass them verbatim until paging ends or data.complete=true. Content defaults to
20,000 UTF-16 units and is also byte-bounded; never infer completeness from returned string length.
Use --describe --format json for exact schemas/defaults. On CURSOR_EXPIRED use the structured recovery
with a new request ID and reread. NOT_FOUND, STORAGE_CORRUPTED and missing authorization do not mean
an empty knowledge base. Do not scan .pragma, caches or historical drafts to recover formal content.

## Request a revision

Once creation or modification is needed, use spawn_expert for Store Revision Agent
(expertId 0000000000st0rev), supplying complete requirements, storeId, base revision/snapshotHash,
relevant source content and any existing draftId. Only revision drafts are writable.
Keep contextId and invocationId, wait_experts on invocationId, and inspect the result.
Knowledge submissions follow writeApprovalMode: human review by default, or automatic approval/application
when configured. Always delegate in both modes; Agents cannot change this setting.

For related work use continue_expert with that exact contextId; list_agents recovers it after reopening
or compaction. A returned review restores editing on the same draft. Continue the original Context
with the same draftId and full feedback, then wait for its new invocationId. The Revision Agent must
reclaim with knowledge_revision_start and that draftId, then read_expert_context in the returned
writableNamespace for fresh content and etag before editing. Reuse the original Mission and draft.
A closed/unavailable Context requires a diagnostic, not a replacement; rejection ends the revision.

Treat writableNamespace as opaque: never derive it from storeId/draftId. On invalid_namespace or
store_unavailable compare the actual argument character-for-character with the latest returned value.
Recover a lost value with knowledge_revision_list_drafts or knowledge_revision_get_draft. Never repeat
a known-invalid argument. A mounting or lifecycle diagnosis requires failure with the exact namespace.
A valid but incorrect UUID or unauthorized caller can produce an empty draft list/search; that does
not prove an empty draft. Recover the exact namespace without probing another caller's ownership.
