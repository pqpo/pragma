# Diagnostic Logging Architecture

> This document is the implementation design for ADR 021 and the contract for the unified logging
> implementation.

## 1. Goals

The system is optimized for answering these troubleshooting questions:

1. Did Desktop receive and start the user operation?
2. Did Interpreter load, validate, and compile the intended immutable Project revision?
3. Which Execution, Invocation, Context, Agent, Runtime, and native session handled the work?
4. Where did the operation first fail, and was it expected, retryable, or a product defect?
5. Did Core persist the terminal state and release or retain Runtime resources correctly?
6. Can a user export a bounded, redacted support bundle without exposing task content or secrets?

It is not intended to replace Execution events, audit logs, metrics, distributed tracing, or the
Runtime output stream.

## 2. Record taxonomy

### 2.1 Business facts

Business facts change or explain durable state. Examples:

- `invocation.queued`
- `invocation.failed`
- `invocation.message.appended`
- `expert.children.completed`

They remain in the Execution Canonical Event Log. They are stable, replayable, and may be consumed
by projections. A diagnostic log may describe the code path that produced a fact, but consumers
must never reconstruct business state from diagnostics.

### 2.2 Interpreter diagnostics

`PragmaDiagnostic` is a user-facing compiler result. A malformed reference or unavailable declared
capability is often an expected validation result, not a product error.

Interpreter behavior is:

| Outcome                                        | Returned result              | Diagnostic logging                                |
| ---------------------------------------------- | ---------------------------- | ------------------------------------------------- |
| Valid project                                  | Empty or warning diagnostics | One compile/validate completion operation         |
| Invalid source/configuration                   | Error diagnostics            | `warn` operation with counts and diagnostic codes |
| Revision conflict                              | Typed exception              | `warn` operation                                  |
| Unexpected filesystem/adapter/compiler failure | Exception                    | One failure record                                |

Source text and resource bodies are not copied into logs. A safe source-relative path, diagnostic
code, line/column, and content hash may be logged.

### 2.3 Operation diagnostics

Operation records describe expected control flow:

- process/window lifecycle;
- project load/validate/compile duration;
- Execution, Invocation, Runtime Session, and tool lifecycle;
- routing, retry, cancellation, recovery, and cleanup decisions;
- degraded but recovered behavior.

`debug` is development detail, `info` is a meaningful lifecycle transition, and `warn` is an
expected but undesirable outcome or recovered degradation.

### 2.4 Failure diagnostics

Failure records mean the owning operation did not complete as intended. Every failure record has a
normalized error. `error` is an operation failure from which the process can continue. `fatal` means
the process or an essential Desktop surface cannot continue safely.

Cancellation and permission denial are not failures unless the cancellation/denial handler itself
fails.

## 3. Versioned protocol

The target schema is browser-safe and belongs in `@pragma/shared`.

```ts
type DiagnosticLevel = "debug" | "info" | "warn" | "error" | "fatal";
type DiagnosticStream = "operation" | "failure";

interface DiagnosticRecord {
  readonly schemaVersion: "pragma.diagnostic/v1";
  readonly recordId: string;
  readonly diagnosticId?: string;
  readonly occurredAt: string;
  readonly sequence: number;
  readonly bootId: string;
  readonly process: {
    readonly kind: "desktop-main" | "desktop-renderer" | "server" | "worker" | "test" | string;
    readonly pid?: number;
    readonly version?: string;
  };
  readonly stream: DiagnosticStream;
  readonly level: DiagnosticLevel;
  readonly component: string;
  readonly event: string;
  readonly message: string;
  readonly scope: DiagnosticScope;
  readonly attributes?: Readonly<Record<string, JsonValue>>;
  readonly error?: DiagnosticError;
}

interface DiagnosticScope {
  readonly operationId?: string;
  readonly parentOperationId?: string;
  readonly requestId?: string;
  readonly missionId?: string;
  readonly executionId?: string;
  readonly expertSessionId?: string;
  readonly invocationId?: string;
  readonly contextId?: string;
  readonly agentId?: string;
  readonly runId?: string;
  readonly runtimeId?: string;
  readonly systemSessionId?: string;
  readonly runtimeSessionType?: string;
  readonly runtimeSessionId?: string;
  readonly pluginId?: string;
}

interface DiagnosticError {
  readonly code: string;
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly classification:
    | "validation"
    | "permission"
    | "cancelled"
    | "timeout"
    | "conflict"
    | "not-found"
    | "storage"
    | "runtime"
    | "external"
    | "invariant"
    | "unknown";
  readonly retryable: boolean;
  readonly cause?: DiagnosticError;
  readonly errors?: readonly DiagnosticError[];
}
```

