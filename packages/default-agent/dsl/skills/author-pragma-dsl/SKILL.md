---
name: author-pragma-dsl
description: Create and update validated pragma/v2 Expert, ExpertTeam, Flow, and Automation resources. Use when a user asks Pragma to create, change, configure, or repair an Expert, team, Flow, schedule, trigger, or Automation in the current Pragma project.
---

# Author Pragma DSL

Translate the user's intent into the smallest complete DSL change. Treat the interpreter as the
source of truth and use only the Pragma DSL tools to inspect, validate, and save resources.

## Workflow

1. Discuss missing intent before changing definitions.
2. Call `list_dsl_resources`, then read every resource that will be changed or referenced.
3. Before creating or changing an Expert, call `list_expert_options`. Confirm a listed Runtime
   model, recommend only listed capabilities that match the user's intent, and ask whether to use
   the recommendation, customize it, or enable no capabilities.
4. Read the relevant reference file below before drafting YAML.
5. Preserve exact references. Keep an existing resource version unless the user asks for a new
   version or the change intentionally introduces a separately addressable contract.
6. For every Flow creation or non-trivial Flow edit, call `create_flow_draft`. Build it in small
   batches with `update_flow_draft`: contracts, steps, start, transitions, then loops. Read the
   returned diagnostics after every batch and call `validate_flow_draft` before preparing.
7. Call `prepare_flow_draft` only when the draft has no incomplete or error diagnostics. Include
   any new Expert or ExpertTeam YAML in `additionalSources` so the final change remains atomic.
   Use `prepare_dsl_changes` directly only for complete non-Flow resources.
8. Fix every diagnostic. Never bypass validation or hand-edit project files. If the project
   revision changed, reread affected resources and explicitly rebase the draft before retrying.
9. Explain the normalized diff, then call `commit_dsl_changes` with the returned change-set ID.
10. After the tool returns, always report success or failure, the committed project revision, and
    the changed canonical refs.

For Automation work, use `list_automations` before editing. Use `save_automation` instead of the
generic prepare/commit pair because the host workspace and permission binding must be saved with the
portable DSL. Use the same tool to enable or disable an Automation. `delete_automation` retains
existing Missions; `reset_automation_session` only changes which Mission the next event continues.

## References

- Expert resources: read [references/expert.md](references/expert.md).
- ExpertTeam resources: read [references/expert-team.md](references/expert-team.md).
- Flow resources: read [references/flow.md](references/flow.md).
- Automation resources: read [references/automation.md](references/automation.md).
- Tested Flow patterns: read [references/flow-patterns.md](references/flow-patterns.md).
- Exact refs, shared resources, and versioning: read
  [references/resources-and-references.md](references/resources-and-references.md).

Do not invent fields from memory. If validation disagrees with a reference example, follow the
diagnostic and the current interpreter schema.
