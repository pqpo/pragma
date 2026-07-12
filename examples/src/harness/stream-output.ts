import type { PragmaRunEvent, RuntimeStreamEvent, RuntimeSubmitHandle } from "@pragma/core";

type StreamSection = "none" | "thought" | "message" | "toolDelta";

const maxPreviewLines = 10;
const maxPreviewLineLength = 120;
const frameWidth = 88;
const logPrefix = "EM";

const colorEnabled =
  process.env["NO_COLOR"] === undefined &&
  process.env["FORCE_COLOR"] !== "0" &&
  (process.stdout.isTTY || process.env["FORCE_COLOR"] !== undefined);

const color = {
  bold: style(1),
  dim: style(2),
  red: style(31),
  green: style(32),
  yellow: style(33),
  blue: style(34),
  magenta: style(35),
  cyan: style(36),
  gray: style(90),
};

export async function printRunStream(run: RuntimeSubmitHandle<unknown>): Promise<void> {
  const printer = new StreamEventPrinter();

  for await (const event of run.events) {
    printer.print(event);
  }

  printer.finish();
}

export async function printPragmaRunStream(events: AsyncIterable<PragmaRunEvent>): Promise<void> {
  for await (const event of events) {
    if (event.type === "message.delta") {
      const delta = readStringPayload(event.payload, "delta");
      if (delta !== undefined) {
        process.stdout.write(delta);
      }
      continue;
    }

    if (event.type === "tool.started" || event.type === "tool.completed") {
      const toolName = readStringPayload(event.payload, "toolName");
      if (toolName !== undefined) {
        console.log(`\n[${event.type}] ${toolName}`);
      }
      continue;
    }

    if (event.type === "run.failed" || event.type === "workflow.failed") {
      const message = readStringPayload(event.payload, "message");
      if (message !== undefined) {
        console.error(`\n[${event.type}] ${message}`);
      }
    }
  }
  console.log("");
}

/**
 * Rehydrates a Runtime stream event from its public Pragma run-event projection.
 *
 * The run event store intentionally promotes `type` and keeps only the Runtime
 * event's business payload. The display metadata below comes from the durable
 * workflow event so callers can still use the richer Runtime stream printer.
 */
export function readRuntimeStreamEvent(event: PragmaRunEvent): RuntimeStreamEvent | undefined {
  if (event.sourceType !== "task.progress" && event.sourceType !== "task.output.delta") {
    return undefined;
  }

  return {
    schemaVersion: "pragma.stream/v1",
    eventId: event.id,
    sequence: event.cursor.sequence,
    runId: event.taskRunId ?? event.workflowRunId,
    emittedAt: event.occurredAt,
    source: {
      kind: "agent",
      runId: event.taskRunId ?? event.workflowRunId,
      path: [],
    },
    type: event.type,
    payload: event.payload,
  } as RuntimeStreamEvent;
}

