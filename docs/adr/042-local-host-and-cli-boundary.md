# ADR 042: Local Host application layer and CLI boundary

## Status

Accepted

## Context

Desktop Main currently composes device-local catalog, Mission, storage, credential, Runtime, and
Context capabilities. A user-installed CLI must remain usable while Desktop is closed, without
coupling application semantics to Electron or terminal presentation.

## Decision

Introduce the Node-only `@pragma/local-host` package as the application layer shared by Desktop Main
and `@pqpo/pragma`. It owns Host-neutral use cases and ports for executor catalog queries, Mission
queries and commands, shared Mission Board reads, Mission controller coordination, durable command
inbox/event infrastructure, and cross-Host secret access. Persistent families are owned by the
package that owns the aggregate: Local Host owns its new Mission controller, command inbox, event,
request-registry, and secret-envelope families; Core continues to own only Core storage families.

`apps/cli` is a thin Node process adapter. It owns argv parsing, TTY interaction, text/json/jsonl
presentation, signal handling, exit codes, and composition. Concrete Runtime factories are injected
by Desktop Main and CLI composition roots; `@pragma/local-host` never imports `@pragma/runtime-*` or
a Runtime SDK. Desktop Main may depend on Local Host, while Desktop preload, renderer, and shared
contracts remain browser-safe and may not import it.

The CLI is published independently as public `@pqpo/pragma`, binary `pragma`, a pure ESM package that
requires a user-installed Node.js `>=22`. It supports only macOS (`darwin`) and Windows (`win32`);
the initial CPU test matrix is macOS arm64/x64 and Windows x64. Desktop neither installs the CLI nor
changes PATH or shell configuration. The CLI is not a daemon, cloud listener, MCP/Skills surface, or
`apps/local-runner`.

## Consequences

- `apps/desktop` Main and `apps/cli` both depend on `@pragma/local-host`; lower packages and runtime
  packages cannot depend on either Host surface.
- Package manifests and ESLint enforce the direction, including no relative imports across packages.
- npm scope ownership, public access, OIDC trusted publishing, and provenance remain release
  prerequisites; they do not alter the source architecture.

## R1 implementation note (2026-10-02)

Issue #348 R1 centralizes Mission command dispatch, message admission, strict-target checks,
queue mutations and command rejection in Local Host. Desktop and the default Node/CLI
composition share the same control factory and process-local MissionExecutionOwner access.
Desktop presentation metadata remains outside that owner. Compile preparation and first-run
execution retain narrow temporary dependencies for R2/R3, so this note does not declare a complete
application-kernel migration. Persistent Schema/wire versions, transaction fencing and historical
migration chains are unchanged. The [implementation report](../architecture/local-host-kernel-r1-implementation.md)
records correctness and performance exit status independently.

## R4 application kernel (2026-10-04)

Desktop and CLI now compose the same Local Host Mission application factory. Surfaces supply
resource, persistence, interaction and presentation adapters; replacing a complete command or
execution service is outside the composition contract. Internal Mission callers use shared
application use cases. See [ADR 066](066-unified-local-host-mission-application.md) for lifetime,
delivery and validation boundaries. Engineering implementation and full product acceptance remain
separate; [R4 report](../architecture/local-host-kernel-r4-implementation.md) records outstanding gates.
