# ADR 007: Execution Canonical Event Log

## Status

Accepted.

## Decision

Each Execution owns one canonical, append-only event log. `{ executionId, sequence }` is the only
durable replay cursor and `sequence` is strictly monotonic within that Execution.

Concrete Runtimes continue to normalize native output into `ExpertAgentStreamEvent`. Core publishes
token, thinking, and tool deltas as future-only `ExecutionOutputItem` values. These high-volume live
deltas are not durable and do not receive an Execution cursor.

Core persists completed normalized `AgentMessage` values as `invocation.message.appended` events,
along with Invocation lifecycle, delegation, human-interaction, and other orchestration facts.
These semantic events share the Execution's monotonic cursor and form the only canonical log.
There is no second parsed-output store and live token output cannot be replayed.

Execution state, Invocation changes, and newly appended events may be submitted through one
idempotent `ExecutionStore.commit()` operation. File storage uses a recoverable transaction journal;
future server storage must provide equivalent database transaction, unique-event, and optimistic
version semantics.

Commit values must be JSON-safe because Execution state and events are cross-process durable
protocols. Once an Execution or Invocation reaches `succeeded`, `failed`, or `cancelled`, a later
commit may enrich that final state but cannot replace it with a different status.

## Consequences

- Audit and recovery consumers share one semantic event cursor; live transports consume a separate
  future-only output subscription.
- Repeated producer events are deduplicated by stable event id.
- Concurrent finalizers cannot overwrite an already finalized Execution or Invocation.
- `getMessageHistory()` can preserve thinking, tool calls, tool results, and provider signatures
  without retaining token deltas.
- File storage remains a local reference adapter; production storage should materialize indexed
  Output and Trace projections where necessary.
- Earlier Execution schemas, persisted `runtime.stream` events, independently persisted Output
  events, and their compatibility paths are not supported or migrated.
