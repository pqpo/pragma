# Flow Run Dry evaluations

Store every Run Dry suite as an independent `Evaluation` resource. Never add `spec.runDry` to a
Flow. An Evaluation targets one Flow by exact ref and can be changed, versioned, or reused without
rewriting the Flow.

## Case operation shape

```text
type: upsert_case
case:
  id: approved
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
limit. `run_evaluation_draft` reruns the complete draft internally even when it returns details for
only the requested cases. Use its cumulative `coverage.missing` as the exact backlog.

## Incremental sequence

This workflow starts only after the target Flow has been committed. Creating or changing a Flow
never creates an Evaluation implicitly.

1. Read the existing committed Flow. For a new test set, allocate one Evaluation ID, then call
   `create_evaluation_draft` in `create` mode with that metadata and the exact committed Flow ref.
   To change an existing test set, call it in `edit` mode with the exact Evaluation ref.
2. Choose one uncovered path. Call `update_evaluation_draft` with one `upsert_case`, then call
   `run_evaluation_draft` with only that case ID.
3. If the case fails, read only that case, replace it, and rerun it. Do not author the next case
   until it passes.
4. Repeat from cumulative `coverage.missing` until it is empty. If the user explicitly requests
   batch authoring, use 2–10 `upsert_case` operations and run those same 2–10 IDs; resolve all
   failures in that batch before continuing.
5. Call `prepare_evaluation_draft` with the Evaluation draft ID and exact draft revision. The Host
   reruns every case and rejects assertion or coverage gaps.
6. Pass the returned `changeSetId` to `commit_dsl_changes`. This is the submit-and-save operation
   for the test set and commits only the canonical `evaluation:<id>` resource.

Never put Evaluation YAML in `prepare_flow_draft.additionalSources`. Never create a test set against
an uncommitted Flow draft. Never report test-set success until `commit_dsl_changes` returns a
committed revision containing the canonical Evaluation ref.

Never build, resend, or request the complete Evaluation YAML during conversational authoring.
`get_evaluation_draft` returns summaries by default; request at most 10 exact case IDs only when
their full definitions are needed.
