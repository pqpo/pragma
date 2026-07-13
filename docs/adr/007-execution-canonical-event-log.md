# ADR 007: Execution Canonical Event Log

## Status

Accepted.

## Decision

Each Execution owns one canonical, append-only event log. `{ executionId, sequence }` is the only
durable replay cursor and `sequence` is strictly monotonic within that Execution.

Concrete Runtimes continue to normalize native output into `ExpertAgentStreamEvent`. Core persists
the complete normalized event inside an Execution event with `type: "runtime.stream"`; Runtime
event metadata and its run-local sequence remain available for diagnostics, while the enclosing
Execution sequence defines cross-Invocation order.

Output is a read projection, not an independent event stream. `ExecutionOutputItem` retains the
source event id and cursor. Message, thought, tool, progress, and result output can be rebuilt from
the canonical log, so Core does not persist or sequence a separate Output log.

Execution state, Invocation changes, and newly appended events may be submitted through one
idempotent `ExecutionStore.commit()` operation. File storage uses a recoverable transaction journal;
future server storage must provide equivalent database transaction, unique-event, and optimistic
version semantics.

Commit values must be JSON-safe because Execution state and events are cross-process durable
protocols. Once an Execution or Invocation reaches `succeeded`, `failed`, or `cancelled`, a later
commit may enrich that final state but cannot replace it with a different status.

## Consequences

- Runtime Gateway, SSE, WebSocket, audit, and recovery can share one cursor.
- Repeated producer events are deduplicated by stable event id.
- Concurrent finalizers cannot overwrite an already finalized Execution or Invocation.
- Output projections may contain sequence gaps because non-output facts share the same log.
- File storage remains a local reference adapter; production storage should materialize indexed
  Output and Trace projections where necessary.
- `pragma.execution/v1`, independently persisted Output events, and their compatibility paths are
  not supported or migrated.
