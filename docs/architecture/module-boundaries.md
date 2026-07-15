# Module Boundaries

Pragma uses explicit package layers so product capabilities can grow without blurring runtime, client, server, and core agent boundaries.

In the diagrams below, `A -> B` means `A` may depend on `B`.

```text
apps/web    -> client -> shared
apps/server -> server -> core -> shared
apps/worker -> server -> runtime-* -> core -> shared
apps/desktop    -> interpreter -> core -> shared
apps/desktop    -> runtime-* -> core -> shared
plugins/*   -> core -> shared
examples    -> runtime-* / plugin-* / core -> shared
```

## Layers

| Layer         | Responsibility                                                                  |
| ------------- | ------------------------------------------------------------------------------- |
| `shared`      | Runtime-neutral contracts, domain types, and pure utilities                     |
| `client`      | Browser/client SDKs and client-safe API access                                  |
| `server`      | Node-only control plane and infrastructure boundaries                           |
| `core`        | Expert Agent execution abstractions and Runtime Adapter contracts               |
| `interpreter` | Pragma DSL AST, parser, validator, compiler, registries, and semantic dump      |
| `runtime-*`   | Concrete Runtime Adapter implementations                                        |
| `plugins/*`   | Expert extensions built on the core plugin API                                  |
| `apps`        | Composition and process entry points, including future Desktop App local bridge |
| `examples`    | Runnable demonstrations that may compose core, plugins, and concrete runtimes   |

## Dependency Matrix

| Source                 | Allowed dependencies                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `apps/web`             | `shared/*`, `client/*`                                                                         |
| `apps/server`          | `@pragma/shared`, `@pragma/server`, `@pragma/core`                                             |
| `apps/worker`          | `@pragma/shared`, `@pragma/server`, `@pragma/core`, concrete `@pragma/runtime-*` packages      |
| `apps/desktop`         | `@pragma/shared`, `@pragma/core`, `@pragma/interpreter`, concrete `@pragma/runtime-*` packages |
| `plugins/*`            | `@pragma/shared`, `@pragma/core`; no app, server, client, or concrete runtime dependencies     |
| `examples`             | `@pragma/core`, concrete `@pragma/runtime-*`, and concrete `@pragma/plugin-*` packages         |
| `packages/shared`      | Runtime-neutral dependencies only                                                              |
| `packages/client`      | `@pragma/shared`                                                                               |
| `packages/server`      | `@pragma/shared`; orchestration code may depend on `@pragma/core`                              |
| `packages/core`        | `@pragma/shared`                                                                               |
| `packages/interpreter` | `@pragma/core`; its `/ast` export remains browser-safe                                         |
| `packages/runtime/*`   | `@pragma/shared`, `@pragma/core`, and that runtime's own SDKs                                  |

Cross-package imports must use `@pragma/*` names, not relative paths.

Expert Agents are cloud-first execution units scheduled by Server/Worker. Future local Claude Code, Codex, or self-hosted runtimes should be reached through the Desktop App local bridge. The Desktop App actively connects to the cloud Runtime Gateway, registers local capabilities, enforces local permissions, and invokes local Agent adapters. Do not add `apps/local-runner`; the product entry for local Agent bridging is `apps/desktop`.

Current runtime implementations:

```text
packages/runtime/pi
packages/runtime/codex
```

Runtime sessions are owned by exactly one ExpertSession context or FlowExecution Invocation. Public
Runtime Adapters expose capability and model discovery; `defineRuntimeDriver()` registers the private
Session factory. Core stores owner claims under `~/.pragma/state/runtime-session-owners/` and Session
records under `~/.pragma/state/runtime-sessions/`. Recovery must match the original owner,
`systemSessionId`, Expert, Runtime and `RuntimeSessionRef { type, id }`.

An active ExpertSession holds a renewable cross-process lease and owns reusable root Runtime Sessions
until `ExpertSession.close()`. Runtime reuse validates the complete context identity
`{ contextId, expertId, runtimeId }`; an existing context never switches Expert or Runtime. Spawned
Agent contexts are fresh and Execution-scoped; FIFO followups reuse that Agent context and persisted
Runtime snapshot. FlowExecution Runtime Sessions remain execution-scoped.
Execution and human-interaction bindings are submitted atomically with each Runtime submission.

ExpertSession creation atomically establishes one root Runtime Context. All root prompts in that
Session reuse it, while a fresh root requires a new ExpertSession. Runtime routing completes before
Context creation; afterward `RuntimeContextRecord.runtimeId` is the only execution-time Runtime
identity source.

Agent workspaces contain task inputs, repositories, artifacts, and task-authored files only. Runtime
state, configuration, sessions, and installed plugin copies must never be derived from or written
below the workspace. Agent plugin copies live under `~/.pragma/cache/agents/<agent>/plugins/`.

`@pragma/core` belongs to the core agent layer. It may depend on `@pragma/shared`, but must not depend
on `@pragma/interpreter`, concrete runtime packages, runtime SDKs such as PI agent, server internals,
client SDKs, Web UI, or database packages. `@pragma/interpreter` depends on Core's public object model
to compile portable YAML declarations, while `@pragma/interpreter/ast` stays browser-safe. Concrete
runtime packages depend on `@pragma/core` and are assembled by application entry points such as
Worker. The default runtime selection is an application-layer decision; Worker currently registers
PI and Codex runtimes and uses PI by default.

Future local bridge directories:

```text
apps/desktop
packages/core/src/local-agent-bridge
packages/server/src/runtime-gateway
```
