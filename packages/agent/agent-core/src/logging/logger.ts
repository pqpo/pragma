export type ExpertAgentLogLevel = "debug" | "info" | "warn" | "error";

export type ExpertAgentLoggerComponent = "expert-agent" | "runtime-adapter" | "plugin";

export interface ExpertAgentLoggerScope {
  readonly component: ExpertAgentLoggerComponent;
  readonly agentId?: string | undefined;
  readonly runtimeId?: string | undefined;
  readonly pluginId?: string | undefined;
  readonly name?: string | undefined;
}

export interface ExpertAgentLogContext {
  readonly [key: string]: unknown;
}

export interface ExpertAgentLogRecord {
  readonly timestamp: string;
  readonly level: ExpertAgentLogLevel;
  readonly scope: ExpertAgentLoggerScope;
  readonly message: string;
  readonly context?: ExpertAgentLogContext | undefined;
}

export interface ExpertAgentLogger {
  readonly debug: (message: string, context?: ExpertAgentLogContext | undefined) => void;
  readonly info: (message: string, context?: ExpertAgentLogContext | undefined) => void;
  readonly warn: (message: string, context?: ExpertAgentLogContext | undefined) => void;
  readonly error: (message: string, context?: ExpertAgentLogContext | undefined) => void;
}

export interface ExpertAgentLoggerProvider {
  readonly createLogger: (scope: ExpertAgentLoggerScope) => ExpertAgentLogger;
}

export type ExpertAgentLogSink = (record: ExpertAgentLogRecord) => void;

export function createLoggerProvider(sink: ExpertAgentLogSink): ExpertAgentLoggerProvider {
  return {
    createLogger: (scope) => createScopedLogger(scope, sink),
  };
}

export function createNoopLoggerProvider(): ExpertAgentLoggerProvider {
  return createLoggerProvider(() => undefined);
}

export function createConsoleLoggerProvider(): ExpertAgentLoggerProvider {
  return createLoggerProvider((record) => {
    const payload = JSON.stringify({
      timestamp: record.timestamp,
      level: record.level,
      scope: record.scope,
      message: record.message,
      ...(record.context === undefined ? {} : { context: serializeLogContext(record.context) }),
    });

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
        console.error(payload);
        break;
    }
  });
}

export const defaultExpertAgentLoggerProvider = createNoopLoggerProvider();

export function createExpertAgentLogger(
  provider: ExpertAgentLoggerProvider | undefined,
  scope: ExpertAgentLoggerScope,
): ExpertAgentLogger {
  return (provider ?? defaultExpertAgentLoggerProvider).createLogger(scope);
}

function createScopedLogger(
  scope: ExpertAgentLoggerScope,
  sink: ExpertAgentLogSink,
): ExpertAgentLogger {
  const write = (
    level: ExpertAgentLogLevel,
    message: string,
    context: ExpertAgentLogContext | undefined,
  ) => {
    sink({
      timestamp: new Date().toISOString(),
      level,
      scope,
      message,
      ...(context === undefined ? {} : { context }),
    });
  };

  return {
    debug: (message, context) => {
      write("debug", message, context);
    },
    info: (message, context) => {
      write("info", message, context);
    },
    warn: (message, context) => {
      write("warn", message, context);
    },
    error: (message, context) => {
      write("error", message, context);
    },
  };
}

function serializeLogContext(context: ExpertAgentLogContext): ExpertAgentLogContext {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      value instanceof Error
        ? {
            name: value.name,
            message: value.message,
            stack: value.stack,
          }
        : value,
    ]),
  );
}
