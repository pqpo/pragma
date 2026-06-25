import type { RuntimeStreamEvent, RuntimeSubmitHandle } from "@expertmesh/agent-core";

type StreamSection = "none" | "thought" | "message" | "toolDelta";

const maxPreviewLines = 10;
const maxPreviewLineLength = 120;

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

class StreamEventPrinter {
  private section: StreamSection = "none";
  private activeToolDelta: string | undefined;

  print(event: RuntimeStreamEvent): void {
    switch (event.type) {
      case "run.started":
        this.printRunStarted(event);
        break;
      case "progress":
        this.printProgress(event);
        break;
      case "thought.delta":
        this.ensureStreamingSection("thought", color.gray("thinking"));
        process.stdout.write(color.dim(event.payload.delta));
        break;
      case "tool.started":
        this.printToolLine(
          color.blue("tool"),
          `${event.payload.toolName} ${color.dim(shortId(event.payload.toolCallId))}`,
          color.dim(event.payload.kind),
        );
        this.printOptionalPreview("input", event.payload.inputPreview);
        break;
      case "tool.delta":
        this.ensureToolDeltaSection(event);
        process.stdout.write(event.payload.delta);
        break;
      case "tool.approval_requested":
        this.printToolLine(
          color.yellow("ask"),
          `${event.payload.toolName} ${color.dim(shortId(event.payload.approvalId))}`,
          event.payload.reason,
        );
        this.printOptionalPreview("input", event.payload.inputPreview);
        break;
      case "tool.completed":
        this.printToolLine(
          color.green("done"),
          `${event.payload.toolName} ${color.dim(shortId(event.payload.toolCallId))}`,
          color.dim(event.payload.kind),
        );
        this.printOptionalPreview("output", event.payload.outputPreview);
        break;
      case "tool.failed":
        this.printToolLine(
          color.red("fail"),
          `${event.payload.toolName} ${color.dim(shortId(event.payload.toolCallId))}`,
          event.payload.message,
        );
        break;
      case "message.delta":
        this.ensureStreamingSection("message", color.green("assistant"));
        process.stdout.write(event.payload.delta);
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
        this.printStatusLine(color.yellow("cancel"), event.payload.reason ?? "Run cancelled");
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
    console.log(`${label} ${color.dim("...")}`);
    this.section = section;
  }

  private ensureToolDeltaSection(
    event: Extract<RuntimeStreamEvent, { type: "tool.delta" }>,
  ): void {
    const key = `${event.payload.toolCallId}:${event.payload.channel}`;

    if (this.section === "toolDelta" && this.activeToolDelta === key) {
      return;
    }

    this.endStreamingSection();
    this.activeToolDelta = key;
    this.section = "toolDelta";
    console.log(
      `${color.magenta("stream")} ${event.payload.toolName} ${color.dim(event.payload.channel)}`,
    );
  }

  private endStreamingSection(): void {
    if (this.section === "thought" || this.section === "message" || this.section === "toolDelta") {
      console.log("");
    }

    this.section = "none";
    this.activeToolDelta = undefined;
  }

  private printRunStarted(event: Extract<RuntimeStreamEvent, { type: "run.started" }>): void {
    this.endStreamingSection();
    console.log(
      `${color.cyan(color.bold("run"))} ${color.dim(shortId(event.runId))} ${event.payload.task}`,
    );

    if (event.payload.inputSummary !== undefined && event.payload.inputSummary !== event.payload.task) {
      this.printPreview("input", event.payload.inputSummary);
    }
  }

  private printProgress(event: Extract<RuntimeStreamEvent, { type: "progress" }>): void {
    this.endStreamingSection();
    const message = event.payload.message === undefined ? "" : ` ${event.payload.message}`;
    this.printStatusLine(color.cyan("step"), `${event.payload.stage}${message}`);

    if (event.payload.data !== undefined) {
      this.printPreview("data", event.payload.data);
    }
  }

  private printArtifact(event: Extract<RuntimeStreamEvent, { type: "artifact.created" }>): void {
    this.printStatusLine(
      color.magenta("file"),
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
    this.printStatusLine(color.green("done"), "Run completed");

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
      color.red("fail"),
      details.filter((part): part is string => part !== undefined).join(" "),
    );
  }

  private printToolLine(label: string, title: string, detail: string | undefined): void {
    this.endStreamingSection();
    this.printStatusLine(label, detail === undefined ? title : `${title} ${color.dim(detail)}`);
  }

  private printStatusLine(label: string, text: string): void {
    this.endStreamingSection();
    console.log(`${color.dim(">")} ${label.padEnd(11)} ${text}`);
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
      console.log(`${color.dim("  " + label.padEnd(7))} ${lines[0]}`);
      return;
    }

    console.log(color.dim(`  ${label}`));

    for (const line of lines) {
      console.log(`${color.dim("  |")} ${line}`);
    }
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

function style(code: number): (value: string) => string {
  return (value: string) => (colorEnabled ? `\u001B[${code}m${value}\u001B[0m` : value);
}
