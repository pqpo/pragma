# ADR 028: Independent Evaluation resources

## Status

Accepted.

## Context

Flow Run Dry cases were stored in `Flow.spec.runDry`. Editing tests therefore rewrote the Flow,
expanded draft responses, and prevented test suites from having an independent lifecycle. Mock
input semantics also differed by step kind: Expert and Team steps compared a rendered prompt while
Human steps compared the original Flow input.

## Decision

- Add the independent `@pragma/evaluation` package.
- Keep `@pragma/evaluation/ast` browser-safe; keep its runner Node-only.
- Add `kind: Evaluation` to `pragma/v3`. A Run Dry Evaluation targets one Flow by exact ref.
- Remove `Flow.spec.runDry` and the `set_run_dry` Flow draft operation.
- Make Interpreter depend on Evaluation contracts and adapt validated Flow semantics into the
  Evaluation runner. Evaluation must not depend on Interpreter.
- Define `expectInput` as the case's original Flow input for every step kind.
- Define `expectPrompt` as the rendered prompt for Expert, Team, and Human steps.
- Author Run Dry cases through a durable, independent Evaluation draft. Default to adding and
  testing one case at a time; explicit batch operations are bounded to 10 cases.
- Prepare and commit a Flow independently. After the commit, the authoring Agent asks whether to
  create and run a test set; the user may skip.
- Evaluation drafts target committed Flows only. Save one independently through
  `prepare_evaluation_draft` followed by `commit_dsl_changes`; the Host reruns the complete suite
  and rejects assertion or coverage gaps.
- Expose Evaluation as a top-level Desktop Studio section. Reserve Dataset + LLM-as-Judge there
  without implementing it in this change.

## Consequences

Flow drafts validate only Flow structure and data contracts and have no Evaluation prerequisite.
Evaluation edits no longer rewrite the Flow. Target references participate in project dependency
checks, so a Flow cannot be deleted while an Evaluation targets it. Existing `spec.runDry`
documents are intentionally rejected; this is a breaking `pragma/v3` cleanup with no compatibility
branch.
