import { randomUUID } from "node:crypto";

import {
  PragmaLogRecordSchema,
  type PragmaFailureLogRecord,
  type PragmaJsonValue,
  type PragmaLogError,
  type PragmaLogLevel,
  type PragmaLogRecord,
  type PragmaLogScope,
} from "@pragma/shared";

export interface PragmaLogAttributes {
  readonly [key: string]: unknown;
}

export interface PragmaLogHandler {
  readonly write: (record: PragmaLogRecord) => void;
  readonly flush?: (() => Promise<void>) | undefined;
  readonly close?: (() => Promise<void>) | undefined;
}

export interface PragmaLogger {
  readonly child: (input: {
    readonly component?: string | undefined;
    readonly scope?: PragmaLogScope | undefined;
  }) => PragmaLogger;
  readonly debug: (event: string, message: string, attributes?: PragmaLogAttributes) => void;
  readonly info: (event: string, message: string, attributes?: PragmaLogAttributes) => void;
  readonly warn: (event: string, message: string, attributes?: PragmaLogAttributes) => void;
  readonly error: (
    event: string,
    message: string,
    error: unknown,
    attributes?: PragmaLogAttributes,
  ) => string;
  readonly fatal: (
    event: string,
    message: string,
    error: unknown,
    attributes?: PragmaLogAttributes,
  ) => string;
}

export interface PragmaLoggerProvider {
  readonly createLogger: (input: {
    readonly component: string;
    readonly scope?: PragmaLogScope | undefined;
  }) => PragmaLogger;
  readonly withScope: (scope: PragmaLogScope) => PragmaLoggerProvider;
}

export interface CreateLoggerProviderOptions {
  readonly handler: PragmaLogHandler;
  readonly minimumLevel?: PragmaLogLevel | "silent" | undefined;
  readonly host?: {
    readonly kind: string;
    readonly bootId?: string | undefined;
    readonly pid?: number | undefined;
    readonly version?: string | undefined;
  };
  readonly baseScope?: PragmaLogScope | undefined;
}

const LEVEL_ORDER: Readonly<Record<PragmaLogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};
const MAX_DEPTH = 6;
const MAX_CAUSE_DEPTH = 5;
const MAX_PROPERTIES = 100;
const MAX_ARRAY_LENGTH = 100;
const MAX_STRING_LENGTH = 8_192;
const MAX_STACK_LENGTH = 32_768;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_SCOPE_VALUE_LENGTH = 2_048;
const MAX_IDENTIFIER_LENGTH = 256;
const TRUNCATED_SUFFIX = "…[TRUNCATED]";
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /(authorization|cookie|credential|password|secret|token|api[_-]?key|private[_-]?key|env)/i;

export function createLoggerProvider(options: CreateLoggerProviderOptions): PragmaLoggerProvider {
  const state = {
    sequence: 0,
    minimumLevel: options.minimumLevel ?? "info",
    handler: options.handler,
    reportFailure: createEmergencyReporter(),
    host: {
      kind: sanitizeText(options.host?.kind ?? "node", MAX_IDENTIFIER_LENGTH),
      bootId: options.host?.bootId ?? randomUUID(),
      ...(options.host?.pid === undefined ? {} : { pid: options.host.pid }),
      ...(options.host?.version === undefined
        ? {}
        : { version: sanitizeText(options.host.version, MAX_IDENTIFIER_LENGTH) }),
    },
  };
  return createScopedProvider(state, sanitizeScope(options.baseScope ?? {}));
}

export function createConsoleLogHandler(): PragmaLogHandler {
  return {
    write(record) {
      const payload = JSON.stringify(record);
      switch (record.level) {
        case "debug":
          console.debug(payload);
          break;
        case "info":
          console.info(payload);
          break;
        case "warn":
          console.warn(payload);
          break;
        case "error":
        case "fatal":
          console.error(payload);
          break;
      }
    },
  };
}

export function createConsoleLoggerProvider(
  options: Omit<CreateLoggerProviderOptions, "handler"> = {},
): PragmaLoggerProvider {
  return createLoggerProvider({
    ...options,
    handler: createConsoleLogHandler(),
    minimumLevel: options.minimumLevel ?? readDefaultLogLevel(),
  });
}

export function createNoopLoggerProvider(): PragmaLoggerProvider {
  return createLoggerProvider({
    handler: { write: () => undefined },
    minimumLevel: "silent",
    host: { kind: "noop" },
  });
}

