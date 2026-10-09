---
name: author-pragma-flow
description: Create, edit, validate, and save Pragma Flows with incremental drafts and execution-authorized CLI commands. Use for Flow graphs, contracts, transitions, loops, and repairing Flow diagnostics.
---

# Author a Pragma Flow

Use the bundled `pragma` command through the Runtime's existing process tool. It inherits the
current Mission's authorization. Never edit formal Pragma storage. If the command is missing or
its channel is unavailable, report the diagnostic; do not fall back to modifying storage.

Read [references/flow.md](references/flow.md) for fields and
[references/flow-patterns.md](references/flow-patterns.md) for graph patterns. Read
[references/commands.md](references/commands.md) for lifecycle and recovery examples.
Load only the relevant subcommand's `--help` when its parameters are needed.

1. Discover exact resource refs and the current revision with `pragma manage dsl resources list|read`.
   Query Runtime/capability options only when required. Allocate new IDs with `pragma manage dsl ids allocate`.
2. Create a draft with `pragma manage flow draft create`. For an existing Flow, read its resource and
   rebuild the editable draft using the same identity and original fields; preserve unknown fields.
3. Apply small operation batches with `pragma manage flow draft update`, passing the exact draft revision.
   Supply the whole request object as a JSON file or stdin (`--input -`). Never embed long JSON in argv.
4. Read compact diagnostics after each batch. Use `pragma manage flow draft get --input request.json`
   with `includeResource: true` only when the full current resource is needed.
5. Run `pragma manage flow draft validate`, then `pragma manage flow draft prepare`. Repair every error before
   proceeding. Prepare includes the Flow and permitted non-Evaluation dependencies only.
6. Explain the reviewed changes. If bounded normalized source is needed, use `pragma manage dsl changes read`.
   Call `pragma manage dsl changes commit` with the returned changeSetId. The Host requests approval in the
   original Mission; process execution permission does not approve this commit.
7. Report the actual commit result, Project revision and changed refs. Flow drafts never contain
   Evaluation cases. Offer tests after the Flow commit; discover `author-pragma-evaluation` and use its
   independent CLI workflow only when the user asks for tests.

Use `--format json`. Preserve a stable `--request-id` UUID for identical retries. A transport failure
is not proof that nothing committed. Inspect receipts/draft state before a new mutation. On revision
conflict reread and explicitly rebase; never blindly retry with a guessed revision. Approval rejection
makes no publication. Use `pragma manage flow draft discard` when abandoning the draft.

Validation failures can have structured diagnostics with exit code 10. Permission errors are 6,
conflicts 4, unavailable command channels 5, protocol mismatch 7, and interruption 130.

For an existing legacy draft or prepared change that reports `unowned_target`, use the explicit
`pragma manage flow draft recover` or `pragma manage dsl changes recover` command with its original target ID.
Recovery requests approval in the current Execution and preserves the original resource file.
It cannot take over a target owned by another Mission/Context. Recovery of a prepared change does
not publish it; commit still requires its own approval. Do not edit owner metadata or stored drafts.
