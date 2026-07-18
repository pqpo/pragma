# Pragma YAML DSL v2

Pragma DSL is the canonical, portable definition language for `Expert`, `ExpertTeam`, `Flow`,
`Capability`, `ContextStore`, and `RuntimeProfile`. `@pragma/interpreter` owns parsing, linking,
validation, environment resolution, compilation, locking, and normalized dumping. Core remains the
execution object model and does not depend on the interpreter.

`pragma/v2` is a clean break. The interpreter does not read or migrate `pragma/v1`, and applications
must report old local projects as unsupported rather than silently rewriting or deleting them.

## Definition, installation, and execution

The same DSL project can be installed in Desktop, a server, or another future host:

```text
portable YAML project
  -> ProjectService: load / validate / publish / pin revision
  -> Adapter Registry: resolve named environment bindings and artifacts
  -> compiler: Core Expert / Team / Flow + root Runtime + environment fingerprint
  -> Core execution
```

Applications provide persistence and environment adapters. They do not recreate Expert, Team, or
Flow compilation. Desktop stores immutable project revisions and supplies local bindings; a Web
deployment can store the same sources and resolve bindings on its server.

## Project layout and identity

Every semantic reference is exact. Multiple versions of the same kind and ID may coexist.

```text
pragma.yaml
experts/steward@1.0.0.pragma.yaml
teams/delivery@2.0.0.pragma.yaml
flows/review@1.2.0.pragma.yaml
capabilities/repository-tools@3.0.0.pragma.yaml
context-stores/project-guide@1.0.0.pragma.yaml
runtime-profiles/desktop-codex@1.0.0.pragma.yaml
pragma.lock.yaml
```

```yaml
apiVersion: pragma/v2
kind: Bundle
imports:
  - ./runtime-profiles/desktop-codex@1.0.0.pragma.yaml
  - ./experts/lead@1.0.0.pragma.yaml
resources: []
```

Imports and structural `$include` paths are confined to the project root after symlink resolution.

## Declarative resources and environment bindings

MCP, Skills, code tools, context sources, and model settings are represented by portable resources.
Machine-specific endpoints, credentials, live stores, and host tools are referenced through named
bindings and resolved only by the installation environment.

```yaml
apiVersion: pragma/v2
kind: Capability
metadata:
  id: repository-tools
  version: 1.0.0
  name: Repository tools
  description: Tools supplied by the installed environment
spec:
  adapter: pragma.capability.host@v1
  binding: binding:repository-tools
  config: { key: repository-tools }
```

Built-in versioned adapters cover Skill artifacts, MCP, HTTP and code capabilities; file, static,
note and host context stores; host capabilities; and runtime profiles. New semantics are registered
in `PragmaResourceAdapterRegistry` and never inferred from arbitrary YAML fields. Portable DSL,
lock, and health objects are strict schemas: unknown keys are rejected instead of silently removed.

An artifact source is either project-local or external and integrity-pinned:

```yaml
source: { type: project, path: skills/release-writing }
# or
source:
  type: registry
  uri: registry://skills/release-writing/1.0.0
  integrity: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

Portable validation and publishing do not require environment bindings. Environment validation and
compilation do. This allows a project to be authored and shared before every target environment is
installed.

Environment inspection returns one structured health record per declarative resource. A resource
is either `ready`, with a contribution and verification fingerprint, or `needs_attention`, with
stable issues and no contribution. Compilation accepts only `ready` resources. External artifact
verification compares the requested source, declared integrity, resolver hash, and materialized
text or path bytes. Skill `entry` paths must resolve to readable regular files inside the artifact
root, including after symlink resolution. Adapters must enumerate artifact dependencies through
their adapter contract before verification; undeclared artifact reads fail. File hashes use raw
bytes, and directory hashes include each entry's name, type, and child hash.

Host Context bindings expose the six-method Context Store contract. Core supplies
`JsonContextStore` for durable local notes and `StaticContextStore` for DSL-defined read-only
entries. The JSON store uses one `contexts.json` payload, optimistic item revisions/etags,
cross-process locking, and atomic replacement. Dynamic Context content is deliberately excluded
from environment fingerprints; only store identity and connection configuration are pinned.

## Expert and resource invocation

```yaml
apiVersion: pragma/v2
kind: Expert
metadata:
  id: lead
  version: 1.0.0
  name: Delivery lead
  description: Coordinates delivery
