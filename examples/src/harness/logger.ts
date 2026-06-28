import { createLoggerProvider } from "@expertmesh/core";
import type { ExpertAgentLogContext, ExpertAgentLogRecord } from "@expertmesh/core";

export function createExampleLoggerProvider() {
  return createLoggerProvider((record) => {
    console.error(formatLogRecord(record));
  });
}

function formatLogRecord(record: ExpertAgentLogRecord): string {
  const scope = [
    record.scope.component,
    record.scope.agentId,
    record.scope.runtimeId,
    record.scope.pluginId,
    record.scope.name,
  ]
    .filter((value): value is string => value !== undefined)
    .join(":");
  const context = record.context === undefined ? "" : ` ${formatLogContext(record.context)}`;

  return `[audit] ${record.level.toUpperCase()} ${scope} ${record.message}${context}`;
}

function formatLogContext(context: ExpertAgentLogContext): string {
  return safeJsonStringify(
    Object.fromEntries(
      Object.entries(context).map(([key, value]) => [
        key,
        value instanceof Error ? { name: value.name, message: value.message } : value,
      ]),
    ),
  );
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
