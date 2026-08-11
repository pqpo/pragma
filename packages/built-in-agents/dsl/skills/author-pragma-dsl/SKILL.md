---
name: author-pragma-dsl
description: Create and update validated pragma/v4 Expert, ExpertTeam, Flow, Evaluation, and Automation resources. Use when a user asks Pragma to create, change, configure, test, evaluate, or repair an Expert, team, Flow, Run Dry suite, schedule, trigger, or Automation in the current Pragma project.
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
5. Before authoring a new resource, allocate only the IDs needed for the user's current confirmed
   request. Use the returned Host-generated IDs and exact references. Preserve IDs when editing;
   never invent, copy, or change an ID.
6. For a new or non-trivial Flow change, create a Flow draft and build it in small batches with
   `update_flow_draft`: contracts, steps, start, transitions, and loops. Read diagnostics after every
   batch. Pass `operations` as a native JSON array, never as a string containing serialized JSON;
   string parsing is only a recovery path. The update response is a compact revision summary. Call
   `get_flow_draft` only when the complete current resource is needed. Flow drafts never contain Run
   Dry cases and never require an Evaluation draft.
7. Call `validate_flow_draft`, then `prepare_flow_draft` when the Flow is structurally complete.
   `prepare_flow_draft` prepares the Flow and optional non-Evaluation dependencies only. Fix every
   diagnostic, explain the normalized diff, and call `commit_dsl_changes` with the returned
   change-set ID. Do not create, prepare, or commit an Evaluation in this Flow transaction.
8. After the Flow commit succeeds, ask whether the user wants to create a test set and run it. The
   user may skip. If they skip, report the committed Flow and stop. Do not allocate an Evaluation
   ID or create an Evaluation draft before the user confirms, unless their original request already
   explicitly asked for the test set.
9. When the user confirms, or when they ask to test an existing committed Flow, read
   [references/run-dry.md](references/run-dry.md). Target the exact committed Flow ref. By default,
   generate and upsert exactly one case, immediately run that case, and fix it until it passes
   before creating another. Use cumulative `coverage.missing` as the next-case backlog. Only use
   batches when the user explicitly requests them; update, read, or run 2–10 cases per call, and fix
   every failure in the current batch before adding more. Never emit or pass a complete Evaluation
   YAML document.
10. Save the test set independently: call `prepare_evaluation_draft` with its exact draft revision,
    then pass the returned `changeSetId` to `commit_dsl_changes`. This commit changes only the
    Evaluation; it is never part of `prepare_flow_draft` or `additionalSources`.
    Use `prepare_dsl_changes` directly only for complete non-Flow resources. Its `sources` input is
    always an array with one complete YAML document per item, even for one resource.
11. Fix every diagnostic. Never bypass validation or hand-edit project files. If the project
    revision changed, reread affected resources and explicitly rebase the draft before retrying.
12. After each commit tool returns, always report success or failure, the committed project
    revision, and
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
