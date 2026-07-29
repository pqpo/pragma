import type { ExecutionOutputItem } from "@pragma/core";

export type ConsoleExecutionActivityKind =
  | "answer"
  | "progress"
  | "thinking"
  | "tool"
  | "tool-output";

export interface ConsoleExecutionActivity {
  readonly kind: ConsoleExecutionActivityKind;
  readonly text: string;
  readonly append: boolean;
}

export interface ExecutionOutputAccumulatorOptions {
  readonly includeRoutineProgress?: boolean | undefined;
  readonly maxPreviewLength?: number | undefined;
}

export class ExecutionOutputAccumulator {
  private readonly includeRoutineProgress: boolean;
  private readonly maxPreviewLength: number;
  private readonly invocationsWithAnswers = new Set<string>();
  private readonly activeToolKeys = new Map<string, string>();
  private readonly toolOutputSnapshots = new Map<string, string>();
  private readonly toolsWithOutputDeltas = new Set<string>();

  constructor(options: ExecutionOutputAccumulatorOptions = {}) {
    this.includeRoutineProgress = options.includeRoutineProgress ?? true;
    this.maxPreviewLength = options.maxPreviewLength ?? 800;
  }

  consume(item: ExecutionOutputItem): readonly ConsoleExecutionActivity[] {
    switch (item.channel) {
      case "thought": {
        const text = item.delta ?? formatConsoleValue(item.value);
        return text === undefined ? [] : [{ kind: "thinking", text, append: true }];
      }
      case "message":
        return this.consumeMessage(item);
      case "tool":
        return this.consumeTool(item);
      case "progress": {
        const payload = asConsoleRecord(item.value);
        const stage = readConsoleString(payload, "stage");
        if (!this.includeRoutineProgress && isRoutineProgress(stage)) return [];
        const text = formatConsoleProgress(item.value);
        return text === undefined ? [] : [{ kind: "progress", text, append: false }];
      }
      case "agent": {
        const text = formatConsoleValue(item.value);
        return text === undefined ? [] : [{ kind: "progress", text, append: false }];
      }
      case "result": {
        if (this.invocationsWithAnswers.has(item.invocationId)) return [];
        const text = formatConsoleValue(item.value);
        return text === undefined ? [] : [{ kind: "answer", text, append: false }];
      }
      case "telemetry":
        return [];
    }
  }

  reset(): void {
    this.invocationsWithAnswers.clear();
    this.activeToolKeys.clear();
    this.toolOutputSnapshots.clear();
    this.toolsWithOutputDeltas.clear();
  }

  private consumeMessage(item: ExecutionOutputItem): readonly ConsoleExecutionActivity[] {
    if (item.delta !== undefined) {
      if (item.delta === "") return [];
      this.invocationsWithAnswers.add(item.invocationId);
      return [{ kind: "answer", text: item.delta, append: true }];
    }
    if (this.invocationsWithAnswers.has(item.invocationId)) return [];
    const text = readCompletedMessageText(item.value);
    if (text === undefined) return [];
    this.invocationsWithAnswers.add(item.invocationId);
    return [{ kind: "answer", text, append: false }];
  }

