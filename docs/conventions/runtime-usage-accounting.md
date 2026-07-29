# Runtime Usage Accounting

Runtime adapters must treat model usage emitted during a single runtime turn as a final snapshot, not as a token delta, unless the upstream runtime explicitly documents an event as incremental.

## Rule

- Single turn usage is the latest final usage snapshot for that turn.
- Do not sum multiple usage-bearing events from the same Claude Code or Codex turn.
- Runtime driver retry attempts are separate turns; the driver may add usage across attempts.
- Session fallback readers should prefer per-turn usage over thread/session cumulative usage.
- Every usage value declares whether it is `reported`, `derived`, `estimated`, or legacy `unknown`.
  Aggregation retains the least precise measurement.

## Claude Code

Verified against `claude 2.1.195` using:

```bash
claude -p --output-format stream-json --input-format stream-json --verbose
```

Claude Code stdout can emit usage on intermediate `assistant` events and then on the final `result` event. These usage objects are snapshots. The final `result.usage` matches the final local transcript usage stored under:

```text
CLAUDE_CONFIG_DIR/projects/**/<sessionId>.jsonl
```

Therefore the Claude Code adapter should keep the latest usage snapshot. It must not add intermediate assistant usage to final result usage.

Claude/Anthropic reports uncached input, cache reads, and cache writes as separate token categories:

- `input_tokens` is uncached input and must not have `cache_read_input_tokens` subtracted from it.
- Total tokens are `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`.

## Codex

Verified against `codex-cli 0.142.5` using:

```bash
codex app-server --listen stdio://
```

Codex emits usage via `thread/tokenUsage/updated.params.tokenUsage`. The same values are written to local session jsonl under:

```text
CODEX_HOME/sessions/YYYY/MM/DD/*.jsonl
```

The semantics are:

- RPC `tokenUsage.last` matches jsonl `last_token_usage`.
- RPC `tokenUsage.total` matches jsonl `total_token_usage`.
- `last` / `last_token_usage` is the current turn.
- `total` / `total_token_usage` is cumulative for the runtime thread.

Therefore the Codex adapter should prefer `last` / `last_token_usage` for a Pragma run. It should use `total` only when no per-turn usage is available.

Codex reports cached input as a subset of `input_tokens`. The adapter must subtract `cached_input_tokens` when mapping the mutually exclusive Pragma `input` and `cacheRead` categories.

## Qoder CLI

Verified against `@qoder-ai/qoder-agent-sdk 1.0.15`. The final `SDKResultMessage.usage` is the
current query snapshot and reports uncached input, cache reads, cache creation, and output as
separate categories. The adapter maps a non-zero snapshot as `reported` and must not add
`modelUsage` or account quota data to the same turn.

Some Qoder CLI model providers return an all-zero final usage snapshot even though the model
completed the request. In that case only, the adapter estimates the managed turn input and output
with its deterministic token estimator and marks the snapshot as `estimated`. This fallback does
not use context-window occupancy as cumulative Mission usage.

`Query.getUsageInfo()` is an account credit/quota snapshot. It is diagnostic account state, not
per-turn token usage or dollar cost.

## Context-window occupancy

Context-window occupancy is a separate runtime concern from billing usage. It is always scoped to
the root Runtime Context displayed by Desktop and must never be derived by summing the Mission,
ExpertSession, or delegated-agent usage totals.

- PI uses `AgentSession.getContextUsage()` and marks the value as `estimated`. Its model
  `contextWindow` is the percentage denominator.
- Codex uses root-thread `thread/tokenUsage/updated.params.tokenUsage.last`, subtracting
  `reasoningOutputTokens` from `totalTokens` to match Codex's active-context calculation, with
  `modelContextWindow` as the denominator. `tokenUsage.total` is cumulative billing usage and must
  never be used as context-window occupancy. Codex measurements are marked as `reported`.
- Claude Code uses the most recent root assistant-message usage with the matching
  `result.modelUsage[model].contextWindow` denominator and marks the value as `derived`.
- Qoder CLI uses `Query.getContextUsage()` and marks its current-session numerator and denominator
  as `reported`. If that control request is unavailable, the adapter estimates the active managed
  prompt and message state with a deterministic ASCII/non-ASCII heuristic and marks the result as
  `estimated`; the fallback is an occupancy signal, not a billing-grade token count.
- Immediately after compaction, a runtime may know the denominator while the new numerator is not
  yet available. In that case `usedTokens` and `percent` are `null`; callers must not substitute
  cumulative billing usage.

The latest observation is persisted in the owned Runtime Session record so Desktop can display it
after restart. Manual compaction is allowed only while the owning root Runtime Context is idle.
