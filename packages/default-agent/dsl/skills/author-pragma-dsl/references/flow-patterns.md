# Tested Flow patterns

Use these as graph shapes, not as new DSL keywords.

## Prompt chain

Connect each step to the next and save outputs explicitly under `state.*`. Map later inputs with
`$state.path`. The last step ends the Flow.

## Routing

Run a classifier that returns a stable field such as `route`, then use a route transition. Declare
all known cases and always include a fallback that ends or fails explicitly.

```yaml-fragment
transitions:
  classify:
    route: route
    cases:
      billing: billing
      technical: technical
    fallback: { fail: Unknown route }
  billing: { end: true }
  technical: { end: true }
```

## Evaluator optimizer

Connect optimizer to evaluator. Route accepted output to end and revisions through an explicit
repeat destination. The named loop has a positive `maxIterations`; `onLimit` exits or fails.

```yaml-fragment
loops:
  refinement:
    entry: optimize
    maxIterations: 3
    onLimit: { fail: Refinement limit reached }
transitions:
  optimize: evaluate
  evaluate:
    route: status
    cases:
      accepted: { end: true }
      revise: { repeat: { loop: refinement, goto: optimize } }
    fallback: { fail: Unknown evaluation status }
```

Parallel and orchestrator-worker graphs are not supported by the sequential Flow scheduler. Do not
simulate them with ordinary edges or claim that branches run concurrently.
