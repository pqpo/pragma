# Runtime Usage Accounting

Runtime adapters must treat model usage emitted during a single runtime turn as a final snapshot, not as a token delta, unless the upstream runtime explicitly documents an event as incremental.

## Rule

- Single turn usage is the latest final usage snapshot for that turn.
- Do not sum multiple usage-bearing events from the same Claude Code or Codex turn.
- Runtime driver retry attempts are separate turns; the driver may add usage across attempts.
- Session fallback readers should prefer per-turn usage over thread/session cumulative usage.

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