Schema invariants:

- `operation` accepts only `debug`, `info`, or `warn` and has no `error`.
- `failure` accepts only `error` or `fatal` and requires both `diagnosticId` and `error`.
- `component` and `event` use lowercase dot-separated names.
- attributes are JSON-safe after normalization.
- `sequence` is monotonic only within one `bootId`; it is not a durable replay cursor.
- `recordId` uniquely identifies one stored record.
- `diagnosticId` identifies one root failure. Related failure records may intentionally share it.

The implementation should use a discriminated Zod union so invalid stream/level/error combinations
cannot be emitted.

## 4. API design

The logger API keeps event identity separate from prose and makes failure normalization mandatory:

```ts
interface PragmaLogger {
  child(scope: DiagnosticScope, component?: string): PragmaLogger;

  debug(event: string, message: string, attributes?: LogAttributes): void;
  info(event: string, message: string, attributes?: LogAttributes): void;
  warn(event: string, message: string, attributes?: LogAttributes): void;

  error(event: string, message: string, error: unknown, attributes?: LogAttributes): string;
  fatal(event: string, message: string, error: unknown, attributes?: LogAttributes): string;
}

interface PragmaLoggerProvider {
  createLogger(input: {
    readonly component: string;
    readonly scope?: DiagnosticScope;
  }): PragmaLogger;
}
```

`error()` and `fatal()` return `diagnosticId`. A terminal Execution/Invocation writer can place that
id in its existing JSON-safe failure summary:

```ts
{
  code: "runtime.turn.failed",
  message: "The Runtime turn failed.",
  diagnosticId: "01J...",
  retryable: true
}
```

Stacks, cause chains, native stderr, and arbitrary exception properties stay out of durable
Execution state.

For common timed operations, Core provides a small helper:

```ts
await runLoggedOperation(
  logger,
  {
    event: "interpreter.project.compile",
    startedMessage: "Project compilation started.",
    completedMessage: "Project compilation completed.",
    attributes: { projectId, revision, resourceRef },
  },
  async (operationLogger) => {
    // ...
  },
);
```

It emits `*.started`, then either `*.completed` with `durationMs`, or `*.failed` once and rethrows.
It must not be wrapped around code whose owner already logs the same failure.

### Error ownership rules

Log at one of these boundaries:

- an external request is converted into a response;
- an asynchronous background task is detached and would otherwise lose its rejection;
- a durable Execution or Invocation is finalized;
- a native Runtime process/protocol operation fails;
- an error is intentionally swallowed, downgraded, or retried;
- the process or renderer crashes.

Do not log when:

- adding context and rethrowing to the same owner;
- returning `PragmaDiagnostic`;
- propagating a cancellation or permission denial normally;
- a lower layer has already logged the same failure and the upper layer only returns its
  `diagnosticId`.

## 5. Correlation model

### 5.1 Desktop Mission

```text
desktop.mission.run (missionId, operationId)
  interpreter.project.compile (projectId/revision/resourceRef)
  core.execution.start (executionId)
    core.invocation.run (invocationId, contextId, agentId)
      core.runtime.session (runtimeId, systemSessionId)
        runtime.<adapter>.turn (runId, runtimeSessionId)
        core.tool.call (toolCallId as attribute)
      core.invocation.finalize
    core.execution.finalize
  desktop.mission.project
```

Every child adds identifiers as soon as they exist. The original `operationId` remains present.
Delegated Experts have their own `invocationId`, `contextId`, and `agentId`, while retaining the same
Mission and Execution.

