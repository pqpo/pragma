# ADR 080: Expert lifecycle actions without approval

## Status

Accepted, 2026-10-26. Refines ADR 079 for internal Expert lifecycle tools.

## Decision

`spawn_expert`, `continue_expert`, `wait_experts`, `list_agents`, `steer_expert`
and `interrupt_expert` do not require human tool approval, in any Runtime mode.
Desktop must not create approval overrides when an Expert is selected. The Core
recognizes its own lifecycle tools through their delegation identity, not their
names, and excludes them from Expert/plugin approval merging. Unrelated tools,
including external MCP tools with similar names, retain their approval policies.

Existing lifecycle `ask`/`required` entries remain readable but are inert. This
also covers entries previously written automatically by Desktop and historical
system-Expert migrations. No source/configuration rewrite or startup scan is
needed. Delegation target access, depth/concurrency limits, ownership and tool
allowlists remain enforced. Work performed by a delegated Expert retains its own
business approval boundaries.

Desktop also creates new Team/Flow resource-call bindings with `approval: none`,
matching the DSL default, rather than inserting `ask` on selection. Existing call
bindings retain their policies: an old stored `ask` has no provenance identifying
it as automatic or deliberate.

For in-process Capability tools without either an Expert override or a declared
tool policy, compilation resolves the Runtime's managed-tool default (the
`defaultMcpApproval` catalog field). Full-access modes therefore default to none,
and catalogs without that declaration keep ask. This resolution also runs when
there is no MCP contribution. Explicit tool/Expert policies still merge by the
strictest requirement; conditional tool policies keep their conditions.

## Compatibility and verification

Compiler v12 records these compiled-tool semantics. The adjacent v11→v12
step validates the historical resource hashes and lock before recompilation;
resource fields, unrelated policies and immutable published revisions are
preserved. The existing revision cache/recovery mechanism derives a new view.
Earlier compiler upgrades remain available. DSL and configuration schemas do not
change because existing policy fields stay valid and are retained losslessly.

A fixture from the actual v11 writer covers upgrade and lock tampering. The Core
MCP gateway executes all six lifecycle actions with historical ask/required
policies on the Expert or the tools themselves and a rejecting approval handler
without requesting approval. An ordinary tool using a lifecycle name still
requires its own declared approval. Desktop
regression compiles real Host bindings after saving/reopening configuration and
covers failed first calls followed by manual retry without approval.

Host-binding regression also compiles and executes in-process tools without MCP,
covering the native default mode, explicit modes and policies, conditional
requirements, and a failed first call followed by a successful manual retry.
Desktop selection tests cover both Team and Flow defaults and retained explicit
policies.
