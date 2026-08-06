# Pragma YAML DSL v3

Pragma DSL is the canonical, portable definition language for `Expert`, `ExpertTeam`, `Flow`,
`Automation`, `Capability`, `ContextStore`, and `RuntimeProfile`. `@pragma/interpreter` owns parsing, linking,
validation, environment resolution, compilation, locking, and normalized dumping. Core remains the
execution object model and does not depend on the interpreter.

`pragma/v3` removes semantic resource versions. The Interpreter owns the pure, bounded
`pragma/v2`-to-`pragma/v3` DSL migration described by ADR 024, while Desktop owns the file
transaction described by ADR 023. The normal parser and compiler accept only current DSL.

DSL `apiVersion`, Host/runtime-state `schemaVersion`, immutable project `revision`, and independently
shipped adapter or plugin versions are separate compatibility axes. They do not share migration
switches.

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

Applications also own migration transactions, but not DSL transformation rules. A Host reads an old
revision, calls the Interpreter's in-memory adjacent migration chain, republishes the canonical
current resources, and uses the returned identity mapping for Host-specific dependent records.
That publication path applies to DSL `apiVersion` migrations that rewrite identities; it is not the
compiler compatibility path.

Compiler compatibility is declared on a separate axis from DSL `apiVersion`. The current
Interpreter writes and directly reads `pragma.dsl/v3`, while `pragma.dsl/v2` is only an upgrade
source. Desktop supports mixed v4/v5 storage and upgrades only the requested v2 revision into a
read-only, rebuildable v3 view. It does not rewrite the authoritative snapshot, revision manifest,
project head, or unrelated history. The compiler migration validates the historical lock and
removes the abandoned `Flow.spec.runDry` field without creating an Evaluation. A version may be
advertised as directly readable only when the current parser accepts real revisions written by that
version.

Application startup does not enumerate or migrate project history. Startup-critical shared state
may fail closed, but project revision compatibility is checked at the revision access boundary.
Migration failure returns a structured revision-level error, leaving unrelated revisions and
application capabilities available.

## Project layout and identity

Every semantic reference contains one Host-generated opaque ID. Project revisions, rather than
resource versions, preserve historical definitions.

```text
pragma.yaml
experts/0000000000pragma.pragma.yaml
teams/2h3j4k5m6n7p8q9r.pragma.yaml
flows/3h4j5k6m7n8p9q0r.pragma.yaml
automations/4h5j6k7m8n9p0q1r.pragma.yaml
capabilities/5h6j7k8m9n0p1q2r.pragma.yaml
context-stores/6h7j8k9m0n1p2q3r.pragma.yaml
runtime-profiles/7h8j9k0m1n2p3q4r.pragma.yaml
pragma.lock.yaml
```

```yaml
apiVersion: pragma/v3
kind: Bundle
imports:
  - ./runtime-profiles/7h8j9k0m1n2p3q4r.pragma.yaml
  - ./experts/1h2j3k4m5n6p7q8r.pragma.yaml
resources: []
```

Imports and structural `$include` paths are confined to the project root after symlink resolution.

## Declarative resources and environment bindings

MCP, Skills, code tools, context sources, and model settings are represented by portable resources.
Machine-specific endpoints, credentials, live stores, and host tools are referenced through named
bindings and resolved only by the installation environment.

```yaml
apiVersion: pragma/v3
kind: Capability
metadata:
  id: 5h6j7k8m9n0p1q2r
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

`Automation` is a declarative integration resource rather than an invocable resource. It selects a
versioned trigger adapter, exact executor ref, input, continuity policy, and delivery adapter.
Desktop currently binds `pragma.automation.schedule@v1`; local workspace, permission mode, model
override, credentials, and future IM Connection secrets remain host state. Expert and ExpertTeam
may reuse one Mission FIFO or create a Mission per event. Flow always creates a new Mission.

Host Context bindings expose the six-method Context Store contract. Core supplies
`JsonContextStore` for durable local notes and `StaticContextStore` for DSL-defined read-only
entries. The JSON store uses one `contexts.json` payload, optimistic item revisions/etags,
cross-process locking, and atomic replacement. Dynamic Context content is deliberately excluded
from environment fingerprints; only store identity and connection configuration are pinned.

## Expert and resource invocation

```yaml
apiVersion: pragma/v3
kind: Expert
metadata:
  id: 1h2j3k4m5n6p7q8r
  name: Delivery lead
  description: Coordinates delivery
