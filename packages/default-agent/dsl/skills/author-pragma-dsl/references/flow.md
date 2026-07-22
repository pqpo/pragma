# Flow resources

Use a Flow for explicit, inspectable control flow.

```yaml
apiVersion: pragma/v2
kind: Flow
metadata:
  id: review_change
  version: 1.0.0
  name: Review Change
  description: Implements a change and asks a reviewer to inspect it.
  tags: [delivery]
spec:
  input:
    schema:
      type: object
      properties:
        goal: { type: string }
      required: [goal]
      additionalProperties: false
  limits:
    maxNodeVisits: 20
    timeoutMs: 3600000
  graph:
    start: implement
    steps:
      implement:
        expert:
          ref: expert:implementer@1.0.0
        input: { goal: "$flow.input.goal" }
        save: state.implementation
      review:
        expert:
          ref: expert:reviewer@1.0.0
        input: { change: "$state.implementation" }
        save: state.review
      approve:
        human:
          kind: approval
          prompt: "Approve {{ state.review | json }}?"
          options: [approve, revise]
          approveOption: approve
    loops: {}
    transitions:
      implement: review
      review: approve
      approve: { end: true }
```

- Every step declares exactly one of `action`, `expert`, `team`, `flow`, or `human`.
- Every step must be reachable from `start`, and every path must terminate.
- Ordinary edges form a DAG. A back edge requires a named `repeat` transition and a loop with a
  positive `maxIterations` plus an exit path.
- Save only below `state.<name>`; never use reserved or prototype-sensitive segments.
- Action and human steps cannot declare Runtime or Context routing fields.
- Exact values use `$flow.input`, `$node.output`, and `$state.name`; property paths append `.field`.
  String interpolation uses `{{ flow.input.goal }}` and optionally `| json`. `${...}` is invalid.
- Approval steps with custom choices declare `approveOption`; it must match one choice.
- Build Flow resources with the draft tools. Missing nodes or edges are allowed only while a draft
  is incomplete; `prepare_flow_draft` requires a complete, valid graph.
