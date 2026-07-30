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
- New revisions write and directly read `pragma.dsl/v3`. `pragma.dsl/v2` is an upgrade source, not
  a directly readable version.
- The Interpreter owns the pure v2-to-v3 compiler migration. It validates the historical v2 lock
  and the exact historical `Flow.spec.runDry` shape, removes that abandoned field, and emits
  current resources. It does not create an `Evaluation` or retain a runtime compatibility branch.
- Desktop owns the transaction that upgrades project storage v4 to v5 before normal reads. It
  preserves project and revision identities, republishes every revision with a v3 lock, and uses a
  file lock, stable journal, backup, atomic replacement, and replayable recovery.
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
reject a previously published revision require a compiler version bump, a same-change adjacent
migration, real historical fixtures, Host transaction coverage, and an update to the compiler
capability declaration. Declaring an upgrade source as directly readable is invalid.