  private consumeTool(item: ExecutionOutputItem): readonly ConsoleExecutionActivity[] {
    if (item.delta !== undefined) {
      const toolKey = this.activeToolKeys.get(item.invocationId) ?? item.invocationId;
      const normalized = normalizeToolOutputDelta(item.delta, this.maxPreviewLength);
      const increment =
        normalized === undefined
          ? undefined
          : readToolOutputIncrement(this.toolOutputSnapshots, toolKey, normalized);
      if (increment === undefined || increment === "") return [];
      this.toolsWithOutputDeltas.add(toolKey);
      return [{ kind: "tool-output", text: increment, append: true }];
    }

    const payload = asConsoleRecord(item.value);
    const toolName = readConsoleString(payload, "toolName") || "tool";
    const toolCallId = readConsoleString(payload, "toolCallId") || item.invocationId;
    const toolKey = `${item.invocationId}:${toolCallId}`;
    const started =
      payload["message"] === undefined &&
      payload["approvalId"] === undefined &&
      payload["outputPreview"] === undefined;

    if (started) {
      this.activeToolKeys.set(item.invocationId, toolKey);
      this.toolOutputSnapshots.delete(toolKey);
      this.toolsWithOutputDeltas.delete(toolKey);
      const preview = formatConsolePreview(payload["inputPreview"], this.maxPreviewLength);
      return [
        {
          kind: "tool",
          text: `→ ${toolName}${preview === undefined ? "" : `\n${preview}`}`,
          append: false,
        },
      ];
    }

    const activeToolKey = this.activeToolKeys.get(item.invocationId) ?? item.invocationId;
    let activities: readonly ConsoleExecutionActivity[];
    if (payload["message"] !== undefined) {
      activities = [
        {
          kind: "tool",
          text: `× ${toolName}: ${readConsoleString(payload, "message")}`,
          append: false,
        },
      ];
    } else if (payload["approvalId"] !== undefined) {
      activities = [{ kind: "tool", text: `! ${toolName} requires approval`, append: false }];
    } else {
      const preview = formatConsolePreview(payload["outputPreview"], this.maxPreviewLength);
      activities = [
        { kind: "tool", text: `✓ ${toolName} completed`, append: false },
        ...(preview === undefined || this.toolsWithOutputDeltas.has(activeToolKey)
          ? []
          : [{ kind: "tool-output" as const, text: preview, append: false }]),
      ];
    }

    if (payload["approvalId"] === undefined) {
      this.activeToolKeys.delete(item.invocationId);
      this.toolOutputSnapshots.delete(activeToolKey);
      this.toolsWithOutputDeltas.delete(activeToolKey);
    }
    return activities;
  }
}

export function asConsoleRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function readConsoleString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

export function formatConsoleValue(value: unknown, maxLength?: number): string | undefined {
  if (value === undefined) return undefined;
  const text =
    typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
  if (maxLength === undefined || text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatConsolePreview(value: unknown, maxLength = 800): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(asConsoleRecord(value)).length === 0
  ) {
    return undefined;
  }
  return formatConsoleValue(value, maxLength);
}

export function formatConsoleProgress(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  const record = asConsoleRecord(value);
  const stage = readConsoleString(record, "stage");
  const message = readConsoleString(record, "message");
  if (stage !== "" || message !== "") {
    return `${stage}${stage !== "" && message !== "" ? " — " : ""}${message}`;
  }
  return formatConsoleValue(value);
}

function readCompletedMessageText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const content = asConsoleRecord(value)["content"];
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => {
      const record = asConsoleRecord(item);
      return record["type"] === "text" ? readConsoleString(record, "text") : "";
    })
    .join("");
  return text === "" ? undefined : text;
}

function normalizeToolOutputDelta(delta: string, maxLength: number): string | undefined {
  try {
    const parsed = JSON.parse(delta) as unknown;
    const content = asConsoleRecord(parsed)["content"];
    if (Array.isArray(content)) {
      const text = content
        .map((item) => readConsoleString(asConsoleRecord(item), "text"))
        .join("\n");
      return text === "" ? undefined : text;
    }
    return formatConsolePreview(parsed, maxLength);
  } catch {
    return delta;
  }
}

function readToolOutputIncrement(
  snapshots: Map<string, string>,
  key: string,
  next: string,
): string | undefined {
  const previous = snapshots.get(key);
  if (previous === undefined) {
    snapshots.set(key, next);
    return next;
  }
  if (next === previous) return undefined;
  if (next.startsWith(previous)) {
    snapshots.set(key, next);
    return next.slice(previous.length) || undefined;
  }
  snapshots.set(key, `${previous}${next}`);
  return next;
}

function isRoutineProgress(stage: string): boolean {
  return stage === "" || stage === "turn.start" || stage === "turn.end" || stage === "queue.update";
}
