# ADR 001: Monorepo and Dependency Rules

## Status

Accepted.

## Decision

ExpertMesh uses `pnpm workspace` with Turborepo as the Phase 0 monorepo foundation.

The repository is layered by package family:

- `shared` for runtime-neutral contracts, domain logic, and utilities.
- `client` for browser/client SDK capabilities.
- `server` for Node service infrastructure boundaries.
- `agent` for Node-only Agent execution boundaries.
- `apps` for application composition and startup only.

All internal dependencies must use `workspace:*`.

ESLint enforces illegal dependency directions, browser and Node environment separation, and forbidden runtime imports.

## Consequences

Applications stay thin and compose packages rather than becoming shared-code containers.

Shared packages remain portable across browser and Node environments.

Illegal imports fail during local lint and CI.

## Alternatives Considered

Nx is not introduced in Phase 0. Turborepo is enough for workspace task orchestration at the current size.

## Follow-Up

If the dependency graph grows significantly, ExpertMesh can introduce Nx for dependency graph visualization and stricter module-boundary tooling.
