# Flow Run Dry evaluations

Store every Run Dry suite as an independent `Evaluation` resource. Never add `spec.runDry` to a
Flow. An Evaluation targets one Flow by exact ref and can be changed, versioned, or reused without
rewriting the Flow.

## Resource shape

```yaml
apiVersion: pragma/v3
kind: Evaluation
metadata:
  id: 7h8j9k0m1n2p3q4r
  name: Release approval Run Dry
  description: Covers the approval and rejection paths.
  tags: [run-dry, release]
spec:
  target:
    ref: flow:8h9j0k1m2n3p4q5r
  method:
    type: flow-run-dry
    cases:
      - id: approved
        name: Approved path
        input: { goal: Prepare a release }
        mocks:
          draft:
            expectInput: { goal: Prepare a release }
            expectPrompt: "Draft a release for Prepare a release"
            output: { status: ready, text: Release notes }
          decision:
            expectInput: { goal: Prepare a release }
            expectPrompt: "Approve Release notes?"
            output: { selection: approve }
          publish:
            expectInput: { goal: Prepare a release }
            output: { published: true }
        expect:
          status: succeeded
          path: [draft, decision, publish]
          output: { published: true }
```

## Mock semantics

- `expectInput` always equals the case's original `input`, for every step kind. Do not put a
  rendered prompt or mapped node input in `expectInput`.
- `expectPrompt` equals the fully rendered prompt. It is required for Expert, ExpertTeam, and Human
  steps and forbidden for steps with no prompt.
- A successful outcome declares `output`; an expected node failure declares `error`.
- A repeated node uses an ordered mock array. Every array item repeats the same case-level
  `expectInput` and declares the prompt rendered for that visit.
- Human output uses stable option values: `{ selection: approve }` or
  `{ selection: [security, docs] }`.
- Structured Expert or Team output must satisfy the step's `output.schema`.
- Failed cases require `expect.errorContains`. Input validation may expect an empty path.
- Treat a configuration assertion as a broken Evaluation, even when the case expects failure.
  Mismatch diagnostics include both expected and actual values; use them directly.

## Coverage

Cover every ordinary transition, route case, array branch, fallback, repeat, loop exit, and loop
limit. Use `coverage.missing` from `run_evaluation` as the exact backlog.

## New Flow sequence

1. Allocate IDs for both the Flow and its Evaluation in one `allocate_dsl_resource_ids` call.
2. Create the Flow draft with the allocated Flow ID in `metadata.id`.
3. Finish and validate the Flow graph.
4. Author the Evaluation YAML with the allocated Evaluation ID and the draft Flow ref.
5. Call `run_evaluation` with `source` and `flowDraftId`.
6. Fix every assertion and coverage gap.
7. Call `prepare_flow_draft` with the Evaluation YAML in `additionalSources`.
8. Commit the returned change-set so Flow and Evaluation are created atomically.

For an existing Flow, call `run_evaluation` with only the complete Evaluation `source`, then use
`prepare_dsl_changes` and `commit_dsl_changes`. Never report success until the Evaluation passes and
the committed revision includes its canonical `evaluation:<id>` ref.
