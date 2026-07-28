# ADR 025: Host-owned token usage accounting

- Status: Accepted
- Date: 2026-07-27

## Context

Pragma already records `AgentMessageUsage` on Invocation and Execution state so an interrupted
execution can recover consistently. Those snapshots are scoped to execution recovery and are
deleted with their owner. Product-level usage reporting has different requirements: it spans
Missions, must survive Mission deletion, and needs attribution by Expert, ExpertTeam, and Flow.

Core must remain independent of a database or application-specific retention policy. The first
product version reports token quantities only; monetary cost is deliberately excluded.

## Decision

Core exposes an optional `UsageSink`. It emits one idempotent observation after every Runtime turn
settles. An observation identifies the Execution, Invocation, Runtime Context, Runtime run,
Runtime/model selection, executing Expert, timestamp, and `AgentMessageUsage`. Core continues to
persist Invocation and Execution usage snapshots for recovery, but does not persist or query an
analytics ledger. Sink failures are logged and never change the execution outcome.

Pragma Desktop owns the analytics ledger at:

```text
~/.pragma/data/usage/usage.sqlite
```

The v1 ledger stores token counts, stable identifiers, timestamps, model/runtime identifiers, and
display names. It does not store prompts, model output, workspace paths, secrets, or cost.

Attribution rules are:

- A Mission receives all observations produced by its executions.
- An Expert receives observations for turns it executes directly.
- An ExpertTeam and Flow receive inclusive observations from matching current or ancestor
  Invocations.
- An observation is counted once in the global total even though dimension totals may overlap.

The ledger records its activation timestamp when first created. It does not backfill older
Executions. On startup, Desktop reconciles only terminal Executions created after activation:
persisted Invocation totals are compared with already recorded observations and only a positive
token delta is added. This closes the crash window between Core snapshot persistence and Host
ledger insertion.

Mission deletion keeps observations, replaces the retained Mission display name with
`Deleted Mission`, and marks the subject deleted. Existing Core-owned Execution state continues to
follow the normal Mission deletion lifecycle.

## User interface

Desktop provides a top-level Usage page with:

- a 7-day, 30-day, or all-time filter;
- total, input, output, cache-read, and cache-write token counts;
- one daily trend chart;
- ranked Mission, Expert, ExpertTeam, and Flow views.

Mission chat shows a small cumulative token total below the composer. Context-window occupancy
remains a separate Runtime/session concept.

## Consequences

- Other Hosts can provide a different `UsageSink` and storage policy without changing Core.
- Turn observations support retry and model/runtime-level analysis without storing conversation
  content.
- Inclusive Team and Flow numbers are intentionally non-additive across dimensions.
- Cost can be added later as a separate product and governance decision without migrating the v1
  token-only contract.
