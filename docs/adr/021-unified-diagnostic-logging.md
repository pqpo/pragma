# ADR 021: Unified Diagnostic Logging

## Status

Proposed.

## Context

Pragma currently has four observability mechanisms with different purposes:

- Core exposes `ExpertAgentLogger`, but its component set is narrow and the default provider is a
  no-op.
- Execution owns a durable Canonical Event Log for replayable orchestration facts.
- Interpreter returns DSL diagnostics for source and environment validation.
- Desktop, including startup and Mission observation paths, still writes directly to `console.*`.

As a result, an Execution failure can be visible in durable state without retaining the stack,
Runtime failure context, or the Desktop operation that caused it. Conversely, treating every
Execution event or DSL validation result as a log would create duplicate sources of truth and make
normal user mistakes look like product failures.

The primary goal of logging is local troubleshooting. It must cover Desktop main/preload/renderer,
Interpreter load/validate/compile, Core Execution and Expert lifecycle, concrete Runtime Adapters,
plugins, managed tools, and delegated Expert Invocations.

## Decision

### 1. Keep business facts, diagnostics, and live output separate

Pragma has four distinct records:

| Record          | Purpose                                                 | Durable source of truth       |
| --------------- | ------------------------------------------------------- | ----------------------------- |
| Execution event | Replayable orchestration fact                           | Execution Canonical Event Log |
| DSL diagnostic  | Actionable source or environment validation result      | Interpreter result            |
| Runtime output  | Active token, thought, tool, progress, and agent output | Live bus only                 |
| Diagnostic log  | Operational troubleshooting evidence                    | Bounded diagnostic archive    |

Diagnostic logs never drive recovery, Mission projection, Invocation state, billing, or user-visible
business state. A failure still commits its safe semantic summary to Execution state and events.
The diagnostic record supplies implementation detail and is linked by `diagnosticId`.

### 2. Separate normal operational logs from failure logs

The logging protocol has two streams:

- `operation`: `debug`, `info`, and `warn` records describing normal lifecycle, decisions, latency,
  recoverable degradation, and expected rejection.
- `failure`: `error` and `fatal` records containing a normalized error and describing an operation
  that could not complete.

The stream is derived from the logging method and level; callers cannot label an `error` as a normal
operation. Desktop stores the streams in separate JSONL files. A query may merge them by
`occurredAt`, `bootId`, and `sequence` to reconstruct a timeline.

`warn` does not mean failure. Invalid DSL, unavailable optional capability, denied permission,
cancellation, and an optimistic revision conflict are expected outcomes unless they prevent the
owning operation from completing unexpectedly. They remain normal diagnostics and do not pollute
the failure log.

### 3. Use one versioned structured record

The cross-process record is a Zod schema owned by `@pragma/shared`. Every record contains:

- schema version, unique record id, timestamp, per-process sequence, boot id, process kind, and
  level;
- a stable machine-readable event name and a human-readable message;
- a hierarchical component name;
- explicit correlation fields such as Mission, Execution, Invocation, Context, Agent, Runtime,
  Runtime Session, run, request, and operation ids;
- bounded JSON-safe attributes;
- for `failure` records, a shared diagnostic id plus a normalized error with code, name, message,
  stack, cause chain, classification, and retryability.

Component and event names are open namespaced strings, not closed enums. Examples are
`desktop.main`, `interpreter.compiler`, `core.execution`, `core.runtime`,
`runtime.codex`, and `plugin.repo-manager`.

### 4. Propagate correlation explicitly

The Desktop composition root creates one provider for a process boot and injects it into
Interpreter, `createPragma()`, Expert definitions, Core managers, Runtime Adapters, plugins, and
managed tools. A child logger can only add or narrow scope; it does not mutate a global context.

Core may use `AsyncLocalStorage` as a convenience inside one asynchronous operation, but durable
identity is always passed explicitly. Recovery reconstructs logging scope from persisted Session,
Execution, Invocation, Context, and Runtime records and does not depend on an in-memory trace.

The minimum useful correlation chain is:

```text
missionId
→ executionId
→ invocationId
→ contextId
→ agentId
→ systemSessionId / runtimeId / runId
```

Non-Mission work, such as startup or project publication, uses a generated `operationId` and
optional `parentOperationId`.