function readStringPayload(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export class StreamEventPrinter {
  private section: StreamSection = "none";
  private activeToolDelta: string | undefined;
  private streamLineStart = true;

  print(event: RuntimeStreamEvent): void {
    switch (event.type) {
      case "run.started":
        this.printRunStarted(event);
        break;
      case "progress":
        this.printProgress(event);
        break;
      case "thought.delta":
        this.ensureStreamingSection("thought", color.gray("THINKING"));
        this.writeStreamDelta(event.payload.delta, color.dim);
        break;
      case "tool.started":
        this.printToolLine(
          color.blue("TOOL"),
          `${event.payload.toolName} ${color.dim(shortId(event.payload.toolCallId))}`,
          color.dim(event.payload.kind),
        );
        this.printOptionalPreview("input", event.payload.inputPreview);
        break;
      case "tool.delta":
        this.ensureToolDeltaSection(event);
        this.writeStreamDelta(event.payload.delta);
        break;
      case "tool.approval_requested":
        this.printToolLine(
          color.yellow("APPROVAL"),
          `${event.payload.toolName} ${color.dim(shortId(event.payload.approvalId))}`,
          event.payload.reason,
        );
        this.printOptionalPreview("input", event.payload.inputPreview);
        break;
      case "tool.completed":
        this.printToolLine(
          color.green("TOOL DONE"),
          `${event.payload.toolName} ${color.dim(shortId(event.payload.toolCallId))}`,
          color.dim(event.payload.kind),
        );
        this.printOptionalPreview("output", event.payload.outputPreview);
        break;
      case "tool.failed":
        this.printToolLine(
          color.red("TOOL FAILED"),
          `${event.payload.toolName} ${color.dim(shortId(event.payload.toolCallId))}`,
          event.payload.message,
        );
        break;
      case "message.delta":
        this.ensureStreamingSection("message", color.green("ASSISTANT"));
        this.writeStreamDelta(event.payload.delta);
        break;
      case "message.completed":
        this.endStreamingSection();
        break;
      case "artifact.created":
        this.printArtifact(event);
        break;
      case "run.completed":
        this.printRunCompleted(event);
        break;
      case "run.failed":
        this.printRunFailed(event);
        break;
      case "run.cancelled":
        this.printStatusLine(color.yellow("CANCELLED"), event.payload.reason ?? "Run cancelled");
        break;
    }
  }

  finish(): void {
    this.endStreamingSection();
  }

  private ensureStreamingSection(section: StreamSection, label: string): void {
    if (this.section === section) {
      return;
    }

    this.endStreamingSection();
    this.printSectionHeader(label);
    this.section = section;
    this.streamLineStart = true;
  }

  private ensureToolDeltaSection(event: Extract<RuntimeStreamEvent, { type: "tool.delta" }>): void {
    const key = `${event.payload.toolCallId}:${event.payload.channel}`;

    if (this.section === "toolDelta" && this.activeToolDelta === key) {
      return;
    }

    this.endStreamingSection();
    this.activeToolDelta = key;
    this.section = "toolDelta";
    this.printSectionHeader(
      `${color.magenta("TOOL STREAM")} ${event.payload.toolName} ${color.dim(event.payload.channel)}`,
    );
    this.streamLineStart = true;
  }

  private endStreamingSection(): void {
    if (
      (this.section === "thought" || this.section === "message" || this.section === "toolDelta") &&
      !this.streamLineStart
    ) {
      console.log("");
    }

    this.section = "none";
    this.activeToolDelta = undefined;
    this.streamLineStart = true;
  }

  private printRunStarted(event: Extract<RuntimeStreamEvent, { type: "run.started" }>): void {
    this.endStreamingSection();
    this.printFrame("RUN STREAM", `${shortId(event.runId)} | ${event.payload.task}`, color.cyan);

    if (
      event.payload.inputSummary !== undefined &&
      event.payload.inputSummary !== event.payload.task
    ) {
      this.printPreview("input", event.payload.inputSummary);
    }
  }

  private printProgress(event: Extract<RuntimeStreamEvent, { type: "progress" }>): void {
    this.endStreamingSection();
    const message = event.payload.message === undefined ? "" : ` ${event.payload.message}`;
    this.printStatusLine(color.cyan(formatStage(event.payload.stage)), message.trimStart());

    if (event.payload.data !== undefined) {
      this.printPreview("data", event.payload.data);
    }
  }

  private printArtifact(event: Extract<RuntimeStreamEvent, { type: "artifact.created" }>): void {
    this.printStatusLine(
      color.magenta("FILE"),
      [
        event.payload.title ?? event.payload.artifactId,
        color.dim(event.payload.kind),
        event.payload.uri === undefined ? undefined : color.dim(event.payload.uri),
      ]
        .filter((part): part is string => part !== undefined)
        .join(" "),
    );
  }

  private printRunCompleted(event: Extract<RuntimeStreamEvent, { type: "run.completed" }>): void {
    this.printStatusLine(color.green("DONE"), "Run completed");

    if (event.payload.usage !== undefined) {
      this.printPreview("usage", event.payload.usage);
    }
  }

  private printRunFailed(event: Extract<RuntimeStreamEvent, { type: "run.failed" }>): void {
    const details = [
      event.payload.message,
      event.payload.code === undefined ? undefined : color.dim(event.payload.code),
      event.payload.retryable === undefined
        ? undefined
        : color.dim(`retryable=${String(event.payload.retryable)}`),
    ];

    this.printStatusLine(
      color.red("FAIL"),
      details.filter((part): part is string => part !== undefined).join(" "),
    );
  }

  private printToolLine(label: string, title: string, detail: string | undefined): void {
    this.endStreamingSection();
    this.printStatusLine(label, detail === undefined ? title : `${title} ${color.dim(detail)}`);
  }

  private printStatusLine(label: string, text: string): void {
    this.endStreamingSection();
    const suffix = text.length === 0 ? "" : ` ${text}`;
    console.log(`${this.prefix()} ${label.padEnd(13)}${suffix}`);
  }

  private printOptionalPreview(label: string, value: unknown): void {
    if (value !== undefined) {
      this.printPreview(label, value);
    }
  }

  private printPreview(label: string, value: unknown): void {
    const preview = formatPreview(value);
    const lines = preview.split("\n");

    if (lines.length === 1) {
      console.log(`${this.prefix()} ${color.dim(label.padEnd(13))} ${lines[0]}`);
      return;
    }

    console.log(`${this.prefix()} ${color.dim(label)}`);

    for (const line of lines) {
      console.log(`${this.prefix()} ${color.dim("|")} ${line}`);
    }
  }

  private printSectionHeader(label: string): void {
    console.log(`${this.prefix()} ${color.bold(label)}`);
  }

  private writeStreamDelta(delta: string, decorate: (value: string) => string = identity): void {
    for (const char of delta) {
      if (this.streamLineStart) {
        process.stdout.write(`${this.prefix()} ${color.dim("|")} `);
        this.streamLineStart = false;
      }

      process.stdout.write(decorate(char));

      if (char === "\n") {
        this.streamLineStart = true;
      }
    }
  }

  private printFrame(title: string, subtitle: string, decorate: (value: string) => string): void {
    const rule = "=".repeat(frameWidth);
    console.log(`${this.prefix()} ${decorate(rule)}`);
    console.log(`${this.prefix()} ${decorate(color.bold(title))} ${color.dim(subtitle)}`);
    console.log(`${this.prefix()} ${decorate(rule)}`);
  }

  private prefix(): string {
    return color.bold(color.cyan(logPrefix));
  }
}

function formatPreview(value: unknown): string {
  const raw = stringifyPreview(value);
  const normalized = raw.trimEnd();
  const lines = normalized.split("\n");
  const clippedLines = lines.slice(0, maxPreviewLines).map((line) => clipLine(line));

  if (lines.length > maxPreviewLines) {
    clippedLines.push(color.dim(`... ${lines.length - maxPreviewLines} more lines`));
  }

  return clippedLines.join("\n");
}

function stringifyPreview(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  const compact = stringifyJson(value, 0);

  if (compact !== undefined && compact.length <= maxPreviewLineLength) {
    return compact;
  }

  return stringifyJson(value, 2) ?? String(value);
}

function stringifyJson(value: unknown, space: number): string | undefined {
  try {
    return JSON.stringify(value, null, space) ?? undefined;
  } catch {
    return undefined;
  }
}

function clipLine(line: string): string {
  return line.length <= maxPreviewLineLength
    ? line
    : `${line.slice(0, maxPreviewLineLength - 3)}...`;
}

function shortId(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}

function formatStage(stage: string): string {
  return stage
    .split(".")
    .filter((part) => part.length > 0)
    .join(" ")
    .toUpperCase();
}

function identity(value: string): string {
  return value;
}

function style(code: number): (value: string) => string {
  return (value: string) => (colorEnabled ? `\u001B[${code}m${value}\u001B[0m` : value);
}