export function createCompositeLogHandler(handlers: readonly PragmaLogHandler[]): PragmaLogHandler {
  const reportFailure = createEmergencyReporter();
  const settle = async (operation: "flush" | "close"): Promise<void> => {
    const results = await Promise.allSettled(
      handlers.map(async (handler) => await handler[operation]?.()),
    );
    for (const result of results) {
      if (result.status === "rejected") reportFailure(result.reason);
    }
  };
  return {
    write(record) {
      for (const handler of handlers) {
        try {
          handler.write(record);
        } catch (error) {
          reportFailure(error);
        }
      }
    },
    flush: async () => await settle("flush"),
    close: async () => await settle("close"),
  };
}

export const defaultPragmaLoggerProvider = createConsoleLoggerProvider();

export function createPragmaLogger(
  provider: PragmaLoggerProvider | undefined,
  input: {
    readonly component: string;
    readonly scope?: PragmaLogScope | undefined;
  },
): PragmaLogger {
  return (provider ?? defaultPragmaLoggerProvider).createLogger(input);
}

function createScopedProvider(
  state: {
    sequence: number;
    readonly minimumLevel: PragmaLogLevel | "silent";
    readonly handler: PragmaLogHandler;
    readonly reportFailure: (error: unknown) => void;
    readonly host: {
      readonly kind: string;
      readonly bootId: string;
      readonly pid?: number | undefined;
      readonly version?: string | undefined;
    };
  },
  baseScope: PragmaLogScope,
): PragmaLoggerProvider {
  return {
    createLogger: ({ component, scope }) =>
      createScopedLogger(
        state,
        sanitizeText(component, MAX_IDENTIFIER_LENGTH),
        mergeScope(baseScope, sanitizeScope(scope ?? {})),
      ),
    withScope: (scope) => createScopedProvider(state, mergeScope(baseScope, sanitizeScope(scope))),
  };
}

function createScopedLogger(
  state: Parameters<typeof createScopedProvider>[0],
  component: string,
  scope: PragmaLogScope,
): PragmaLogger {
  const operation = (
    level: "debug" | "info" | "warn",
    event: string,
    message: string,
    attributes?: PragmaLogAttributes,
  ): void => {
    if (!shouldWrite(state.minimumLevel, level)) return;
    try {
      dispatch(state, {
        schemaVersion: "pragma.log/v1",
        recordId: randomUUID(),
        occurredAt: new Date().toISOString(),
        sequence: state.sequence++,
        host: state.host,
        stream: "operation",
        level,
        component,
        event: sanitizeText(event, MAX_IDENTIFIER_LENGTH),
        message: sanitizeText(message, MAX_STRING_LENGTH),
        scope,
        ...(attributes === undefined ? {} : { attributes: sanitizeAttributes(attributes) }),
      });
    } catch (error) {
      state.reportFailure(error);
    }
  };
  const failure = (
    level: "error" | "fatal",
    event: string,
    message: string,
    caught: unknown,
    attributes?: PragmaLogAttributes,
  ): string => {
    const diagnosticId = readDiagnosticId(caught) ?? randomUUID();
    if (!shouldWrite(state.minimumLevel, level)) return diagnosticId;
    try {
      dispatch(state, {
        schemaVersion: "pragma.log/v1",
        recordId: randomUUID(),
        diagnosticId,
        occurredAt: new Date().toISOString(),
        sequence: state.sequence++,
        host: state.host,
        stream: "failure",
        level,
        component,
        event: sanitizeText(event, MAX_IDENTIFIER_LENGTH),
        message: sanitizeText(message, MAX_STRING_LENGTH),
        scope,
        error: normalizeLogError(caught),
        ...(attributes === undefined ? {} : { attributes: sanitizeAttributes(attributes) }),
      });
      const flushing = state.handler.flush?.();
      if (flushing !== undefined) void flushing.catch(state.reportFailure);
    } catch (error) {
      state.reportFailure(error);
    }
    return diagnosticId;
  };
  return {
    child: (input) =>
      createScopedLogger(
        state,
        sanitizeText(input.component ?? component, MAX_IDENTIFIER_LENGTH),
        mergeScope(sanitizeScope(input.scope ?? {}), scope),
      ),
    debug: (event, message, attributes) => operation("debug", event, message, attributes),
    info: (event, message, attributes) => operation("info", event, message, attributes),
    warn: (event, message, attributes) => operation("warn", event, message, attributes),
    error: (event, message, error, attributes) =>
      failure("error", event, message, error, attributes),
    fatal: (event, message, error, attributes) =>
      failure("fatal", event, message, error, attributes),
  };
}