spec:
  scope: Own the delivery outcome.
  runtime: { ref: runtime-profile:desktop-codex@1.0.0 }
  capabilities:
    - ref: capability:repository-tools@1.0.0
      kind: tools
      tools: [read_file, edit_file]
  toolApprovals: { edit_file: required }
  contextStores:
    - ref: context-store:project-guide@1.0.0
      namespace: project_guide
      required: true
  plugins:
    - ref: plugin:pragma.memory@0.0.0
      config: { task: { enabled: true } }
  tools:
    - adapter: pragma.tool.call@v1
      target: { ref: flow:review@1.0.0 }
      tool:
        name: run_review
        description: Run the review Flow.
        approval: ask
```

`pragma.tool.call@v1` makes one synchronous call. `pragma.tool.delegate@v1` exposes governed expert
lifecycle tools. Nested calls remain in the current Execution, so context ownership, events,
cancellation, usage, and recovery stay under one governance boundary.

Plugin references are exact environment extension references, not project resources. The host
supplies `PragmaPluginResolver`, which resolves the installed package, Desktop defaults, Expert
overrides, and secret bindings without putting secret values in YAML. Plugin package/config/
credential fingerprints participate in the environment fingerprint, so a changed plugin blocks
recovery of an execution pinned to the previous environment.

Flow input and output JSON Schemas remain attached when a Flow is exposed as a Tool. Tool timeout,
caller cancellation, and target Flow timeout are independent deadlines; the earliest aborts only
the affected Invocation subtree. Tool output uses safe JSON serialization, including an explicit
`null` text result for `undefined`.

## Teams and bounded Flow loops

Teams refer to exact Expert and RuntimeProfile versions. Flow ordinary edges must form a DAG. A
back edge is legal only as a named `repeat` transition with a positive `maxIterations`. Loop state
is persisted with the Execution before the next node is scheduled, making recovery idempotent.
Ordinary and repeat edges remain distinct multigraph edges, and `onLimit` must leave the loop.
Internal control state lives in a reserved namespace that DSL `save` paths cannot address; state
reducers, deadlines, loop counters, and transition decisions use versioned CAS commits so
concurrent nested Flows cannot overwrite one another.
Flow `limits.timeoutMs` is compiled into Core and persisted as an absolute wall-clock deadline on
first entry. Recovery reuses that deadline, so process downtime and HumanTask waits count toward
the same timeout. Timeout is a `failed` terminal state; explicit user cancellation remains
`cancelled`.

Context reuse policies are versioned extension references such as
`context-policy:pragma.fresh@v1`; runtime overrides are exact RuntimeProfile references. Runtime
routing precedence is step override, scoped per-Expert mapping, inherited nested-Flow override,
target Expert RuntimeProfile, then application fallback. The final identity is written only to the
new `RuntimeContextRecord`.

## Lock and environment fingerprint

`pragma.lock.yaml` records canonical resource content hashes and artifact integrity. Its
`projectFingerprint` describes portable semantics and intentionally excludes file placement.
Published revisions must contain their actual lock. A missing, malformed, stale, or compiler-
incompatible lock removes trust in the project fingerprint and blocks apply, compile, and recover;
the service never synthesizes a replacement lock while reading a snapshot.

Compilation separately returns an environment fingerprint containing:

- the environment ID;
- the project fingerprint;
- every resolved resource's binding revision and verification fingerprint.

A run pins both the project revision and environment fingerprint. Recovery must fail if the current
bindings no longer produce the pinned fingerprint.

## Application service

Hosts use `PragmaProjectService` instead of directly assembling runtime objects:

```ts
const service = new PragmaProjectService({ repository });
const published = await service.publish({
  projectId: "studio",
  expectedRevision: 4,
  resources,
});
const compiled = await service.compile({
  projectId: "studio",
  revision: published.revision,
  ref: "expert:lead@1.0.0",
  workspace,
  environmentId: "desktop",
  adapterHost,
});
```

Publishing validates the complete candidate and advances the repository with compare-and-swap.
Desktop stores revisions below `~/.pragma/projects/<projectId>/revisions/<revision>/` and only
implements source persistence and local binding adapters. Missions pin an exact resource and
revision. A Mission v3 directory keeps bounded identity and lifecycle metadata in `mission.yaml`
and appends user turns plus Execution references to `messages.jsonl`; assistant, thinking, and tool
history is projected from the canonical Execution event log. The built-in Steward bundle and its
DSL-authoring Skill live in `packages/steward/dsl`; applications install the package with explicit
project and task ports rather than maintaining a second hard-coded runtime implementation.