### 5.2 Recovery

Recovery creates a new `bootId` and `operationId`, then binds the original Mission, Execution,
ExpertSession, Invocation, Context, and Runtime ids read from durable state. The new operation record
contains `recovery: true` and the stored status. It does not reuse an in-memory trace id from the
previous process.

### 5.3 Work without a Mission

Project editing, Capability verification, plugin installation, storage maintenance, and Desktop
startup receive an `operationId`. Nested calls receive `parentOperationId`. They do not invent
Mission or Execution ids.

## 6. Component and event catalog

The initial component namespace is:

| Component prefix        | Ownership                                      |
| ----------------------- | ---------------------------------------------- |
| `desktop.main`          | Electron process and window lifecycle          |
| `desktop.renderer`      | Renderer startup and fatal UI boundary         |
| `desktop.ipc`           | Typed IPC request boundary                     |
| `desktop.mission`       | Mission run, projection, and observation       |
| `desktop.automation`    | Scheduled automation                           |
| `interpreter.loader`    | YAML/import/include/artifact loading           |
| `interpreter.validator` | DSL and environment validation                 |
| `interpreter.compiler`  | Resource linking and Core object compilation   |
| `core.execution`        | Execution lifecycle and commit                 |
| `core.invocation`       | Invocation lifecycle and orchestration         |
| `core.expert-session`   | ExpertSession lifecycle and prompt queue       |
| `core.runtime`          | Runtime routing, session ownership, and driver |
| `core.tool`             | Managed tool and MCP gateway                   |
| `core.storage`          | File state, locks, migration, archive, and GC  |
| `runtime.<adapter>`     | Concrete Runtime protocol/process              |
| `plugin.<plugin-id>`    | Plugin-owned work                              |
| `server.http`           | Fastify request boundary                       |
| `worker.execution`      | Worker dispatch and execution                  |

Event names are stable behavior names, not interpolated messages:

```text
desktop.process.started
desktop.renderer.preload_failed
desktop.renderer.process_gone
desktop.mission.execution_started
desktop.mission.projection_failed
interpreter.project.load_completed
interpreter.project.validation_rejected
interpreter.project.compile_failed
core.execution.recovery_started
core.execution.finalization_failed
core.invocation.started
core.invocation.failed
core.runtime.session_created
core.runtime.session_restore_failed
core.runtime.turn_failed
core.tool.call_failed
core.storage.migration_failed
runtime.codex.process_exited
runtime.claude-code.protocol_failed
runtime.pi.request_failed
```

Dynamic ids belong in `scope` or `attributes`, never in `event`.

## 7. Layer integration

### 7.1 Desktop

Desktop creates the provider before storage bootstrap so bootstrap failures are retained. It then:

- replaces production `console.*` in main-process services;
- registers `uncaughtException`, `unhandledRejection`, `preload-error`, `did-fail-load`,
  `render-process-gone`, and Electron child-process failure handlers;
- wraps typed IPC handlers so unexpected rejections are logged once with request and operation ids;
- passes the provider to the Project Store/Interpreter, `createPragma()`, Runtime factories, and
  Expert compilation;
- flushes on `before-quit` with a bounded deadline.

The renderer cannot import Node-only Core. Desktop's browser-safe shared contracts define a narrow
report request and Desktop's preload exposes:

```ts
pragmaDesktop.diagnostics.report({
  level: "info" | "warn" | "error",
  component: "desktop.renderer",
  event,
  message,
  attributes,
  error,
});
```

Main supplies trusted timestamp, boot/process identity, sequence, and final redaction. Renderer
cannot choose file paths or bypass redaction. Renderer info reports are reserved for bounded
lifecycle measurements such as the first visible Mission token received and painted. Token chunks
and routine UI activity are not reported.

User-visible fatal pages show a short diagnostic id and actions to copy it or open the diagnostic
folder. They do not show a raw stack by default.

### 7.2 Interpreter

