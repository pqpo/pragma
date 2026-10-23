# Find, read and revise Skills

Skills are Capability resources. Use `pragma manage skill` through the active Execution command
channel, including for Skills not mounted on the current Expert. Loading this reference grants no access.
System Skills are discoverable and readable but cannot be revised by Agents.

## Discover and read

```sh
printf '%s' '{"query":"review","managedBy":"user","limit":10}' | pragma manage skill list --input -
printf '%s' '{"capabilityId":"<returned capabilityId>","view":"content"}' | pragma manage skill get --input -
```

Replace placeholders with actual returned values. If you already know the capabilityId, get it directly.
`skill get` defaults to `view: summary`. `view: content` reads SKILL.md in the same call;
`view: definition` reads associated DSL definitions and their exact dslRefs. Empty dslRefs means
no associated DSL definition; do not invent one. Host capabilityId and DSL refs are distinct identities.
List filters are query (name/description/ID), status (ready/needs_attention) and managedBy (system/user).

Results identify latestRevision, nullable activeRevision, the selected revision and contentHash.
The default is the latest formal revision, never a draft. Pass `revision: "active"` to inspect the
Runtime's active revision; absence of an active revision is an explicit error. Copy the numeric revision
and contentHash into subsequent reads to preserve the selected package.

If SKILL.md names an exact reference/script path, use `skill files read` directly with that path and
the returned capabilityId, revision and contentHash. List files only when the path is unknown.
For discovery, call `skill files list` with capabilityId, revision and contentHash, optionally
query/limit. Then use `skill files read` with the same identity and the exact returned path. File paths
are package-relative; they are not filesystem paths. Binary files report readable=false and a reason.

Use the examples above without fetching help when their fields cover the task. Only when fields are
unclear, run the relevant subcommand with `--describe --format json` for exact input/output schemas without
connecting to a Host. List pages default to 25 items (maximum 100). Content defaults to 20,000 UTF-16
units; actual chunks may be smaller to fit the byte budget and preserve Unicode characters.
Follow continuation.command and continuation.input verbatim until data.complete is true or pagination ends.
The returned hashes validate package and text identity. On CURSOR_EXPIRED use error.details.recovery
with a new request ID, reselect the target and reread. NOT_FOUND is not an empty package.

## Request a repair

For read-only diagnosis, stop after inspecting the current formal content and relevant references.
Once modification is needed, use spawn_expert for Skill Revision Agent (expertId 0000000000sk1rev),
passing the complete requirements, capabilityId, latest formal revision/contentHash, relevant source
content, and any existing draftId. Do not try formal package writes or scan storage first.
Retain contextId and invocationId; wait_experts on invocationId and inspect the result.
Skill changes require human approval. Only revision drafts are writable.

For follow-up work use continue_expert with that exact contextId; list_agents can recover it after
compaction or reopening. Multiple Contexts for one expertId are distinct conversations.
A review returned for changes restores editing on the same draft: continue the original Context with
the same draftId and full feedback, then wait for its new invocationId. The Revision Agent must call
skill_revision_start with that draftId to remount it before editing. Reuse the original Mission and
draft. A closed or unavailable Context requires a diagnostic, not a replacement. Rejection ends the revision.