function dispatch(
  state: Parameters<typeof createScopedProvider>[0],
  record: PragmaLogRecord,
): void {
  try {
    state.handler.write(boundRecord(PragmaLogRecordSchema.parse(record)));
  } catch (error) {
    state.reportFailure(error);
  }
}

function boundRecord(record: PragmaLogRecord): PragmaLogRecord {
  if (Buffer.byteLength(JSON.stringify(record)) <= MAX_RECORD_BYTES) return record;
  const base = {
    ...record,
    message: truncate(record.message, 2_048),
    scope: sanitizeScope(record.scope, 512),
    attributes: { recordTruncated: true },
  };
  const bounded =
    record.stream === "operation"
      ? base
      : {
          ...base,
          error: {
            code: truncate(record.error.code, MAX_IDENTIFIER_LENGTH),
            name: truncate(record.error.name, MAX_IDENTIFIER_LENGTH),
            message: truncate(record.error.message, 2_048),
            classification: record.error.classification,
            retryable: record.error.retryable,
          },
        };
  if (Buffer.byteLength(JSON.stringify(bounded)) <= MAX_RECORD_BYTES) return bounded;
  return {
    ...bounded,
    message: truncate(bounded.message, 512),
    scope: {},
  };
}

export function normalizeLogError(error: unknown, depth = 0): PragmaLogError {
  try {
    if (depth >= MAX_CAUSE_DEPTH) {
      return {
        code: "cause-depth-exceeded",
        name: "TruncatedError",
        message: "Additional error causes were truncated.",
        classification: "unknown",
        retryable: false,
      };
    }
    if (error instanceof AggregateError) {
      const errors = safeRead(error, "errors");
      const cause = safeRead(error, "cause");
      return {
        code: readErrorCode(error),
        name: readErrorName(error),
        message: sanitizeText(readErrorMessage(error), MAX_STRING_LENGTH),
        ...readErrorStack(error),
        classification: classifyError(error),
        retryable: readRetryable(error),
        errors: (Array.isArray(errors) ? errors : [])
          .slice(0, MAX_ARRAY_LENGTH)
          .map((entry) => normalizeLogError(entry, depth + 1)),
        ...(cause === undefined ? {} : { cause: normalizeLogError(cause, depth + 1) }),
      };
    }
    if (error instanceof Error) {
      const cause = safeRead(error, "cause");
      return {
        code: readErrorCode(error),
        name: readErrorName(error),
        message: sanitizeText(readErrorMessage(error), MAX_STRING_LENGTH),
        ...readErrorStack(error),
        classification: classifyError(error),
        retryable: readRetryable(error),
        ...(cause === undefined ? {} : { cause: normalizeLogError(cause, depth + 1) }),
      };
    }
    return {
      code: "unknown",
      name: "UnknownError",
      message: sanitizeText(
        typeof error === "string" ? error : safeStringify(error),
        MAX_STRING_LENGTH,
      ),
      classification: "unknown",
      retryable: false,
    };
  } catch {
    return {
      code: "unserializable-error",
      name: "UnknownError",
      message: "The logged error could not be inspected safely.",
      classification: "unknown",
      retryable: false,
    };
  }
}

function sanitizeAttributes(attributes: PragmaLogAttributes): Record<string, PragmaJsonValue> {
  try {
    return Object.fromEntries(
      Object.entries(attributes)
        .slice(0, MAX_PROPERTIES)
        .map(([key, value]) => [
          sanitizeText(key, MAX_IDENTIFIER_LENGTH),
          SENSITIVE_KEY.test(key) ? REDACTED : sanitizeValue(value, 0, new Set<object>()),
        ]),
    );
  } catch {
    return { attributesUnserializable: true };
  }
}

function sanitizeValue(value: unknown, depth: number, ancestors: Set<object>): PragmaJsonValue {
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return truncate(value, MAX_STRING_LENGTH);
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (value instanceof Error) return sanitizeValue(normalizeLogError(value), depth + 1, ancestors);
  if (typeof value !== "object") return String(value);
  if (ancestors.has(value)) return "[CIRCULAR]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .slice(0, MAX_ARRAY_LENGTH)
        .map((entry) => sanitizeValue(entry, depth + 1, ancestors));
    }
    const output: Record<string, PragmaJsonValue> = {};
    for (const [key, entry] of Object.entries(value).slice(0, MAX_PROPERTIES)) {
      output[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitizeValue(entry, depth + 1, ancestors);
    }
    return output;
  } catch {
    return "[UNSERIALIZABLE]";
  } finally {
    ancestors.delete(value);
  }
}