`PragmaProjectServiceOptions`, `LoadPragmaProjectOptions`, and `PragmaCompileHost` accept an optional
provider/logger. Project Service binds project id and revision; compile binds resource ref and
environment id.

When Interpreter calls `defineExpert()` or `defineExpertTeam()`, it forwards the provider. This is
required so a DSL-created Expert uses the host sink instead of Core's console default.

Validation logs only summary metadata:

```text
diagnosticCount
errorCount
warningCount
diagnosticCodes
projectFingerprint
durationMs
```

### 7.3 Core

`CreatePragmaOptions` accepts `loggerProvider`. `ExpertSessionManager`,
`FlowExecutionManager`, `ExpertOrchestrator`, `InvocationService`, Runtime resolver/driver, storage,
managed tools, MCP gateway, and plugin hooks receive child loggers rather than constructing globals.

Namespaced components replace the former closed logger-component union. The
no-op, console, and sink providers remain implementations of the new interface,
not as a parallel logger API.

Core centralizes:

- `normalizeDiagnosticError()` and safe error classification;
- JSON-safe attribute normalization and limits;
- redaction;
- child scope merging;
- operation timing helper;
- in-memory sink for tests;
- local rotating JSONL sink and reader.

Repeated local `serializeError()` functions are removed only when their callers are migrated.
Changing the persisted Execution error shape must be accompanied by the ADR 019 migration chain and
fixtures.

### 7.4 Expert and ExpertTeam execution

At minimum emit:

- Invocation accepted/started/waiting/succeeded/failed/cancelled/interrupted;
- delegation spawned, follow-up queued, join completed, and interrupt requested;
- Runtime Context created/reused/closed;
- Runtime Session created/restored/checkpointed/closed;
- managed tool started/completed/failed with name, duration, and approval outcome;
- terminal usage totals, not prompt or response content.

Normal lifecycle transitions should not all be `info`. High-frequency details are `debug`; one
start and one terminal result per major operation are `info`. Token chunks, thoughts, and tool
payloads are never diagnostic records.

### 7.5 Runtime Adapters

Adapters receive the bound logger from Core. They log:

- executable/protocol availability failure;
- session create/restore identity;
- native process exit code and signal;
- request/turn duration, retry count, and provider status code;
- protocol decode and session-id mismatch;
- cancellation and cleanup failures.

Command arguments, environment values, model input/output, raw provider bodies, and unbounded
stdout/stderr are excluded. A bounded stderr tail may only be retained in the private native log
with a `nativeLogRef`.

### 7.6 Plugins and managed tools

Plugins receive `plugin.<id>` with Agent, Execution, Invocation, and Context scope already bound.
They may add operation metadata but may not replace owner ids. Managed tool logs include tool name,
server key, approval outcome, duration, and result size; arguments and results are excluded.

### 7.7 Server and Worker

Server maps the diagnostic record into the existing Fastify/Pino logger so HTTP logs and Pragma
execution logs share one process sink. HTTP request id becomes `requestId`; tenant/actor audit
fields, when introduced, remain separate from diagnostic attributes.

Worker initially writes structured JSON to stdout. A deployment may add an OTLP sink, but local and
remote sinks receive the same already-redacted record.

## 8. Local storage and retention

`PragmaPaths` gains explicit methods:

```text
diagnosticArchivesRoot()
diagnosticApplicationRoot(application)
diagnosticBootRoot(application, date, bootId)
diagnosticOperationLog(application, date, bootId, index)
diagnosticFailureLog(application, date, bootId, index)
```

Callers never concatenate external ids into these paths. `bootId` is generated internally and path
encoded by Core.

The file writer:

1. validates and redacts a complete record;
2. serializes it to one JSON line;
3. enqueues it by priority;
4. rotates before the next write would exceed 10 MiB;
5. flushes periodically and on error/fatal;
6. closes and optionally gzip-compresses on clean shutdown;
7. leaves an uncompressed valid JSONL tail after a crash for the next maintenance pass.

One malformed or partially written final line is ignored by the reader and reported as a reader
warning. Earlier lines remain usable.

