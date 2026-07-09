# ADR 001: Monorepo and Dependency Rules

## Status

Accepted.

## Decision

Pragma uses `pnpm workspace` with Turborepo as the monorepo foundation.

The repository is layered by package family:

- `shared` for runtime-neutral contracts, domain logic, and utilities.
- `client` for browser/client SDK capabilities.
- `server` for Node service infrastructure boundaries.
- `core` for Expert Agent declarations, runtime contracts, directives, tools, plugins, and shared execution abstractions.
- `runtime-*` for concrete runtime adapter implementations.
- `plugins/*` for ExpertAgent extensions built on the `core` plugin API.
- `apps` for application composition and startup only.
- `examples` for runnable demonstrations that may compose core, plugins, and concrete runtimes.

All internal dependencies must use `workspace:*`.

ESLint enforces illegal dependency directions, browser and Node environment separation, and forbidden runtime imports.

## Consequences

Applications stay thin and compose packages rather than becoming shared-code containers.

Shared packages remain portable across browser and Node environments.

Illegal imports fail during local lint and CI.

## Alternatives Considered

Nx is not introduced yet. Turborepo is enough for workspace task orchestration at the current size.

## Follow-Up

If the dependency graph grows significantly, Pragma can introduce Nx for dependency graph visualization and stricter module-boundary tooling.
