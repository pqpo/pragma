# Module Boundaries

ExpertMesh uses explicit package layers so product capabilities can grow without blurring runtime, client, server, and agent boundaries.

In the diagrams below, `A -> B` means `A` may depend on `B`.

```text
apps/web    -> client -> shared
apps/server -> server -> agent -> shared
apps/worker -> server -> agent -> shared
apps/desktop    -> agent -> shared
```

## Layers

| Layer    | Responsibility                                                                  |
| -------- | ------------------------------------------------------------------------------- |
| `shared` | Runtime-neutral contracts, domain types, and pure utilities                     |
| `client` | Browser/client SDKs and client-safe API access                                  |
| `server` | Node-only control plane and infrastructure boundaries                           |
| `agent`  | Cloud-first Expert Agent execution abstractions and Runtime Adapter contracts   |
| `apps`   | Composition and process entry points, including future Desktop App local bridge |

## Dependency Matrix

| Source         | Allowed dependencies                                                   |
| -------------- | ---------------------------------------------------------------------- |
| `apps/web`     | `shared/*`, `client/*`                                                 |
| `apps/server`  | `shared/*`, `server/*`, `agent/*`                                      |
| `apps/worker`  | `shared/*`, `server/*`, `agent/*`                                      |
| `apps/desktop` | `shared/*`, `agent/*`                                                  |
| `shared/*`     | `shared/*` only                                                        |
| `client/*`     | `shared/*`, `client/*`                                                 |
| `server/*`     | `shared/*`, `server/*`; orchestration packages may depend on `agent/*` |
| `agent/*`      | `shared/*`, `agent/*`                                                  |

Cross-package imports must use `@expertmesh/*` names, not relative paths.

Expert Agents are cloud-first execution units scheduled by Server/Worker. Future local Claude Code, Codex, or self-hosted runtimes should be reached through the Desktop App local bridge. The Desktop App actively connects to the cloud Runtime Gateway, registers local capabilities, enforces local permissions, and invokes local Agent adapters. Do not add `apps/local-runner`; the product entry for local Agent bridging is `apps/desktop`.

Current agent runtime implementation:

```text
packages/agent/agent-runtime
```

`@expertmesh/agent-runtime` belongs to the `agent` layer. It may depend on `@expertmesh/agent-core` and runtime SDKs such as PI agent, but must not depend on server internals, client SDKs, Web UI, or database packages. The first runtime kind is `cloud-pi-agent`.

Future local bridge directories:

```text
apps/desktop
packages/agent/agent-runtime
packages/agent/local-agent-bridge
packages/server/runtime-gateway
```
