# ADR 010: Pragma DSL v2 and Interpreter-Owned Project Service

## Status

Accepted. Supersedes the portable-format and Desktop-ownership portions of ADR 009.

## Context

Expert, Team, and Flow definitions alone are insufficient to reproduce an installation. Their MCP,
Skill, Context, model, and local-host dependencies also need portable identity, while credentials
and machine-specific values must remain outside shared definitions. Desktop must not become the
only place that knows how to assemble or validate these objects because the same projects will run
from Web and server environments.

## Decision

Pragma adopts the breaking `pragma/v2` resource model without a v1 compatibility layer. In addition
to Expert, ExpertTeam, and Flow, it defines Capability, ContextStore, and RuntimeProfile resources.
All semantic references are exact and multiple versions may coexist.

`@pragma/interpreter` owns `PragmaProjectService`, canonical resource identity, portable and
environment validation, compilation, lock generation, Adapter Registry resolution, provenance,
and dumping. A host supplies a source repository, named binding resolver, artifact resolver, secret
resolver, Runtime Registry, and workspace. Desktop and future server hosts implement those ports;
they do not independently construct DSL Experts.

Definitions may be published without installed bindings. Compilation and execution require every
referenced adapter resource to verify successfully. Portable project fingerprints and environment
fingerprints are separate. Recovery requires the environment fingerprint originally pinned by the
run.

Project-local artifacts are content-hashed. External artifacts require a SHA-256 integrity pin.
Adapters explicitly enumerate artifact dependencies, undeclared reads fail, and hashing operates
on raw bytes. Credentials and live values never enter the DSL or project lock.

Resource adapters expose `ready` or `needs_attention` inspection rather than hiding installation
failures. RuntimeProfile declares only routing plus an optional composite model selection
(`providerId + modelId + thinkingLevel`); it never embeds Provider credentials. Environment
inspection verifies that selection against the resolved Runtime Adapter's catalog. The Runtime
Adapter owns model discovery: PI projects registered Model Provider models, while Codex and Claude
Code use their native discovery.

`runtimeId` is the unique identity of one configured Runtime Adapter instance. It does not encode
the Adapter implementation or execution placement. Core depends on an asynchronous
`RuntimeResolver`, never a process-global Registry. A new Context binds the latest immutable
Runtime Environment revision; persisted Contexts resolve their original
`runtimeId + revision + fingerprint`. Desktop implements this with a versioned store, tombstones,
and an Adapter Factory Registry, so configuration changes do not require restart and do not mutate
active Context identity. Consequently, a directly accessible remote Runtime is another Adapter and
does not require a Runtime Gateway; Gateway remains reserved for cloud-to-device dispatch and
bridge lifecycle concerns.

DSL objects are strict and reject unknown fields. Flow control metadata is isolated from user state,
and all shared Execution state mutations use optimistic version checks with retries. Runtime routing
uses the target Expert's RuntimeProfile unless a step or scoped routing map explicitly overrides it.

Flow timeouts are persisted absolute deadlines and recursively abort Runtime, Task, nested Flow,
and Human Interaction work while recording `failed/timeout`. Desktop Note Context uses Core's
durable JSON store; DSL note/static entries are read-only static stores. Changing dynamic note
content does not change a Context binding fingerprint.

The built-in Steward is owned by `@pragma/steward` as portable DSL plus an authoring Skill. It
becomes a product Home experience only when the application supplies project/task ports, Runtime
selection, and confirmation UI.

## Consequences

- Desktop is a persistence and environment-adapter host, not a second interpreter.
- Web uses the browser for editing and a server-side interpreter for validation and execution.
- Adapter IDs and versions are part of the language compatibility surface.
- A binding revision or verification change creates a different environment fingerprint even when
  portable YAML is unchanged.
- Old local v1 data is reported as unsupported and is neither migrated nor deleted automatically.
- Plugins remain exact references, but execution is blocked until a v2 Plugin resolver is added.
- Published snapshots expose only the lock stored on disk; invalid locks block mutation and
  execution instead of being regenerated during reads.
