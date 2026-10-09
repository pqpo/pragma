# Author Pragma DSL

Use the interpreter's diagnostics as the source of truth. The authorized `pragma` command is
provided by the current Runtime; it inherits the current Mission, Context and Execution. Run
commands with `--input request.json` or `--input -` for a bounded JSON object. Read only the needed
subcommand `--help`; do not print credentials or edit authoritative Project storage.

## Workflow

1. Resolve missing intent. Use `pragma manage dsl resources list` to find exact refs and
   `pragma manage dsl resources read` for bounded current YAML. Query `pragma manage dsl options list` by category
   and follow `nextCursor`: `runtime-models`, `capabilities`, `avatars`, `builtin-experts`.
   Recommend only listed models, capabilities and avatar personas; preserve an existing avatar
   unless asked to change it. Ask whether to use the recommended capabilities, customize them,
   or use none. Reuse an existing matching RuntimeProfile rather than authoring a duplicate.
   Read-only system Experts can be Team coordinators/members; reuse matching entries rather than
   recreating them or asking for their model/avatar/capability choices. Unmaterialized Host options
   are the only refs that cannot yet be read as project resources.
2. Read the relevant reference below. `pragma manage dsl draft start` creates one Mission-owned file draft
   containing all related new or existing Experts/Teams. It allocates IDs and returns intentionally
   incomplete skeletons plus workspace paths. Complete required fields with native read/edit tools;
   preserve each ID, kind, apiVersion and filename. Link new resources using returned refs.
3. `pragma manage dsl draft inspect` returns compact diagnostics, omitted-field effects, dependencies and
   hashes. Explain material removals and automatically created dependencies. `preserved_unknown`
   means retained compatibility data. When details are omitted, use `pragma manage dsl draft review`,
   preserving section/ref filters while following `nextCursor`. Resolve target conflicts before
   relying on an unavailable effective preview. Do not request a full textual diff.
4. `pragma manage dsl draft prepare` freezes the files and validates an immutable submission; pass only
   `draftId`. Fix diagnostics in the same editable files and prepare again. Read prepared YAML
   chunks with `pragma manage dsl changes read` only when compact review is insufficient.
5. `pragma manage dsl changes commit` submits the prepared `changeSetId` through Host approval. Shell
   approval does not approve publication. Report success/failure, committed revision and changed refs.
   On concurrent target changes, use `pragma manage dsl draft restart`, compare the old read-only reference
   with the new workspace files, and explicitly replay still-valid edits. Do not blindly retry edits.
6. Use `pragma manage dsl draft list` to locate this Mission's drafts and `pragma manage dsl draft discard` for
   approved cleanup. An `unowned_target` requires explicit `pragma manage dsl draft recover`; historical
   prepared changes use `pragma manage dsl changes recover`. Recovery preserves data and requires separate
   approval; known foreign owners cannot be taken over. Publication still needs its own approval.

Use `pragma manage dsl changes prepare` only for complete resources without a dedicated authoring workflow;
Expert/Team require file drafts, Flow uses the flow reference, and Evaluation uses
the evaluation reference. Flow and Evaluation are independent transactions. After a Flow commit,
offer Evaluation authoring only if not already requested; do not create an Evaluation implicitly.

Before preparing, ensure IDs came from Host draft allocation or `pragma manage dsl ids allocate`, project
refs were read, ContextStore mounts declare `ref`, `namespace`, `required`, and dependencies do not
duplicate existing RuntimeProfile, Capability or ContextStore resources. Preserve unknown fields;
follow diagnostic source/path values literally. Stable request UUIDs are reused only with identical
command/input to retrieve the original receipt. Cancellation never undoes a published revision.
`input_required` returns control to the owning Execution; the CLI cannot approve for the user.

For Automation resources and Host bindings, read [Automations](automations.md).

## References

- [Expert](dsl/expert.md) and [ExpertTeam](dsl/expert-team.md): read for that resource kind.
- [Avatars](dsl/avatars.md): read before selecting/changing an Expert persona.
- [Resources and refs](dsl/resources-and-references.md): dependencies and versioning.
- [CLI examples](dsl/commands.md): file drafts, review and recovery.
- Flow: read [Flow](flow.md); Flow Run Dry: read [Evaluation](evaluation.md).
