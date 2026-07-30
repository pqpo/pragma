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
- Desktop reads project storage v4 and v5 concurrently. It never scans or republishes revision
  history during application startup or store construction. When a v2 revision is actually
  requested, Desktop invokes
  the pure Interpreter migration for that revision and materializes a read-only, rebuildable v3
  view. The cache identity includes the immutable source identity, source and target compiler
  versions, and migration-chain version; concurrent materialization is protected by a file lock.
- Compiler migration does not mutate the authoritative revision manifest, content-addressed
  snapshot, revision number, or project head. A subsequent user publication writes a new v5
  revision while old v4 revisions remain readable.
- An interrupted v4-to-v5 eager migration from an affected prior release is recovered by rolling
  back its stable journal and backup. No new eager migration is started.
- Failure is revision-scoped. A missing migration, future compiler, invalid historical lock, or
  migration I/O error returns a structured `project_revision_unavailable` result for that revision;
  it does not prevent Desktop startup or access to unrelated revisions and executors.
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

Historical revisions are not required to pass newly added whole-project authoring validation merely
to be upgraded. The migration validates the historical schema and lock, serializes the current
shape into the derived view, and lets normal health checks report current diagnostics. Execution
still applies dependency-closure validation and fails closed for the selected executor.

Changes to the closed DSL resource union, strict resource schemas, or portable validators that can
reject a previously published revision require a compiler version bump, a same-change adjacent
migration, real historical fixtures, Host lazy-materialization and isolation coverage, and an
update to the compiler capability declaration. Declaring an upgrade source as directly readable is
invalid.
