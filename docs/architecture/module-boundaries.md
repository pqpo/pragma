# Module Boundaries

Pragma uses explicit package layers so product capabilities can grow without blurring runtime, application, and core agent boundaries.

In the diagrams below, `A -> B` means `A` may depend on `B`.

```text
apps/web    -> shared
apps/server -> core/shared
apps/worker -> runtime-* -> core -> shared
apps/cli    -> local-host -> shared/core/interpreter/evaluation/built-in-agents/memory/context-filesystem
apps/desktop main -> local-host
apps/desktop    -> built-in-agents -> interpreter -> evaluation -> core -> shared
                       |-> memory -> core -> shared
apps/desktop    -> interpreter -> evaluation -> core -> shared
apps/desktop    -> runtime-* -> core -> shared
plugins/*   -> core -> shared
examples    -> runtime-* / plugin-* / core -> shared
```

## Layers

| Layer             | Responsibility                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `shared`          | Runtime-neutral contracts, domain types, and pure utilities                                          |
| `core`            | Expert Agent execution abstractions and Runtime Adapter contracts                                    |
| `evaluation`      | Independent Run Dry and Agent Judge dataset contracts, assertions, sampling, and results             |
| `interpreter`     | Pragma DSL AST, parser, validator, compiler, registries, and semantic dump                           |
| `built-in-agents` | Six DSL-defined built-in Agents, their independent host ports, portable product logic, and contracts |
| `runtime-*`       | Concrete Runtime Adapter implementations                                                             |
| `local-host`      | Node-only device-local application services and Mission Board shared by Desktop Main and the CLI     |
| `plugins/*`       | Expert extensions built on the core plugin API                                                       |
| `apps`            | Composition and process entry points, including the Desktop-owned local bridge boundary              |
| `examples`        | Runnable demonstrations that may compose core, plugins, and concrete runtimes                        |

## Dependency Matrix

| Source                     | Allowed dependencies                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                 | `@pragma/shared`                                                                                                                                                                                           |
| `apps/server`              | `@pragma/shared`, `@pragma/core`                                                                                                                                                                           |
| `apps/worker`              | `@pragma/shared`, `@pragma/core`, concrete `@pragma/runtime-*` packages                                                                                                                                    |
| `apps/cli`                 | `@pragma/local-host`, `@pragma/shared/integration`, concrete `@pragma/runtime-*` at its composition root                                                                                                   |
| `apps/desktop`             | `@pragma/shared`, `@pragma/core`, `@pragma/evaluation`, `@pragma/interpreter`, `@pragma/built-in-agents`, concrete `@pragma/runtime-*` packages                                                            |
| `packages/local-host`      | `@pragma/shared`, `@pragma/core`, `@pragma/interpreter`, `@pragma/evaluation`, `@pragma/built-in-agents`, `@pragma/memory`, `@pragma/context-filesystem`; Node built-ins and runtime-neutral third parties |
| `plugins/*`                | `@pragma/shared`, `@pragma/core`; no app, server, client, or concrete runtime dependencies                                                                                                                 |
| `examples`                 | `@pragma/core`, concrete `@pragma/runtime-*`, and concrete `@pragma/plugin-*` packages                                                                                                                     |
| `packages/shared`          | Runtime-neutral dependencies only                                                                                                                                                                          |
| `packages/core`            | `@pragma/shared`                                                                                                                                                                                           |
| `packages/evaluation`      | `@pragma/core`; its `/ast` export remains browser-safe and never depends on Interpreter                                                                                                                    |
| `packages/interpreter`     | `@pragma/shared`, `@pragma/core`, `@pragma/evaluation`; its `/ast` export remains browser-safe                                                                                                             |
| `packages/built-in-agents` | `@pragma/shared`, `@pragma/core`, `@pragma/interpreter`, `@pragma/evaluation`, `@pragma/memory`; `/contracts` remains browser-safe                                                                         |
| `packages/runtime/*`       | `@pragma/shared`, `@pragma/core`, and that runtime's own SDKs                                                                                                                                              |

Cross-package imports must use `@pragma/*` names, not relative paths.

`@pragma/local-host` is a Node-only application layer, not a Runtime adapter or UI layer. Its
`@pragma/local-host/node-application` subpath owns the shared Node composition (Mission controller,
owner lifecycle, query/watch, catalog, Board and Core run wiring). It may not depend on any `apps/*`,
Electron, React/Next, or `@pragma/runtime-*`. Runtime factories
or a Host-owned `RuntimeResolver` are injected by `apps/desktop` Main or `apps/cli` composition. A
richer Host may inject MissionRunner control/run ports; Local Host still owns the Mission control and
run application assembly.
`@pragma/shared`, Core, Interpreter, Evaluation, Built-in Agents, Memory,
Context Filesystem, Runtime packages, plugins, and examples may not depend on
`@pragma/local-host` or `@pqpo/pragma`. Desktop preload/renderer/shared code remains browser-safe and
may consume `@pragma/shared/integration` but never Local Host.

`@pragma/shared/integration` is the sole cross-process wire source. The former
`@pragma/local-host/wire` forwarding subpath was removed; CLI/IPC adapters import integration
schemas directly. Detached commands cross the durable Inbox boundary before returning and use
query/watch for eventual owner/execution state.

Expert Agents are cloud-first execution units scheduled by Server/Worker. Local Claude Code, Codex, Qoder CLI, Antigravity CLI, or self-hosted runtimes should be reached through the Desktop App local bridge. The Desktop App actively connects to the cloud Runtime Gateway, registers local capabilities, enforces local permissions, and invokes local Agent adapters. Do not add `apps/local-runner`; the product entry for local Agent bridging is `apps/desktop`.

Current runtime implementations:

```text
packages/runtime/pi
packages/runtime/codex
packages/runtime/claude-code
packages/runtime/qodercli
packages/runtime/antigravity
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
Worker. The default runtime selection is an application-layer decision; Desktop currently registers
PI, Codex, Claude Code, Qoder CLI, and Antigravity CLI runtimes and uses PI by default.

`@pragma/built-in-agents` owns the six portable DSL-defined Agents: the general-purpose Pragma and
Store Revision Agents plus the internal Memory Curator, Skill Revision, Skill Evaluation, and
Evaluation Judge Agents.
It also owns their independent application-neutral host ports and reusable product logic.
It does not depend on Desktop, Electron, Web, Server, database code, or a concrete Runtime Adapter.
Applications compose the package with their own DSL project persistence and task implementations;
the package exposes runtime-neutral project/task schemas through `@pragma/built-in-agents/contracts`.
Automation maintenance follows the same boundary: Core owns trigger/delivery contracts, Interpreter
owns the portable `Automation` resource, Built-in Agents owns an application-neutral maintenance
port, and Desktop owns schedule lifecycle, host bindings, queues, and Mission dispatch. Webhook or
IM credentials belong to Host Connections and never to DSL or Core.

Desktop Home is a Mission creation entry, not a separate chat runtime. Desktop's System Expert
Registry projects `expert:0000000000pragma` as the read-only default Expert and resolves it for both
Studio and Mission execution. Users can run Pragma without authoring any project Expert. Its DSL
authoring and Mission-management tools are built-in capabilities, while ordinary work uses the
selected Runtime and authorized workspace. Mission storage, Execution events, chat projection,
approvals, and recovery are shared by every executor. System refs are reserved by the application;
resource tags never grant immutability.

Local bridge placement:

```text
apps/desktop
packages/core/src/local-agent-bridge
apps/server/src/runtime-gateway
```
