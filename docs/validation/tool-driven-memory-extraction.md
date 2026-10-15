# Tool-driven Memory extraction validation

Date: 2026-10-15

## Automated evidence

Focused tests cover the Memory extraction session, Semantic/Episodic modules, extraction settings, built-in DSL compilation, Local Host Execution/Feed integration and Desktop Curator Mission adapter.

- A valid 28,000-character Chinese message is read completely through responses bounded to 2,000 tokens; initial task text stays within 1,500 tokens.
- Invalid subjects, unread/invented evidence, stale replacements and incomplete Episode parts are rejected in the same session.
- Repeated candidate submission and completion are idempotent. Completed receipts reopen from SQLite; another watermark cannot reuse them.
- An expired running job with a durable receipt materializes its Fact without another extractor admission or incrementing model attempts. Unknown outcomes continue to park for inspection.
- Private/expired facts do not enter another Expert's input, and equivalent observations do not widen private bindings.
- A real persisted toolResult traverses Execution → Canonical Feed → Evidence adapter → module-specific filtering → extraction read tool. Its text is redacted; the non-authorized Module and disabled setting cannot read it.
- Source deletion removes transient snapshots. Future state versions are rejected.

## Real Runtime evidence

A temporary harness outside the repository used the installed Codex Runtime (`codex-local`) with its native CLI profile. It compiled the static Memory Curator DSL with the actual Host tool capability, ran through Core ExpertSession and the Execution MCP gateway, and used the actual Memory Modules for materialization. All state and synthetic source text were isolated under a temporary Pragma home and removed after completion.

Semantic source: a user explicitly prefers Simplified Chinese and conclusion-first answers.

- Calls: `list_evidence`, `find_existing_memory`, two `read_evidence`, `finish_extraction`, two `submit_fact`, `finish_extraction`.
- The first completion failed validation because no facts had been staged. The model submitted candidates and completed in the same native execution.
- Result: **2 persisted Facts**, extraction job **completed**, durable receipt present.

Episodic source: a completed CSV encoding repair, including an unsuccessful first attempt and a successful UTF-8 BOM fix.

- Calls: evidence listing/reading, previous-memory lookup, individual Episode part submission and completion.
- An incomplete submission was corrected through another part submission and completion in the same native execution.
- Result: **1 persisted Episode**, extraction job **completed**, durable receipt present.

This verifies actual tool dispatch, same-execution correction, receipt persistence and Module writes with one installed Runtime. It is not an evaluation of extraction quality across other models or Runtimes.

## Code review follow-up

The subsequent code review confirmed and fixed budget finalization, previous-Episode pagination,
credential redaction, settings-failure replay, live tool-content consent and receipt scope checks,
undelivered Fact handles, and aggregate Episode citation validation. Each has a targeted regression.
See [the review record](./tool-driven-memory-extraction-review.md).

The extra migration test run originally reproduced three failures on unmodified HEAD. The review
also fixed those test defects: stale final-version assertions and incomplete synthetic schemas were
replaced with dumps emitted by the real historical Store writers at `ae0003f8` and `6aeca6e8`.
The existing production migration chain was unchanged. All ten tests in
`test/memory-job-v3-migration.test.ts` now pass.
