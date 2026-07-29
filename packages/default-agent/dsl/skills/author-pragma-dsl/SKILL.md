---
name: author-pragma-dsl
description: Create and update validated pragma/v3 Expert, ExpertTeam, Flow, Evaluation, and Automation resources. Use when a user asks Pragma to create, change, configure, test, evaluate, or repair an Expert, team, Flow, Run Dry suite, schedule, trigger, or Automation in the current Pragma project.
---

# Author Pragma DSL

Translate the user's intent into the smallest complete DSL change. Treat the interpreter as the
source of truth and use only the Pragma DSL tools to inspect, validate, and save resources.

## Workflow

1. Discuss missing intent before changing definitions.
2. Call `list_dsl_resources`, then read every project resource that will be changed or referenced.
   Before creating an ExpertTeam, read every existing coordinator or member and include any new
   ones in the same change-set. A Host Runtime or Capability option that is not yet a project
   resource cannot be read and is the only exception.
3. Before creating or changing an Expert, call `list_expert_options`. Confirm a listed Runtime
   model, recommend only listed capabilities that match the user's intent, and ask whether to use
   the recommendation, customize it, or enable no capabilities. Reuse an existing project
   RuntimeProfile when its Runtime, provider, model, and thinking level match the selection;
   otherwise use the option's `runtimeProfileRef`. Never author a duplicate RuntimeProfile.
4. Read the relevant reference file below before drafting YAML.
5. Before authoring any new resource, call `allocate_dsl_resource_ids` once for the complete set and
   use the returned Host-generated IDs and exact references. Preserve IDs when editing; never invent,
   copy, or change an ID.
6. For every Flow creation or non-trivial Flow edit, allocate both Flow and Evaluation IDs, then
   call `create_flow_draft` with the allocated Flow ID. Build the Flow in small batches with
   `update_flow_draft`: contracts, steps, start, transitions, and loops. Read diagnostics after every
   batch. Flow drafts never contain Run Dry cases.
7. Create an independent `Evaluation` for every Flow without waiting for the user to ask. Read
   [references/run-dry.md](references/run-dry.md). Keep `expectInput` equal to the case's original
   Flow input for every step; use `expectPrompt` for rendered Expert, Team, and Human prompts. Call
   `run_evaluation` and fix every assertion, configuration error, or coverage gap.
8. Call `validate_flow_draft`, then call `prepare_flow_draft` only when the draft is structurally
   complete and the separate Evaluation passes. Include the Evaluation plus any new Expert or
   ExpertTeam YAML in `additionalSources` so the final change remains atomic.
   Use `prepare_dsl_changes` directly only for complete non-Flow resources. Its `sources` input is
   always an array with one complete YAML document per item, even for one resource.
9. Fix every diagnostic. Never bypass validation or hand-edit project files. If the project
   revision changed, reread affected resources and explicitly rebase the draft before retrying.
10. Explain the normalized diff and the run dry coverage, then call `commit_dsl_changes` with the
    returned change-set ID.
11. After the tool returns, always report success or failure, the committed project revision, and
    the changed canonical refs.

Before preparing, verify that every new ID came from `allocate_dsl_resource_ids`, every Evaluation
targets an exact Flow ref, every project ref
was read, every ContextStore mount declares `ref`, `namespace`, and `required`, and no existing
RuntimeProfile, Capability, or ContextStore is repeated in `sources`. Follow diagnostic `source` and
`path` values literally; never invent a field derivation rule to work around validation.

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
