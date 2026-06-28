# Module Boundaries

ExpertMesh uses explicit package layers so product capabilities can grow without blurring runtime, client, server, and core agent boundaries.

In the diagrams below, `A -> B` means `A` may depend on `B`.

```text
apps/web    -> client -> shared
apps/server -> server -> core -> shared
apps/worker -> server -> core -> shared
apps/desktop    -> core -> shared
```

## Layers

| Layer    | Responsibility                                                                  |
| -------- | ------------------------------------------------------------------------------- |
| `shared` | Runtime-neutral contracts, domain types, and pure utilities                     |
| `client` | Browser/client SDKs and client-safe API access                                  |
| `server` | Node-only control plane and infrastructure boundaries                           |
| `core`   | Cloud-first Expert Agent execution abstractions and Runtime Adapter contracts   |
| `apps`   | Composition and process entry points, including future Desktop App local bridge |

## Dependency Matrix

| Source         | Allowed dependencies                                                   |
| -------------- | ---------------------------------------------------------------------- |
| `apps/web`     | `shared/*`, `client/*`                                                 |
| `apps/server`  | `@expertmesh/shared`, `@expertmesh/server`, `@expertmesh/core`         |
| `apps/worker`  | `@expertmesh/shared`, `@expertmesh/server`, `@expertmesh/core`         |
| `apps/desktop` | `@expertmesh/shared`, `@expertmesh/core`                               |
| `packages/shared` | Runtime-neutral dependencies only                                   |
| `packages/client` | `@expertmesh/shared`                                                |
| `packages/server` | `@expertmesh/shared`; orchestration code may depend on `@expertmesh/core` |
| `packages/core`   | `@expertmesh/shared`                                                |

Cross-package imports must use `@expertmesh/*` names, not relative paths.

Expert Agents are cloud-first execution units scheduled by Server/Worker. Future local Claude Code, Codex, or self-hosted runtimes should be reached through the Desktop App local bridge. The Desktop App actively connects to the cloud Runtime Gateway, registers local capabilities, enforces local permissions, and invokes local Agent adapters. Do not add `apps/local-runner`; the product entry for local Agent bridging is `apps/desktop`.

Current core runtime implementation:

```text
packages/core/src/pi-runtime
```

`@expertmesh/core` belongs to the core agent layer. It may depend on `@expertmesh/shared` and runtime SDKs such as PI agent, but must not depend on server internals, client SDKs, Web UI, or database packages. The first runtime kind is `cloud-pi-agent`.

Future local bridge directories:

```text
apps/desktop
packages/core/src/local-agent-bridge
packages/server/src/runtime-gateway
```
