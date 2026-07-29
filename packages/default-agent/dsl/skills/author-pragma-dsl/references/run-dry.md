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

1. Allocate IDs for both the Flow and its Evaluation in one `allocate_dsl_resource_ids` call.
2. Create the Flow draft with the allocated Flow ID in `metadata.id`.
3. Finish and validate the Flow graph.
4. Call `create_evaluation_draft` in `create` mode with the allocated Evaluation metadata, exact
   Flow ref, and `targetFlowDraftId`.
5. Choose one uncovered path. Call `update_evaluation_draft` with one `upsert_case`, then call
   `run_evaluation_draft` with only that case ID.
6. If the case fails, read only that case, replace it, and rerun it. Do not author the next case
   until it passes.
7. Repeat from cumulative `coverage.missing` until it is empty. If the user explicitly requests
   batch authoring, use 2–10 `upsert_case` operations and run those same 2–10 IDs; resolve all
   failures in that batch before continuing.
8. Call `prepare_flow_draft` with the Flow and Evaluation draft IDs and exact draft revisions. The
   Host reruns every case and rejects any assertion or coverage failure.
9. Commit the returned change-set so Flow and Evaluation are created atomically.

For an existing Evaluation, call `create_evaluation_draft` in `edit` mode with its exact ref. Link
the corresponding Flow draft when testing uncommitted Flow changes. Use
`prepare_evaluation_draft` only when changing an Evaluation against an already committed Flow.
Never report success until the committed revision includes the canonical `evaluation:<id>` ref.

Never build, resend, or request the complete Evaluation YAML during conversational authoring.
`get_evaluation_draft` returns summaries by default; request at most 10 exact case IDs only when
their full definitions are needed.

When abandoning a linked Flow and Evaluation draft pair, call `discard_evaluation_draft` before
`discard_flow_draft`. Do not leave an Evaluation draft pointing to a discarded Flow draft.
