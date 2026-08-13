# ADR 041: Runtime Feature Framework and Conformance Evidence

## Status

Accepted

## Context

`defineRuntimeDriver()` standardized Session and turn execution, but cross-Harness capabilities such
as MCP, Skills, permissions, attachments, streaming and cleanup remained implicit inside each
adapter. A Runtime could therefore compile and complete a basic chat turn while silently omitting an
integration area. Descriptor booleans duplicated implementation claims and were not proof that the
native Harness discovered or executed a capability.

The Runtime packages also repeated ownership, partial-initialization cleanup, bounded process
diagnostics and TERM-to-KILL escalation. Those mechanics are shared, while JSON-RPC, NDJSON,
stream-json and SDK event semantics remain provider-specific.

## Decision

Core owns one closed `RUNTIME_FEATURE_CATALOG`. Every concrete Runtime passes a complete
`RuntimeFeatureSet` to `defineRuntimeDriver()` and declares each slot as `supported`, `degraded`,
`unsupported` or `notApplicable`. Non-supported declarations carry a reason. Runtime capability
booleans are projections of this declaration; driver descriptors only choose placement targets and
execution locations.

Driver-, Session- and turn-scoped features have explicit phases. Core executes enabled Session hooks
in catalog order before native Session creation, executes enabled turn hooks before `startTurn()`, and
passes immutable per-feature preparation results to the provider implementation. Antigravity is the
reference implementation for MCP, permission relay and Skill preparation. Other Runtime packages
adopt the same declaration and Core-owned resource scope without sharing provider protocol code.

`RuntimeResourceScope` owns leases, registrations, relays and other acquired resources. It transfers
ownership only after successful preparation, releases in reverse order, closes idempotently, keeps
cleaning after individual disposer failures and reports an `AggregateError`. Native processes stop
before Session feature resources are released.

`RuntimeProcessSupervisor` and `BoundedRuntimeOutputBuffer` provide process ownership, structured
exit observation, bounded diagnostics and graceful-to-forced termination. They do not parse or
serialize any Harness protocol. At least Claude Code and Antigravity use these primitives.

The conformance API derives its checks from feature declarations. It verifies mandatory slots,
capability projection, executed evidence for `supported` claims, stream ordering, terminal event
ownership, text and tool lifecycle, expected tool execution, output markers and Core persistence
invariants. The versioned probe evidence schema records sanitized environment, command, assertions
and observations. MCP and Skills distinguish Materialized, Discovered and Executed evidence.

Real probes run through the public Pragma API:

```bash
pnpm runtime:probe <pi|codex|claude-code|qodercli|antigravity> \
  <availability|models|stream|native-tool|mcp|skills|attachments|resume|compaction|cancellation|full>
```

Probe output is opt-in, redacted and archived under the Runtime probe diagnostics root. Normal CI
replays fixtures and conformance observations; it does not require developer authentication. The
Runtime integration checklist contains an auto-generated catalog section, and CI rejects catalog and
documentation drift.

## Consequences

A Runtime addition is intentionally incomplete until every feature slot is handled. Feature catalog
changes are centralized and force all adapters and the generated checklist to move together. Existing
descriptor feature booleans and the unstructured driver `prepare()` hook are removed rather than kept
as compatibility paths.

`supported` is an evidence-backed state, not an implementation aspiration. Until executed, sanitized
real-Runtime evidence is recorded, an implemented adapter capability remains `degraded` with an
explicit reason. Mock success or materialized files alone cannot promote MCP or Skills.

This decision does not introduce ACP, a remote driver, a generic Runtime transport, a base adapter
class or a process pool. Provider command lines, config layouts, event parsing, permission semantics
and native Session identity remain in their concrete Runtime packages.
