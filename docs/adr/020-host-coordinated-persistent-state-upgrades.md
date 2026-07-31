# ADR 020: Host-Coordinated Persistent State Upgrades

## Status

Accepted

## Context

Desktop upgrades have repeatedly failed in different places: application startup, built-in Expert
initialization, and Mission session recovery. The common problem is not one strict check, but mixed
ownership of identity, compatibility, DSL migration, and durable runtime state.

## Decision

Persistent upgrade responsibilities are split by layer.

- `@pragma/core` owns Core recoverable state only: `ExpertSession`, `Execution`,
  `RuntimeContext`, `RuntimeSession`, ownership claims, and Core storage migration APIs. It exposes
  structured compatibility failures such as `ExpertDefinitionMismatchError`; it does not know DSL,
  Mission, Project, Desktop, or Server policy.
- `@pragma/interpreter` owns portable DSL migration and Pragma resource identity resolution. It keeps
  the static adjacent DSL migration chain, emits resource `identityMigrations` as facts, and exposes
  a pure identity migration index for Hosts. It does not mutate Host storage.
- Host applications own cross-aggregate orchestration. Desktop currently coordinates Project,
  Mission, Automation, ExpertSession, and RuntimeSession recovery only when one requested operation
  actually crosses those owners. Server must use the same boundary when it gains durable Missions.
  Host coordination is not a startup coordinator and does not enumerate every owner to discover
  upgrade work.

When an old Mission points at the same logical executor but persisted session state uses a previous
resource identity, the Host may pass an explicit `definitionMigration` to Core. If Core reports a
definition mismatch that is not safely migratable, the Host creates a successor `ExpertSession` and
binds the next Mission execution to it. The old session remains historical state.

## Consequences

- Core remains fail-closed and no longer needs relaxed fingerprint checks.
- DSL `apiVersion`, Host `schemaVersion`, and Project `revision` stay separate.
- Project resource identity migration resolution is centralized in `@pragma/interpreter` and shared
  by Host Mission and Automation migrations.
- Each store upgrades its minimum safe owner on first actual access. Desktop creates its window
  before starting optional warm-up, reconciliation, Automation, or maintenance work.
- A background capability records and contains its own upgrade failure. It cannot turn one stale
  Project, Mission, Revision, Bundle catalog, or usage database into a process-level startup
  failure.
