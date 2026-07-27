# Flow resources

Use a Flow for explicit, inspectable control flow.

```yaml
apiVersion: pragma/v3
kind: Flow
metadata:
  id: 8h9j0k1m2n3p4q5r
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
          ref: expert:6h7j8k9m0n1p2q3r
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
          ref: expert:7h8j9k0m1n2p3q4r
        prompt:
          segments:
            - { text: "Review this implementation: " }
            - variable:
                source: node-output
                nodeId: implement
                path: [summary]
      approve:
        human:
          selectionMode: single
          prompt:
            segments:
              - { text: "Approve the review result?" }
          options:
            - { value: approve, label: Approve }
            - { value: revise, label: Revise }
    loops: {}
    transitions:
      implement: review
      review: approve
      approve: { end: true }
  runDry:
    cases:
      - id: approved
        name: Approved review
        input: { goal: Add release validation }
        mocks:
          implement:
            expectInput: "Implement this goal: Add release validation"
            output: { summary: Validation added and tested. }
          review:
            expectInput: "Review this implementation: Validation added and tested."
            output: { result: Review passed. }
          approve:
            expectInput: { goal: Add release validation }
            expectPrompt: "Approve the review result?"
            output: { selection: approve }
        expect:
          status: succeeded
          path: [implement, review, approve]
          output: { selection: approve }
```

- Every step declares exactly one of `action`, `expert`, `team`, `flow`, or `human`.
- Every step must be reachable from `start`, and every path must terminate.
- Ordinary edges form a DAG. A back edge requires a named `repeat` transition and a loop with a
  positive `maxIterations` plus an exit path.
- Every successful result is stored automatically at `state.nodes.<nodeId>.result`.
- Without `spec.output.value`, the Flow returns the output of the node that reaches `end`.
- `spec.output.schema` validates that final result. Add `spec.output.value` only when the Flow must
  assemble a result from Flow input or multiple node results.
- Action and human steps cannot declare Runtime or Context routing fields.
- Expert and Team prompts use text and typed variable segments. Node variables reference a stable
  `nodeId`; native output exposes only `result`, while structured output exposes declared fields.
- Structured output uses the bounded object schema supported by the Desktop field editor.
- Human input steps ask one single- or multiple-selection question. They return
  `{ selection: string }` or `{ selection: string[] }`, using stable option values rather than labels.
- Human prompts use the same typed variable segments as Expert and Team prompts.
- Build Flow resources with the draft tools. Missing nodes or edges are allowed only while a draft
  is incomplete; `prepare_flow_draft` requires a complete, valid graph and a passing run dry suite
  with complete transition coverage.
- Read `references/run-dry.md` before writing cases. A Flow is not successfully created by Pragma
  until `run_flow_draft_dry` passes every assertion and covers every declared transition outcome.
