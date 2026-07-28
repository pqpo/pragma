# Flow run dry cases

Every Flow created or changed by Pragma must include unit-style run dry cases. Run dry executes the
real declarative graph semantics—input and output schemas, node result state, routing, bounded loops,
terminal output, and assertions—without calling a model, waiting for a person, invoking an action, or
starting a nested Flow.

## Case shape

```yaml-fragment
spec:
  runDry:
    cases:
      - id: approved
        name: Approved path
        input: { goal: Prepare a release }
        mocks:
          draft:
            expectInput: "Draft a release for Prepare a release"
            output: { status: ready, text: Release notes }
          decision:
            expectInput: { goal: Prepare a release }
            expectPrompt: "Approve Release notes?"
            output: { selection: approve }
          publish:
            expectInput: { release: Release notes }
            output: { published: true }
        expect:
          status: succeeded
          path: [draft, decision, publish]
          output: { published: true }
```

- `id` is stable and uses the same identifier rules as Flow nodes.
- `input` must satisfy `spec.input.schema`.
- `mocks` is keyed by Flow node ID. Every visited node needs a mock with the exact `expectInput`
  that production would pass to that node. This asserts prompt rendering and input mapping instead
  of testing only the route chosen by a fabricated output.
- Use `{ expectInput: ..., output: ... }` for a successful model, Team, nested Flow, action, or
  Human Task result. Use `{ expectInput: ..., error: "..." }` to test an expected node failure.
- A node visited more than once needs an ordered mock list. The first item is visit 1:

```yaml-fragment
mocks:
  evaluate:
    - { expectInput: "Evaluate v1", output: { status: revise } }
    - { expectInput: "Evaluate v2", output: { status: accepted } }
```

- Human Task mocks additionally require the rendered `expectPrompt`. They return the same stable
  values as production: `{ output: { selection: approve } }` for single selection or
  `{ output: { selection: [security, docs] } }` for multiple selection.
- Structured Expert or Team mock output must satisfy that step's `output.schema`.
- `expect.status` is `succeeded` or `failed`.
- `expect.path` is the exact ordered node path, including repeated visits.
- Add `expect.output` when the final value matters. It is compared structurally.
- For an expected failure, `errorContains` is required so a different failure cannot satisfy the
  case accidentally. An input-validation case may use an empty `expect.path`.
- Missing mocks, wrong `expectInput`, and missing or wrong Human Task `expectPrompt` are test
  configuration errors. They always fail the case, even if its expected status is `failed`.

## Coverage rule

The whole suite must cover every declared transition outcome:

- every ordinary or repeat transition;
- every `route.cases` entry;
- every array-route branch;
- every declared fallback;
- loop repeat and exit paths through the cases that select them;
- the loop limit outcome, including its `onLimit` target or default failure.

One case rarely covers a branching Flow. Add the smallest independent case for each outcome, run
`run_flow_draft_dry`, and use `coverage.missing` as the exact backlog. Do not add unreachable or
meaningless mocks merely to silence coverage: repair the graph or write a realistic input/output
scenario.

## Required authoring sequence

1. Finish the graph and contracts.
2. Add `set_run_dry` with all current cases.
3. Call `run_flow_draft_dry`.
4. Fix failed status, path, output, schema, mock, and coverage results.
5. Call `validate_flow_draft`.
6. Call `prepare_flow_draft` only after the suite-level `passed` value is `true`.

Never report a Flow as created successfully before its prepared change-set has passed run dry and
been committed.
