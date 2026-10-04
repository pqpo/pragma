import { InvocationOutputSchema } from "@pragma/shared";
import { isFinalExecutionStatus } from "@pragma/shared";
import type { ExecutionOutputItem } from "@pragma/core";

export const MISSION_CHAT_ERROR_MAX_LENGTH = 10_000;

export type ExecutorNameResolver = (executorId: string) => string | undefined;
export type ExecutorAvatarIdResolver = (executorId: string) => string | undefined;

export function isRootMissionRuntimeSource(
  source: Pick<ExecutionOutputItem["source"], "parentSessionId">,
): boolean {
  return source.parentSessionId === undefined;
}

export function isMissionTerminalExecutionStatus(
  status: Parameters<typeof isFinalExecutionStatus>[0],
): boolean {
  return status === "interrupted" || isFinalExecutionStatus(status);
}

export function nextMessageEntryId(
  executionId: string,
  invocationId: string,
  runId: string,
  kind: "assistant" | "thinking",
  ordinals: Map<string, number>,
): string {
  const key = JSON.stringify([executionId, invocationId, runId, kind]);
  const ordinal = ordinals.get(key) ?? 0;
  ordinals.set(key, ordinal + 1);
  return `message:${executionId}:${invocationId}:${runId}:${kind}:${ordinal}`;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

export function preview(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const formatted = formatValue(value, 801);
  return formatted === "" ? undefined : formatted;
}

export function missionWorkOutputSummary(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const output = InvocationOutputSchema.safeParse(value);
  const summary = output.success
    ? output.data.type === "inline"
      ? readableSummary(output.data.value, new Set(), 0)
      : output.data.summary.trim()
    : readableSummary(value, new Set(), 0);
  return summary === "" ? undefined : truncate(summary, maxLength);
}

function readableSummary(value: unknown, seen: Set<object>, depth: number): string {
  if (depth > 8) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "";
    seen.add(value);
    return value
      .map((item) => readableSummary(item, seen, depth + 1))
      .filter((item) => item !== "")
      .join("\n");
  }
  if (typeof value !== "object" || value === null) return "";
  if (seen.has(value)) return "";
  seen.add(value);

  const record = value as Record<string, unknown>;
  for (const key of [
    "summary",
    "message",
    "text",
    "content",
    "answer",
    "result",
    "output",
    "value",
  ]) {
    const summary = readableSummary(record[key], seen, depth + 1);
    if (summary !== "") return summary;
  }
  for (const item of Object.values(record)) {
    const summary = readableSummary(item, seen, depth + 1);
    if (summary !== "") return summary;
  }
  return "";
}

export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

export function formatValue(value: unknown, maxLength: number): string {
  let content: string;
  if (typeof value === "string") {
    content = value;
  } else if (value === undefined) {
    content = "";
  } else {
    try {
      content = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      content = String(value);
    }
  }
  return content.length <= maxLength
    ? content
    : `${content.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
