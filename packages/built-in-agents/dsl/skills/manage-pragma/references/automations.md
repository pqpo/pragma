# Manage Pragma Automations

Use `pragma manage automation`; this version requires the current Execution command channel.
Read [Automation resource rules](automations/automation.md) when constructing or changing DSL.
Read [Resources](resources.md) for host bindings and use `pragma manage dsl resources list|read`
for current Automation YAML, executor refs and the Project revision. Allocate a new ID through
`pragma manage dsl ids allocate`; do not invent one.

- `list`: filter by statuses, enabled, executorRef or query; follow nextCursor unchanged.
- `save`: pass expectedProjectRevision, the complete YAML source, absolute workspaceId and
  toolPermissionMode via `--input FILE|-`. Preserve existing fields and unknown compatibility data.
  Enable/disable by saving the resource with spec.enabled changed. Generic DSL commit does not
  establish Automation host bindings and must not replace this workflow.
- `delete`: pass ref and expectedProjectRevision. It preserves existing Missions.
- `reset-session`: pass ref only when the user requests fresh continuity. It affects the next
  continuity binding and preserves Mission history; it does not interrupt unrelated runs.

Host approval is separate from shell approval. Never embed credentials in YAML or command arguments.
Reuse request UUIDs only with identical input; after uncertain completion retrieve the original
result before issuing another mutation. On revision conflict read current YAML/revision and reapply
only intended changes. `input_required` returns control to the owning Execution; the CLI cannot
approve on behalf of the user.