function shouldWrite(minimumLevel: PragmaLogLevel | "silent", level: PragmaLogLevel): boolean {
  return minimumLevel !== "silent" && LEVEL_ORDER[level] >= LEVEL_ORDER[minimumLevel];
}

function readDefaultLogLevel(): PragmaLogLevel | "silent" {
  const configured = process.env["PRAGMA_LOG_LEVEL"];
  return configured === "debug" ||
    configured === "info" ||
    configured === "warn" ||
    configured === "error" ||
    configured === "fatal" ||
    configured === "silent"
    ? configured
    : "info";
}

function readErrorCode(error: Error): string {
  const code = safeRead(error, "code");
  return typeof code === "string" && code.trim() !== ""
    ? sanitizeText(code, MAX_IDENTIFIER_LENGTH)
    : readErrorName(error);
}

function readDiagnosticId(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = safeRead(error, "diagnosticId");
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
}

function classifyError(error: Error): PragmaLogError["classification"] {
  const value = `${readErrorName(error)} ${readErrorMessage(error)}`.toLowerCase();
  if (value.includes("abort") || value.includes("cancel")) return "cancelled";
  if (value.includes("timeout") || value.includes("timed out")) return "timeout";
  if (value.includes("permission") || value.includes("denied")) return "permission";
  if (value.includes("not found")) return "not-found";
  if (value.includes("conflict")) return "conflict";
  if (value.includes("validation") || value.includes("invalid")) return "validation";
  if (value.includes("storage") || value.includes("filesystem")) return "storage";
  if (value.includes("runtime") || value.includes("protocol")) return "runtime";
  if (value.includes("network") || value.includes("external")) return "external";
  return "unknown";
}

function readRetryable(error: Error): boolean {
  return safeRead(error, "retryable") === true;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= TRUNCATED_SUFFIX.length) return TRUNCATED_SUFFIX.slice(0, maxLength);
  return `${value.slice(0, maxLength - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return serialized;
  } catch {
    // Fall through to a defensive String conversion.
  }
  try {
    return String(value);
  } catch {
    return "[UNSERIALIZABLE]";
  }
}

function createEmergencyReporter(): (error: unknown) => void {
  let reported = false;
  return (error) => {
    if (reported) return;
    reported = true;
    try {
      console.error(
        JSON.stringify({
          level: "error",
          component: "core.logging",
          event: "log_handler_failed",
          message: normalizeLogError(error).message,
        }),
      );
    } catch {
      // The emergency path must never recurse or interfere with application control flow.
    }
  };
}

function sanitizeScope(scope: PragmaLogScope, maxLength = MAX_SCOPE_VALUE_LENGTH): PragmaLogScope {
  try {
    return Object.fromEntries(
      Object.entries(scope).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, sanitizeText(value, maxLength)]],
      ),
    ) as PragmaLogScope;
  } catch {
    return {};
  }
}

function mergeScope(base: PragmaLogScope, additions: PragmaLogScope): PragmaLogScope {
  return { ...base, ...additions };
}

function sanitizeText(value: string, maxLength: number): string {
  return truncate(
    Array.from(value, (character) =>
      isUnsafeControlCharacter(character.charCodeAt(0)) ? "�" : character,
    ).join(""),
    maxLength,
  );
}

function isUnsafeControlCharacter(code: number): boolean {
  return (
    code <= 0x08 ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f)
  );
}

function safeRead(value: object, key: PropertyKey): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function readErrorName(error: Error): string {
  const name = safeRead(error, "name");
  return typeof name === "string" && name.trim() !== ""
    ? sanitizeText(name, MAX_IDENTIFIER_LENGTH)
    : "Error";
}

function readErrorMessage(error: Error): string {
  const message = safeRead(error, "message");
  return typeof message === "string" ? message : "An error occurred.";
}

function readErrorStack(error: Error): { readonly stack?: string | undefined } {
  const stack = safeRead(error, "stack");
  return typeof stack === "string" ? { stack: sanitizeText(stack, MAX_STACK_LENGTH) } : {};
}

export type { PragmaFailureLogRecord, PragmaLogRecord };
