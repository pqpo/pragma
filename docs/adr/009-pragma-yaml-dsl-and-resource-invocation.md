# ADR 009: Pragma YAML DSL, Resource Invocation, and Flow Loops

## Status

Superseded in part by ADR 010. This record describes the historical v1 decision.

## Context

Expert, ExpertTeam, and Flow are currently created through TypeScript APIs. Desktop needs a
portable, editable representation that supports references, split Flow files, reproducible runs,
and round-tripping without serializing JavaScript functions. Experts also need one governed way to
expose Experts, Teams, and Flows as tools. Flow control must support revision and approval cycles.

## Decision

Pragma uses YAML `pragma/v1` resources as its only portable definition format. A Bundle imports
Expert, ExpertTeam, and Flow resources. `$include` performs source composition; typed `ref` values
create semantic dependencies. Published bundles include a content-addressed lock file.

`@pragma/interpreter` owns the DSL AST schemas, parsing, linking, validation, compilation,
descriptors, extension registries, and provenance-aware dumping. Its browser-safe
`@pragma/interpreter/ast` export contains only Zod schemas and inferred types. `@pragma/core`
contains execution primitives and has no dependency on the interpreter. Desktop owns project
revisions, layout, credentials, and authoring UI.

Expert, ExpertTeam, and Flow are invocable resources. Registered Tool Adapters expose resources as
managed tools. Version 1 provides `pragma.tool.delegate` for Expert lifecycle delegation and
`pragma.tool.call` for synchronous Expert, Team, or Flow calls. Nested resource calls remain in the
current Execution and InvocationTree.

Flow resource dependencies remain acyclic. Flow control is a directed graph: every cyclic strongly
connected component must be a named, single-entry Loop with explicit repeat edges and a positive
iteration budget. Loop decisions and counters are durable and idempotent.

DSL-compiled instances retain normalized source provenance and can be dumped semantically back to
YAML. Programmatic functions without registered descriptors fail dumping rather than being omitted.

Desktop's former `pragma.expert/v2` JSON definition store and Mission v1 are removed without a
runtime compatibility adapter or automatic data deletion.

## Consequences

- JSON objects and functions are not embedded in YAML as executable code.
- Interpreter complexity can evolve independently without expanding Core's execution API surface.
- Workspace paths and secrets are compile-host inputs, not definition data.
- A Flow called as a tool shares cancellation, human interaction, usage, events, and recovery with
  its parent Execution.
- YAML text and comments are not byte-stable; normalized semantics and fingerprints are stable.
- First-version loops are sequential, reducible, and single-entry. Parallel and irreducible loops
  require a later runtime primitive.
