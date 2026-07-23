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
        prompt:
          segments:
            - { text: "Implement this goal: " }
            - { variable: { source: flow-input, path: [goal] } }
        output:
          schema:
            type: object
            properties:
              summary: { type: string, description: "Summary of the implementation." }
            required: [summary]
            additionalProperties: false
      review:
        expert:
          ref: expert:reviewer@1.0.0
        prompt:
          segments:
            - { text: "Review this implementation: " }
            - variable:
                source: node-output
                nodeId: implement
                path: [summary]
      approve:
        human:
          kind: approval
          prompt: "Approve the review result?"
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
- Every successful result is stored automatically at `state.nodes.<nodeId>.result`.
- Action and human steps cannot declare Runtime or Context routing fields.
- Expert and Team prompts use text and typed variable segments. Node variables reference a stable
  `nodeId`; native output exposes only `result`, while structured output exposes declared fields.
- Structured output uses the bounded object schema supported by the Desktop field editor.
- Approval steps with custom choices declare `approveOption`; it must match one choice.
- Build Flow resources with the draft tools. Missing nodes or edges are allowed only while a draft
  is incomplete; `prepare_flow_draft` requires a complete, valid graph.
