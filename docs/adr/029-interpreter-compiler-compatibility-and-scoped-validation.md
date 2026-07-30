# ADR 029: Interpreter compiler compatibility and scoped execution validation

## Status

Accepted.

## Context

Project revisions persist a `compilerVersion`, but the Interpreter previously treated it only as
part of a generic lock comparison. The independent Evaluation change extended the closed resource
union without changing that version. A long-running older Desktop process therefore reported the
new resource as both an invalid schema and a stale lock.

Compilation also ran complete-project validation before resolving the requested executor. A new
validator finding in one unrelated Flow could consequently disable every project Expert and Team.

## Decision

- The Interpreter exports one browser-safe compiler capability declaration. Project publication,
  lock generation, revision loading, Blueprint caching, Desktop IPC, and Mission compilation use
  that declaration.
- New revisions write `pragma.dsl/v3`. The current Interpreter reads both `pragma.dsl/v2` and
  `pragma.dsl/v3`; immutable v2 revisions are not rewritten.
- Revision metadata and the persisted lock must agree. Unsupported versions and metadata
  disagreement are compiler diagnostics evaluated before resource parsing. They are not lock
  mismatches.
- `PragmaProject.validate()` remains the complete-project health check used by authoring and
  publication. `PragmaProject.validateFor(ref)` validates only an executor and its transitive
  project-resource dependency closure.
- Compiler, lock, unreadable source topology, and resource identity ambiguity remain project-wide
  blockers. Reference, cycle, Flow contract, portable semantic, and adapter diagnostics block only
  an executor whose dependency closure contains the affected resource.
- Desktop main and preload expose and compare the compiler capability during startup. Development
  runs electron-vite in watch mode so changes to bundled workspace dependencies rebuild and restart
  the Electron process.

## Consequences

Studio can continue to show complete project diagnostics while independent executors remain usable.
Executors that directly or indirectly depend on damaged resources still fail closed. A rollback to
an Interpreter that cannot read a newer revision remains safe because the compiler version blocks
execution before resources are trusted.

Changes to the closed DSL resource union, strict resource schemas, or portable validators that can
reject a previously published revision require an explicit compiler compatibility decision,
cross-version fixtures, and an update to the compiler capability declaration.
