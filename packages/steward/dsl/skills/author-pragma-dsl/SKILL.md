---
name: author-pragma-dsl
description: Create and update validated pragma/v2 Expert, ExpertTeam, and Flow resources. Use when a user asks the Steward to create, change, configure, or repair an Expert, team, or Flow in the current Pragma project.
---

# Author Pragma DSL

Translate the user's intent into the smallest complete DSL change. Treat the interpreter as the
source of truth and use only the Steward DSL tools to inspect, validate, and save resources.

## Workflow

1. Discuss missing intent before changing definitions.
2. Call `list_dsl_resources`, then read every resource that will be changed or referenced.
3. Read the relevant reference file below before drafting YAML.
4. Preserve exact references. Keep an existing resource version unless the user asks for a new
   version or the change intentionally introduces a separately addressable contract.
5. Call `prepare_dsl_changes` with complete YAML documents for all affected resources.
6. Fix every error diagnostic. Never bypass validation or hand-edit project files.
7. Explain the normalized diff, then call `commit_dsl_changes` with the returned change-set ID.
8. Report the committed project revision and changed canonical refs.

## References

- Expert resources: read [references/expert.md](references/expert.md).
- ExpertTeam resources: read [references/expert-team.md](references/expert-team.md).
- Flow resources: read [references/flow.md](references/flow.md).
- Exact refs, shared resources, and versioning: read
  [references/resources-and-references.md](references/resources-and-references.md).

Do not invent fields from memory. If validation disagrees with a reference example, follow the
diagnostic and the current interpreter schema.
