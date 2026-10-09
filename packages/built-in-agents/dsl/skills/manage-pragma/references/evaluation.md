# Author Pragma Evaluation

An Evaluation is an independent resource targeting an exact committed Flow ref. Use the authorized
`pragma` CLI provided by the current Runtime; it inherits the Mission/Context/Execution and approvals.
Do not create a test set implicitly after Flow authoring. If not already requested, ask whether the
user wants tests after the Flow commit. Never pass complete Evaluation YAML or edit Project storage.

Read [Run Dry cases](evaluation/run-dry.md) before authoring mocks/assertions. Use command `--help`
for current input fields. Pass cases/operations as bounded JSON with `--input request.json` or stdin
`--input -`; read results in bounded pages or exact case selections.

1. Read the committed Flow with `pragma manage dsl resources read`. Allocate an Evaluation ID with
   `pragma manage dsl ids allocate` for a new test set, then use `pragma manage evaluation draft create` in create
   mode; existing tests use edit mode and the exact Evaluation ref.
2. Default to one `upsert_case` through `pragma manage evaluation draft update`, followed immediately by
   `pragma manage evaluation draft run` for that case ID. Fix failures before adding the next case.
   Use cumulative `coverage.missing` as the backlog. Only when the user explicitly requests batches,
   update/read/run 2–10 cases per call and fix all failures in the current batch before adding more.
3. `pragma manage evaluation draft get` returns metadata and paged case summaries;
   `pragma manage evaluation draft cases` returns 1–10 exact full cases. Run reruns the whole suite internally,
   returning requested details and cumulative coverage. Exit 10 with `suite.passed: false` is a valid
   failed-test result, not a transport error; retain its diagnostics.
4. Update with the exact draft revision. After a Project conflict, read the current target and
   explicitly rebase using the existing typed operation. `pragma manage evaluation draft prepare` requires
   the exact draft revision and independently reruns the complete suite; resolve failures/gaps.
5. Commit its returned `changeSetId` with `pragma manage dsl changes commit`. Host publication approval is
   separate from shell approval. This transaction saves only the Evaluation; never combine it with
   Flow prepare or `additionalSources`. Report the actual committed revision and canonical ref.
6. Use `pragma manage evaluation draft discard` for cleanup. Legacy unowned drafts require approved
   `pragma manage evaluation draft recover`; prepared changes use `pragma manage dsl changes recover`. Known
   foreign owners are refused, recovery preserves original data, and commit needs separate approval.

Use stable request UUIDs only for identical retries. Cancellation cannot undo a published revision;
retrieve the original receipt. `input_required` hands control to the current Execution, never a CLI
TTY approval. Missing/revoked endpoints must be diagnosed; do not fall back to broader Host authority.
For creating/changing the target Flow, read [Flow](flow.md) first.
