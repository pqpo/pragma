# Claude Code ACP runtime

Claude Code executes through Core's `defineAcpRuntimeDriver()` and the bundled `claude-agent-acp` 0.81.2 worker. Native Claude CLI resolution and login remain independent of the worker. `acpWorkerPath` is an explicit worker override for development/tests; `executablePath` still selects the native CLI.

Per-turn model and effort overrides restore the configured or native session defaults on the next turn. Claude declares turn-scoped token usage, matching the pinned worker; generic ACP bindings may declare session-scoped snapshots.

The adapter supplies Claude-specific model/effort configuration, system prompt metadata, isolated settings, managed plugin/Skills, HTTP MCP, compaction hooks and Host interaction callbacks. Core owns ACP transport and generic event projection. See [ADR 059](../adr/059-acp-runtime-driver.md).

Active-turn steer requires ACP's advertised steering extension. The driver sends `_session/steering`, requests `promptRequired` when idle and waits at most 1.75 seconds for acknowledgement. Successful steer modifies the original prompt stream. Safe rejection follows Core's existing queue policy; uncertain delivery is surfaced without duplicate submission. ACP cancellation is followed by bounded process termination if the prompt does not settle. Normal close stops the worker while preserving owned native files. Configuration and compaction timeouts retire the connection before another prompt can run; continuing requires restoring the owned session. Host interaction requests inherit the active turn cancellation signal and reject delayed responses from a finished turn.

ACP text and thought chunks are segmented at each new tool call. Core emits a `toolUse` assistant completion before the tool lifecycle event, and the terminal assistant completion contains only the last segment, including any answer produced after steering. The execution result contains only the terminal segment’s text, without thoughts or pre-tool commentary. Token accounting still includes all text and thoughts produced during the turn; the ordered message history preserves those intermediate segments. This keeps live chat and persisted message history aligned without replaying pre-tool content in the final answer.

Desktop verifies a completed root answer against the canonical Execution output rather than trusting `finalAnswer`, which may also mark a rejected model attempt. Text must match exactly; structured JSON must equal the parsed output value. A mismatched or missing answer rebuilds from canonical message history, where Core appends the root terminal message only after the Runtime submission succeeds. Canonical terminal text also prevents a legacy accumulated output from replaying pre-tool content. Root entries from rejected attempts lose their final-answer marker when the successful answer is reconciled.

Mission projection ordering version 4 records this terminal-result interpretation. Versions 1–3 remain readable but bypass the terminal projection fast path when canonical Execution state is available; the targeted read reconstructs the current view from canonical messages and Execution output, preserving the original projection and authoritative files. New projections use version 4. Healthy version-4 text/JSON projections retain bounded reads after archival, and future ordering versions are rejected.

Every dispatched prompt settles unfinished compaction hooks before releasing its active turn, including RPC failures and worker exits. This preserves the previous CLI's failed-compaction events and prevents pending hooks from leaking into a later turn. The worker environment excludes inherited `CLAUDECODE_*` and `CLAUDE_CODE_INTERNAL_*` markers in addition to the explicit nested-session variables.

`session/load` replays history into the session's message view without re-emitting it into a new turn. The persistent Runtime reference, ownership rules, native configuration directory and checkpoint format are unchanged. Old native Claude JSONL sessions are loaded by ID inside their owned configuration root.

Claude Code must be installed by the user. Desktop excludes all SDK-supplied CLI binaries on every target architecture; the worker requires an explicit external CLI and cannot fall back to the SDK executable. Invalid installations produce Claude-specific availability diagnostics without preventing Host composition. See the [packaging audit and regression gate](claude-code-packaging-audit.md).

Both CLI and Desktop include a self-contained worker at build time. Desktop unpacks only `out/main/claude-acp-worker.js` from ASAR so the Electron executable can launch it with `ELECTRON_RUN_AS_NODE=1`; main and its shared chunks retain their packaging policy. CLI tarball auditing covers the worker, its dependency graph and workspace import/path leaks.

Manual compaction succeeds only when both the `/compact` prompt ends normally and the private relay receives proof for the owned native session: a raw SDK `system/compact_boundary` with a manual trigger, or matching manual PreCompact/PostCompact hooks. The pinned worker forwards only result and compact-boundary SDK messages. Native boundary confirmation preserves the removed CLI's check and works with `--bare`, which skips hooks; requiring plugin hooks alone would reject successful native compactions in this mode. Missing, orphaned or unrelated evidence fails within a bounded wait, fails pending hook operations and retires the connection. Core therefore does not checkpoint or rearm startup for a false compaction success. Replayed history is excluded from live compaction confirmation.

