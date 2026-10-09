---
name: author-pragma-dsl
description: Create, update, configure, or repair Pragma Expert and ExpertTeam resources and their dependencies through authorized CLI file drafts. Flow and Evaluation authoring use their own skills.
---

# Author Pragma DSL

Use the interpreter's diagnostics as the source of truth. The authorized `pragma` command is
provided by the current Runtime; it inherits the current Mission, Context and Execution. Run
commands with `--input request.json` or `--input -` for a bounded JSON object. Read only the needed
subcommand `--help`; do not print credentials or edit authoritative Project storage.

## Workflow

1. Resolve missing intent. Use `pragma dsl resources list` to find exact refs and
   `pragma dsl resources read` for bounded current YAML. Query `pragma dsl options list` by category
   and follow `nextCursor`: `runtime-models`, `capabilities`, `avatars`, `builtin-experts`.
   Recommend only listed models, capabilities and avatar personas; preserve an existing avatar
   unless asked to change it. Ask whether to use the recommended capabilities, customize them,
   or use none. Reuse an existing matching RuntimeProfile rather than authoring a duplicate.
   Read-only system Experts can be Team coordinators/members; reuse matching entries rather than
   recreating them or asking for their model/avatar/capability choices. Unmaterialized Host options
   are the only refs that cannot yet be read as project resources.
2. Read the relevant reference below. `pragma dsl draft start` creates one Mission-owned file draft
   containing all related new or existing Experts/Teams. It allocates IDs and returns intentionally
   incomplete skeletons plus workspace paths. Complete required fields with native read/edit tools;
   preserve each ID, kind, apiVersion and filename. Link new resources using returned refs.
3. `pragma dsl draft inspect` returns compact diagnostics, omitted-field effects, dependencies and
   hashes. Explain material removals and automatically created dependencies. `preserved_unknown`
   means retained compatibility data. When details are omitted, use `pragma dsl draft review`,
   preserving section/ref filters while following `nextCursor`. Resolve target conflicts before
   relying on an unavailable effective preview. Do not request a full textual diff.
4. `pragma dsl draft prepare` freezes the files and validates an immutable submission; pass only
   `draftId`. Fix diagnostics in the same editable files and prepare again. Read prepared YAML
   chunks with `pragma dsl changes read` only when compact review is insufficient.
5. `pragma dsl changes commit` submits the prepared `changeSetId` through Host approval. Shell
   approval does not approve publication. Report success/failure, committed revision and changed refs.
   On concurrent target changes, use `pragma dsl draft restart`, compare the old read-only reference
   with the new workspace files, and explicitly replay still-valid edits. Do not blindly retry edits.
6. Use `pragma dsl draft list` to locate this Mission's drafts and `pragma dsl draft discard` for
   approved cleanup. An `unowned_target` requires explicit `pragma dsl draft recover`; historical
   prepared changes use `pragma dsl changes recover`. Recovery preserves data and requires separate
   approval; known foreign owners cannot be taken over. Publication still needs its own approval.

Use `pragma dsl changes prepare` only for complete resources without a dedicated authoring workflow;
Expert/Team require file drafts, Flow uses `author-pragma-flow`, and Evaluation uses
`author-pragma-evaluation`. Flow and Evaluation are independent transactions. After a Flow commit,
offer Evaluation authoring only if not already requested; do not create an Evaluation implicitly.

Before preparing, ensure IDs came from Host draft allocation or `pragma dsl ids allocate`, project
refs were read, ContextStore mounts declare `ref`, `namespace`, `required`, and dependencies do not
duplicate existing RuntimeProfile, Capability or ContextStore resources. Preserve unknown fields;
follow diagnostic source/path values literally. Stable request UUIDs are reused only with identical
command/input to retrieve the original receipt. Cancellation never undoes a published revision.
`input_required` returns control to the owning Execution; the CLI cannot approve for the user.

Automation remains on its existing managed-tool workflow in this migration stage. Read
[references/automation.md](references/automation.md); use `save_automation` to retain Host workspace
and permission binding, rather than generic prepare/commit.

## References

- [Expert](references/expert.md) and [ExpertTeam](references/expert-team.md): read for that resource kind.
- [Avatars](references/avatars.md): read before selecting/changing an Expert persona.
- [Resources and refs](references/resources-and-references.md): dependencies and versioning.
- [CLI examples](references/commands.md): file drafts, review and recovery.
- Flow: discover `author-pragma-flow`; Flow Run Dry: discover `author-pragma-evaluation`.