### 5. Log once at an ownership boundary

Code must not log an error at every `catch` and then rethrow it. Intermediate layers add a typed
error code or safe context and rethrow. The layer that converts the failure into a final operation
outcome logs it once:

- Desktop logs process, IPC, window, automation, and Mission observation failures.
- Interpreter logs unexpected load/compile infrastructure failures; expected DSL diagnostics stay
  in the returned diagnostic set.
- Core logs terminal Execution/Invocation, persistence, orchestration, managed-tool, and Runtime
  lifecycle failures.
- A concrete Runtime Adapter logs native process/protocol failures that it owns; Core does not log
  the same native error again unless Core itself also fails to finalize the operation.

When the same root error must be recorded at two boundaries, both records carry the same
`diagnosticId` and a distinct event name.

### 6. Store bounded local diagnostic archives

Desktop writes under:

```text
~/.pragma/archives/diagnostics/desktop/<yyyy-mm-dd>/<bootId>/
  operations-0001.jsonl
  errors-0001.jsonl
```

Files rotate by size, are never overwritten, use directory mode `0700` and file mode `0600`, and
are compressed after a clean close or a later maintenance pass. The archive is diagnostic,
non-authoritative data governed by `StoragePolicy`.

The initial policy is:

- rotate at 10 MiB per JSONL file;
- retain operation logs for 14 days;
- retain failure logs for 30 days;
- cap combined diagnostic archives at 256 MiB;
- under pressure, delete the oldest operation archives before failure archives;
- cap one serialized record at 64 KiB, one stack at 32 KiB, and cause depth at 5.

The writer uses one bounded asynchronous queue. `error` and `fatal` have priority. If the file sink
fails, it emits one emergency line to stderr without recursively invoking the logger. `fatal`
handling flushes with a short deadline and then preserves the existing process termination policy.

Runtime-native logs remain in the Runtime Context's private overlay as required by ADR 016. Unified
records contain safe metadata and an owner-scoped `nativeLogRef`, not copied stdout/stderr. Raw
native logs are included in a support bundle only with explicit user consent.

### 7. Redact and bound before dispatch

Redaction occurs once before a record reaches any sink. Default logs must not contain:

- prompts, model responses, tool arguments or results, source file contents, or clipboard data;
- credentials, authorization headers, cookies, tokens, secrets, private keys, or environment
  variable values;
- complete HTTP request/response bodies;
- unbounded Runtime stdout/stderr.

Safe metadata includes stable ids, status, counts, durations, byte sizes, model/runtime identifiers,
exit codes, signals, schema versions, content hashes, and approved relative paths. Suspicious key
names are replaced with `[REDACTED]`; values, arrays, strings, causes, and stacks are depth- and
size-bounded. Local archives are private but are not treated as encrypted secret storage.

### 8. Keep the library default side-effect free

`@pragma/core` keeps a no-op default provider for embedded library use and tests. Executable
composition roots must explicitly select a provider:

- Desktop uses rotating local JSONL plus development console output.
- Worker uses structured stdout until a deployment sink is configured.
- Server adapts the Fastify/Pino logger instead of creating a competing process logger.
- Tests use an in-memory sink.

Future OTLP or remote ingestion is another sink. It does not change the logging protocol or permit
shipping raw local content by default.

## Consequences

- A Mission failure can be traced across Desktop, Interpreter, Core, Runtime, and delegated Experts
  using explicit ids without making logs part of recovery state.
- Normal validation and user-control outcomes do not overwhelm the error log.
- Execution archives and diagnostic archives remain independent and can expire independently.
- Logger provider injection must be added to `createPragma()`, Interpreter compile hosts, and
  Desktop composition. Existing `console.*` calls must be removed from production paths.
- Existing repeated `serializeError()` helpers should be replaced by one normalizer. Formalizing a
  safe failure summary in persisted Execution schemas requires a normal ADR 019 migration; this ADR
  does not authorize an unpaired schema-version bump.
- The file sink, rotation, retention, renderer reporting, and support-bundle flow add implementation
  work, but they remain infrastructure concerns rather than a new business-state subsystem.

Detailed record shape, event catalog, integration points, and rollout gates are defined in
`docs/architecture/diagnostic-logging.md`.
