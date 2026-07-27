---
name: author-pragma-dsl
description: Create and update validated pragma/v3 Expert, ExpertTeam, Flow, and Automation resources. Use when a user asks Pragma to create, change, configure, or repair an Expert, team, Flow, schedule, trigger, or Automation in the current Pragma project.
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
5. Before authoring any new resource, call `allocate_dsl_resource_ids` once for the complete set and
   use the returned Host-generated IDs and exact references. Preserve IDs when editing; never invent,
   copy, or change an ID.
6. For every Flow creation or non-trivial Flow edit, call `create_flow_draft`. Build it in small
   batches with `update_flow_draft`: contracts, steps, start, transitions, loops, then run dry cases.
   Read the returned diagnostics after every batch.
7. Create run dry cases for every Flow without waiting for the user to ask. Mock every visited
   Expert, Team, nested Flow, action, and Human Task with its exact expected input; Human Tasks also
   assert the rendered prompt. Cover every declared transition outcome, including route cases,
   array branches, fallbacks, loop repeats, exits, and loop limits. Read
   [references/run-dry.md](references/run-dry.md), call `run_flow_draft_dry`, and fix every failed
   assertion, configuration error, or missing coverage item.
8. Call `validate_flow_draft`, then call `prepare_flow_draft` only when every run dry case passes,
   transition coverage is complete, and the draft has no incomplete or error diagnostics. Include
   any new Expert or ExpertTeam YAML in `additionalSources` so the final change remains atomic.
   Use `prepare_dsl_changes` directly only for complete non-Flow resources.
9. Fix every diagnostic. Never bypass validation or hand-edit project files. If the project
   revision changed, reread affected resources and explicitly rebase the draft before retrying.
10. Explain the normalized diff and the run dry coverage, then call `commit_dsl_changes` with the
    returned change-set ID.
11. After the tool returns, always report success or failure, the committed project revision, and
    the changed canonical refs.

For Automation work, use `list_automations` before editing. Use `save_automation` instead of the
generic prepare/commit pair because the host workspace and permission binding must be saved with the
portable DSL. Use the same tool to enable or disable an Automation. `delete_automation` retains
existing Missions; `reset_automation_session` only changes which Mission the next event continues.
Before preparing or saving, enforce the Automation metadata and prompt limits documented in
`references/automation.md`; never rely on the host to truncate authored values.

## References

- Expert resources: read [references/expert.md](references/expert.md).
- ExpertTeam resources: read [references/expert-team.md](references/expert-team.md).
- Flow resources: read [references/flow.md](references/flow.md).
- Flow run dry cases: read [references/run-dry.md](references/run-dry.md).
- Automation resources: read [references/automation.md](references/automation.md).
- Tested Flow patterns: read [references/flow-patterns.md](references/flow-patterns.md).
- Exact refs, shared resources, and versioning: read
  [references/resources-and-references.md](references/resources-and-references.md).

Do not invent fields from memory. If validation disagrees with a reference example, follow the
diagnostic and the current interpreter schema.
