# Pragma YAML DSL

Pragma DSL is the canonical declaration format for `Expert`, `ExpertTeam`, and `Flow`. The runtime
loads YAML into Zod-validated portable resources, resolves references, validates dependency and
control-flow graphs, and compiles the selected resource directly into the existing Core object
model. There is intentionally no parallel `define*FromManifest` API.

The implementation belongs to `@pragma/interpreter`. AST consumers that must remain browser-safe
import schemas and inferred types from `@pragma/interpreter/ast`; Node hosts import parsing and
compilation APIs from `@pragma/interpreter`. Core only provides the object model and execution
primitives targeted by compilation.

## Project layout

```text
pragma.yaml
experts/
  lead.pragma.yaml
  reviewer.pragma.yaml
teams/
  delivery.pragma.yaml
flows/
  review/
    flow.pragma.yaml
    graph.pragma.yaml
pragma.lock.yaml
```

The root file imports resources. A structural `$include` can split any large mapping or list. Both
imports and includes are confined to the configured project root after resolving symlinks.

```yaml
apiVersion: pragma/v1
kind: Bundle
imports:
  - ./experts/lead.pragma.yaml
  - ./experts/reviewer.pragma.yaml
  - ./teams/delivery.pragma.yaml
  - ./flows/review/flow.pragma.yaml
```

## Expert and invocable tools

An Expert refers to another Expert, Team, or Flow through a versioned Tool Adapter. The reference
itself does not invent tool semantics: `pragma.tool.call@v1` exposes one synchronous call tool,
while `pragma.tool.delegate@v1` exposes the governed expert lifecycle tools. New semantics are
registered through `ToolAdapterRegistry` without changing the DSL compiler.

```yaml
apiVersion: pragma/v1
kind: Expert
metadata:
  id: lead
  version: 1.0.0
  name: Delivery lead
  description: Coordinates delivery
spec:
  scope: Own the delivery outcome.
  runtime:
    id: codex
    model: gpt-5.3-codex
  tools:
    - adapter: pragma.tool.call@v1
      target: { ref: flow:review@1.0.0 }
      tool:
        name: run_review
        description: Run the governed review workflow.
        approval: ask
    - adapter: pragma.tool.delegate@v1
      targets:
        - { ref: expert:reviewer@1.0.0 }
      policy:
        maxConcurrency: 2
        maxDepth: 3
        context: context:pragma.context.fresh@v1
```

`ResourceInvoker` execution stays inside the current `Execution`: child invocations, contexts,
runtime routing, events, cancellation, and usage remain visible to the same governance boundary.

## ExpertTeam

```yaml
apiVersion: pragma/v1
kind: ExpertTeam
metadata:
  id: delivery
  version: 1.0.0
  name: Delivery team
  description: Delivers and reviews changes
spec:
  coordinator: { ref: expert:lead@1.0.0 }
  members:
    - { ref: expert:lead@1.0.0 }
    - { ref: expert:reviewer@1.0.0 }
  delegation:
    maxConcurrency: 4
    maxDepth: 3
    context: context:pragma.context.fresh@v1
    runtimes: {}
```

The Team is itself invocable. A Team does not implicitly turn arbitrary Flow references into
behavior; its coordinator declares any Flow it needs as a tool.

## Flow, Human Loop, and explicit back edges

A Flow is a durable directed graph. Ordinary transitions must remain acyclic. Every back edge is a
`repeat` transition owned by a named loop with a positive iteration limit. Validation rejects
unmarked cycles, unknown targets, loops with multiple entries, and repeat edges that do not return
to the declared entry.

```yaml
apiVersion: pragma/v1
kind: Flow
metadata:
  id: review
  version: 1.0.0
  name: Review loop
  description: Revise until a human accepts the result
spec:
  limits:
    maxNodeVisits: 100
  graph:
    start: draft
    steps:
      draft:
        expert: { ref: expert:reviewer@1.0.0 }
        input: "Review this goal: {{ $input.goal }}"
        save: state.review
      approve:
        human:
          kind: approval
          title: Accept review
          prompt: Approve the review or request another iteration.
        save: state.decision
    loops:
      revision:
        entry: draft
        maxIterations: 3
        onLimit: { fail: Review iteration limit reached }
    transitions:
      draft: approve
      approve:
        route: approved
        cases:
          "false":
            repeat:
              loop: revision
              goto: draft
        fallback: { end: true }
```

Loop counters and the selected transition are committed to execution state before scheduling the
next node. Recovery therefore cannot accidentally consume the same iteration twice. Runtime emits
`flow.loop.entered`, `flow.loop.repeated`, `flow.loop.exited`, and `flow.loop.exhausted` events.

## Runtime API

```ts
import { loadPragmaProject } from "@pragma/interpreter";

const project = await loadPragmaProject("./pragma.yaml", {
  rootDir: process.cwd(),
  requireLock: true,
});

const diagnostics = await project.validate();
const compiled = await project.compile("flow:review@1.0.0", host);
const files = await project.dump(compiled.value, { split: "by-resource" });
```

`createLock()` records canonical references and SHA-256 content hashes. With `requireLock`, missing,
stale, or incomplete locks are validation errors. `dump()` uses compiler provenance, so a compiled
object can be serialized back to canonical DSL without defining separate manifest constructors.

## Desktop persistence

Desktop publishes the same resources under:

```text
~/.pragma/projects/<projectId>/manifest.yaml
~/.pragma/projects/<projectId>/revisions/<revision>/pragma.yaml
~/.pragma/projects/<projectId>/revisions/<revision>/{experts,teams,flows}/*.pragma.yaml
~/.pragma/projects/<projectId>/revisions/<revision>/pragma.lock.yaml
```

Publishing validates the complete staged project and atomically advances `manifest.yaml`. Missions
pin a resource reference and project revision, so later Studio edits do not change an existing
mission. The removed expert JSON format is not read or migrated.