`StoragePolicy` is versioned as `pragma.storage-policy/v2` and adds independent diagnostic TTL/limit
fields. `runStorageMaintenance()` prunes diagnostic candidates separately from Execution archives
and reports both counts. Diagnostic logs are never Mission ownership roots and are not moved with
Mission deletion because one process file can contain several Missions. Expiry, explicit "clear
diagnostics", and support export are their only lifecycle.

## 9. Redaction and privacy

Redaction is allowlist-first for known structured inputs and denylist-backed for generic attributes.
The generic sanitizer:

- replaces values under keys matching `authorization`, `cookie`, `credential`, `password`,
  `secret`, `token`, `apiKey`, `privateKey`, and `env`;
- limits object depth, property count, array length, and string length;
- handles cycles and getters without throwing;
- normalizes `Error`, `AggregateError`, and `cause`;
- removes control characters that can break terminal viewing;
- records truncation metadata.

Call sites should log semantic metadata rather than relying on redaction:

```ts
// Good
logger.info("core.tool.call_completed", "Tool call completed.", {
  toolName,
  durationMs,
  resultBytes,
});

// Forbidden
logger.info("core.tool.call_completed", "Tool call completed.", {
  args,
  result,
});
```

Absolute workspace paths, usernames, and remote URLs are treated as sensitive metadata during
support export. The local archive may keep an approved path when essential for local diagnosis, but
the export scrubber replaces the Pragma home and workspace roots with stable placeholders.

## 10. Diagnostic query and support bundle

The first reader API supports:

```ts
interface DiagnosticQuery {
  readonly from?: string;
  readonly to?: string;
  readonly streams?: readonly DiagnosticStream[];
  readonly levels?: readonly DiagnosticLevel[];
  readonly components?: readonly string[];
  readonly missionId?: string;
  readonly executionId?: string;
  readonly invocationId?: string;
  readonly diagnosticId?: string;
  readonly limit: number;
  readonly cursor?: string;
}
```

The reader scans bounded local archives newest-first and returns an opaque cursor. No SQLite index
is necessary for the first 256 MiB implementation. If profiling later shows a need, a rebuildable
index belongs under `cache/`, not `data/` or Execution state.

A support bundle contains:

```text
manifest.json
diagnostics/operations.jsonl
diagnostics/errors.jsonl
system/environment.json
```

The manifest records application version, platform, selected time range and ids, redaction version,
and included optional artifacts. Execution archives and Runtime-native logs are opt-in. Credentials,
environment values, prompts, responses, tool payloads, workspace contents, and Runtime session
databases are always excluded.

## 11. Verification matrix

| Failure injection          | Expected owner         | Required evidence                                 |
| -------------------------- | ---------------------- | ------------------------------------------------- |
| Desktop preload missing    | `desktop.main`         | fatal/error id, preload path scrubbed, boot id    |
| Renderer crash             | `desktop.renderer`     | error id, component stack bounded                 |
| Invalid YAML               | Interpreter diagnostic | warning summary, no failure record                |
| Artifact read failure      | `interpreter.loader`   | one failure, safe relative source                 |
| Compile adapter failure    | `interpreter.compiler` | project/revision/ref correlation                  |
| Execution commit failure   | `core.storage`         | execution/invocation ids, operation fails closed  |
| Delegated Expert failure   | `core.invocation`      | parent and child invocation relationship          |
| Runtime process exit       | `runtime.<adapter>`    | runtime/session/run ids, exit code/signal         |
| Runtime checkpoint failure | `core.runtime`         | owner, system session, retryability               |
| Managed tool rejection     | `core.tool` operation  | approval outcome, no failure                      |
| Managed tool exception     | `core.tool` failure    | tool identity and duration, no args/results       |
| Mission projection failure | `desktop.mission`      | mission/execution ids; Execution state preserved  |
| Log sink unavailable       | emergency stderr       | one non-recursive fallback, app continues if safe |

The integration test should inject a unique fake secret into prompt, tool arguments, environment,
HTTP headers, and an exception property, then assert that it appears in none of the persisted or
exported diagnostic files.
