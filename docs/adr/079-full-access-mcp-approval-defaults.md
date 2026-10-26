# ADR 079: Full-access MCP approval defaults

## Status

Accepted, 2026-10-26. Refines ADR 078 for fallback MCP approvals.

## Decision

Full-access modes advertise `defaultMcpApproval: none` in their native permission
catalog. Other modes and catalogs without this optional declaration retain `ask`.
The Interpreter reads the resolved mode from the Runtime descriptor; it does not
recognize Harness names or mode IDs itself.

Host-generated fallback `ask` policies carry `isDefault: true`. During compilation,
the Expert's explicit tool policy replaces this fallback. If no explicit policy
exists, the resolved Runtime mode supplies the default. Explicit Capability policies
continue to merge by the strictest requirement. `required` is never discarded,
even if incorrectly marked as a default. HTTP POST business approval remains
required, and tool allowlists, credentials and Host mutation rules remain intact.
The final MCP executor also merges Expert/plugin execution approvals, so a plugin's
required policy cannot be lost after compilation. `none` is neutral during policy
merging and does not broaden conditional requirements. Expert MCP keys recognize
the executor's sanitized server name while retaining historical raw-server keys.

This fixes repeated default MCP prompts under full access, and fixes explicit
`none` being overridden by a Host fallback `ask`. Explicit `ask` still prompts on
every call; approval of one call does not authorize future calls.

## Compatibility and verification

Compiler v11 identifies the changed compilation behavior. The adjacent v10→v11
migration validates the original v10 resource hashes and lock, then preserves all
resource fields and explicit policies, and rejects duplicate Lock resource entries. Earlier adjacent upgrade paths remain
available. Published source files are never rewritten; existing revision readers
use their validated derived cache and retain their recovery behavior. The DSL
schema remains v6 because no persisted resource fields change.

A fixture produced by the actual v10 writer covers migration and tampered-lock
rejection. Existing tests cover current no-op, historical upgrade chains, future
versions and revision cache recovery. A real Local Host HTTP Capability is compiled
through the Interpreter and executed, including a failed first call and a successful
manual retry. The regression also checks full access, explicit `ask`/`required`,
explicit `none` in an asking mode, and preservation of required POST approval.