spec:
  scope: Own the delivery outcome.
  runtime: { ref: runtime-profile:7h8j9k0m1n2p3q4r }
  capabilities:
    - ref: capability:5h6j7k8m9n0p1q2r
      kind: tools
      tools: [read_file, edit_file]
  toolApprovals: { edit_file: required }
  contextStores:
    - ref: context-store:6h7j8k9m0n1p2q3r
      namespace: project_guide
      required: true
  plugins:
    - ref: plugin:pragma.memory@0.0.0
      config: { task: { enabled: true } }
  tools:
    - adapter: pragma.tool.call@v1
      target: { ref: flow:3h4j5k6m7n8p9q0r }
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
credential fingerprints participate in the environment fingerprint for validation and audit. A
changed plugin does not by itself block Desktop Mission recovery; concrete plugin failures are
reported when the recovered execution uses the plugin.

Flow input and output JSON Schemas remain attached when a Flow is exposed as a Tool. Tool timeout,
caller cancellation, and target Flow timeout are independent deadlines; the earliest aborts only
the affected Invocation subtree. Tool output uses safe JSON serialization, including an explicit
`null` text result for `undefined`.

## Teams and bounded Flow loops

Teams refer to exact Expert and RuntimeProfile IDs within the pinned project revision. A Team may define optional
`spec.instructions`; Core exposes it to the coordinator and every member
as a critical, always-on `TEAM.md` Context System document for that Team execution only. The
document does not mutate the reusable Expert definition or leak into other Teams that use the same
Expert. Flow ordinary edges must form a DAG. A
back edge is legal only as a named `repeat` transition with a positive `maxIterations`. Loop state
is persisted with the Execution before the next node is scheduled, making recovery idempotent.
Ordinary and repeat edges remain distinct multigraph edges, and `onLimit` must leave the loop.
Internal control state lives in a reserved namespace that DSL `save` paths cannot address; state
reducers, deadlines, loop counters, and transition decisions use versioned CAS commits so
concurrent nested Flows cannot overwrite one another.
Flow `limits.timeoutMs` is compiled into Core and persisted as an absolute runtime deadline on
first entry. HumanTask waits pause that deadline, including across process restart recovery, so a
Flow waiting for user input does not fail only because the app was closed or upgraded. Timeout is a
`failed` terminal state; explicit user cancellation remains `cancelled`.

Run Dry suites are portable `Evaluation` resources that target a Flow by exact ref; Flow specs do
not embed test cases. The Node-only `@pragma/evaluation` runner evaluates declarative data
contracts, node-result state, terminal value mapping, and JSON Schema checks without resolving
Runtime or host bindings. Route, array-route, and loop decisions reuse Core's pure Flow control
semantics. `expectInput` always verifies the case's original Flow input, while `expectPrompt`
independently verifies rendered Expert, Team, and Human prompts. Desktop invokes the runner through
its validated preload/IPC bridge. Suite success requires passing assertions and complete coverage
of every declared transition, loop-repeat, and loop-limit outcome.

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

The browser-safe Interpreter compiler capability declares one write version and the bounded set of
readable versions. Revision metadata and `pragma.lock.yaml` must agree before resource parsing.
Unsupported versions use `compiler.version_unsupported`; metadata disagreement uses
`compiler.version_metadata_mismatch`. Neither condition is reported as a stale lock.

Complete-project validation remains the authoring and publication health gate. Runtime compilation
validates only the selected Expert, Team, or Flow and its transitive project-resource dependencies.
Compiler, lock, unreadable source topology, and resource identity ambiguity are project-wide
blockers; unrelated resource-reference or Flow-contract diagnostics remain visible in project
health without disabling independent executors.

Compilation separately returns an environment fingerprint containing:

- the environment ID;
- the project fingerprint;
- every resolved resource's binding revision and verification fingerprint.

A Desktop Mission pins its project revision, executor, and workspace. The environment fingerprint
records the bindings used for validation and audit, but is not a recovery gate. Core recovery pins
the persisted Session/Execution identities, existing Runtime Context bindings, and active Flow
definition graph; unavailable live bindings fail only when they are actually required.

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
  ref: "expert:1xddvess309a6gme",
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
history is projected from the canonical Execution event log. The built-in general-purpose Pragma
The five built-in Agent definitions and the DSL-authoring Skill live in `packages/built-in-agents/dsl`; applications install
the package with explicit project and task ports rather than maintaining a second hard-coded runtime
implementation. Desktop registers that bundle as a read-only System Expert; Home creates a fresh
Mission using it by default, and all streaming output uses the normal Mission chat projection.