The Claude binding negotiates the pinned worker's AIR sessionFailure extension. Terminal structured response/notification diagnostics become errors with stable `code` and `retryable` fields for Core's `run.failed`; retry warnings remain informational. Bounded per-operation stderr is a Claude-side fallback for worker crashes and RPC failures. Core only calls the binding's error mapper and does not parse provider text. Inherited diagnostics from an earlier turn are cleared before the next operation. Custom spawn skips the native binary probe only after the worker file has been verified.

## System prompt and startup messages

The Core-assembled Expert system prompt is passed in `session/new` / `session/load` as `_meta.systemPrompt: { append: systemPrompt }`. The pinned worker maps it to the SDK's `{ type: "preset", preset: "claude_code", append: systemPrompt }`, preserving the Claude Code system preset and the previous CLI `--append-system-prompt` semantics.

Startup messages remain user context. The first prompt's text blocks are `[startup_1, startup_2, ..., current_prompt]`; the worker converts them into one Claude user message in the same order, matching the removed stream-json driver. They do not create independent model turns. Every newly opened Runtime session, including an owned native session restored with `session/load`, sends the latest assembled startup with its first successful prompt. Native history is preserved, but current startup supersedes older reference bodies. Later ordinary prompts on that connection do not repeat startup. Core rearms startup after completed automatic/manual compaction, applies the remaining-context budget and skips reinjection on output-format retries.

ACP allocates its session ID before the first prompt. A `RuntimeTurnNotDispatchedError` lets Core preserve consumed startup context when model selection, attachment preparation or cancellation fails before dispatch, even when that native ID already exists. The message view also records startup messages alongside the user query, matching the previous driver.

Core consumes startup only after attachment planning and turn Feature preparation succeed. A preparation failure therefore preserves both first-delivery and post-compaction reinjection state for the next submission.

The ACP/Core integration suite verifies delivery once, pre-dispatch failure retention, post-compaction reinjection, and restore with updated startup after closing before a pending reinjection. The optional real Claude smoke test independently verifies system and startup markers on the first turn, then recalls both with an empty startup list on the next turn.

Startup delivery/reinjection flags remain process-local by design. Unconditionally bootstrapping restored sessions with current startup recovers a lost pending flag after process exit and refreshes Context bodies together with the current system manifest. No persisted delivery ledger or storage migration is required for this policy. Recovery may append another copy of startup already present in history; exact-once delivery across process crashes is not a requirement. This restore behavior intentionally differs from the removed CLI's skip-on-resume policy. ACP resources could preserve Context provenance in future, but do not by themselves change instruction authority or guarantee compaction retention.

## Validation

The dedicated ACP module suite exercises actual local JSON-RPC subprocesses and mocked Host interactions, without credentials. Fast `test:core` runs contract tests; the subprocess/timeout suite is invoked separately. The historical native fixture records its original writer and sanitization in `test/fixtures/legacy-2.1.195/provenance.json`.

```sh
pnpm --filter @pragma/core exec vitest run test/acp-driver.test.ts
pnpm --filter @pragma/runtime-claude-code test
pnpm build
PRAGMA_CLAUDE_ACP_SMOKE=1 PRAGMA_CLAUDE_ACP_WORKER="$PWD/apps/cli/dist/claude-acp-worker.js" pnpm --filter @pragma/runtime-claude-code exec vitest run test/acp-smoke.test.ts
pnpm runtime:probe claude-code full
pnpm runtime:probe claude-code cancellation
pnpm runtime:probe claude-code compaction
```

On 2026-09-28, macOS and Claude CLI 2.1.195 passed the full real-runtime probe: text delta/completion, native Bash lifecycle, managed MCP tool discovery/execution, Skill invocation, image/file attachments, owned session refresh and steer into the original turn. Active-turn cancellation also passed its separate real-runtime probe. The original single-turn compaction probe only checked marker recall and falsely passed Claude's “Not enough messages to compact” result; the revised probe supplies a longer multi-turn conversation and requires native completion evidence before recalling its marker. The revised compaction probe passed with receipt `Y29tcGFjdGlvbg-99863b2c-6045-4b98-bdac-343f2fd42269.json`. The post-review CLI smoke test also verifies two consecutive prompt token totals against the raw ACP responses. Both bundled CLI and Desktop workers independently loaded the historical stream-json fixture and recalled its marker; the Desktop test also ran the worker through Electron with `ELECTRON_RUN_AS_NODE=1`. The post-review full evidence receipt is `ZnVsbA-ede73af0-b34b-4683-bdcc-2d1353e5184d.json` in the Host runtime-probe archive.

Feature readiness remains `degraded` until the acceptance evidence matrix is complete. Windows packaging and provider-specific model/effort behavior are not established by the macOS run. Host approval edits and forms have deterministic callback tests; they still need broader real-provider acceptance coverage.
