import type { ExpertTurn } from "@pragma/core";

interface ConsoleOutput {
  readonly isTTY?: boolean | undefined;
  write(text: string): unknown;
}

export interface ConsoleTurnRendererOptions {
  readonly output?: ConsoleOutput | undefined;
  readonly color?: boolean | undefined;
  readonly maxPreviewLength?: number | undefined;
}

interface RenderableEvent {
  readonly type: string;
  readonly data: unknown;
}

type Section = "answer" | "thinking" | "tool-output";

const ANSI = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  cyan: "\u001B[36m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  red: "\u001B[31m",
} as const;

export class ConsoleTurnRenderer {
  private readonly output: ConsoleOutput;
  private readonly color: boolean;
  private readonly maxPreviewLength: number;
  private section: Section | undefined;
  private lineOpen = false;
  private answerRendered = false;
  private failureRendered = false;
  private readonly toolsWithDelta = new Set<string>();

  constructor(options: ConsoleTurnRendererOptions = {}) {
    this.output = options.output ?? process.stdout;
    this.color =
      options.color ?? (this.output.isTTY === true && process.env["NO_COLOR"] === undefined);
    this.maxPreviewLength = options.maxPreviewLength ?? 800;
  }

  render(event: RenderableEvent): void {
    const runtimeEvent = event.type === "runtime.stream" ? asRecord(event.data) : undefined;
    const type = runtimeEvent === undefined ? event.type : readString(runtimeEvent, "type");
    const payload =
      runtimeEvent === undefined ? asRecord(event.data) : asRecord(runtimeEvent["payload"]);

    switch (type) {
      case "thought.delta":
        this.renderDelta("thinking", "Thinking", readString(payload, "delta"), ANSI.dim);
        break;
      case "message.delta":
        this.answerRendered = true;
        this.renderDelta("answer", "Expert", readString(payload, "delta"));
        break;
      case "message.completed":
        if (!this.answerRendered) {
          const text = readString(payload, "text");
          if (text !== "") {
            this.answerRendered = true;
            this.renderDelta("answer", "Expert", text);
          }
        }
        break;
      case "tool.started":
        this.renderToolStarted(payload);
        break;
      case "tool.delta":
        this.renderToolDelta(payload);
        break;
      case "tool.completed":
        this.renderToolCompleted(payload);
        break;
      case "tool.failed":
        this.renderToolFailed(payload);
        break;
      case "tool.approval_requested":
        this.renderToolApproval(payload);
        break;
      case "progress":
        this.renderProgress(payload);
        break;
      case "artifact.created":
        this.renderStatus(
          "◆",
          "Artifact",
          readString(payload, "title") || readString(payload, "kind"),
          ANSI.cyan,
        );
        break;
      case "run.failed":
        this.failureRendered = true;
        this.renderStatus("×", "Failed", readString(payload, "message"), ANSI.red);
        break;
      case "run.cancelled":
        this.failureRendered = true;
        this.renderStatus("×", "Cancelled", readString(payload, "reason"), ANSI.yellow);
        break;
    }
  }

  complete(result: unknown): void {
    if (!this.answerRendered) {
      const formatted = formatValue(result, this.maxPreviewLength);
      if (formatted === "") {
        this.renderStatus("!", "Empty response", "The Runtime returned no output.", ANSI.yellow);
      } else {
        this.answerRendered = true;
        this.renderDelta("answer", "Expert", formatted);
      }
    }
    this.endSection();
    this.write("\n");
  }

  fail(error: unknown): void {
    if (!this.failureRendered) {
      this.renderStatus(
        "×",
        "Error",
        error instanceof Error ? error.message : String(error),
        ANSI.red,
      );
    }
    this.write("\n");
  }

  private renderDelta(section: Section, label: string, delta: string, style?: string): void {
    if (delta === "") return;
    if (this.section !== section) {
      this.endSection();
      this.write(`${this.paint("•", ANSI.cyan)} ${this.paint(label, ANSI.bold)}\n`);
      this.section = section;
    }
    this.write(this.paint(delta, style));
  }

  private renderToolStarted(payload: Record<string, unknown>): void {
    this.endSection();
    const name = readString(payload, "toolName") || "tool";
    this.write(`${this.paint("•", ANSI.cyan)} ${this.paint(`Running ${name}`, ANSI.bold)}\n`);
    if (hasMeaningfulPreview(payload["inputPreview"])) {
      this.writeIndented(
        formatValue(payload["inputPreview"], this.maxPreviewLength),
        "  ↳ ",
        ANSI.dim,
      );
    }
  }

  private renderToolDelta(payload: Record<string, unknown>): void {
    const id = readString(payload, "toolCallId");
    if (id !== "") this.toolsWithDelta.add(id);
    this.renderDelta("tool-output", "Tool output", readString(payload, "delta"), ANSI.dim);
  }

  private renderToolCompleted(payload: Record<string, unknown>): void {
    this.endSection();
    const id = readString(payload, "toolCallId");
    const name = readString(payload, "toolName") || "tool";
    if (!this.toolsWithDelta.has(id) && payload["outputPreview"] !== undefined) {
      this.writeIndented(
        formatValue(payload["outputPreview"], this.maxPreviewLength),
        "  ↳ ",
        ANSI.dim,
      );
    }
    this.write(`  ${this.paint("✓", ANSI.green)} ${this.paint(`${name} completed`, ANSI.green)}\n`);
  }

  private renderToolFailed(payload: Record<string, unknown>): void {
    this.endSection();
    const name = readString(payload, "toolName") || "tool";
    this.write(`  ${this.paint("×", ANSI.red)} ${this.paint(`${name} failed`, ANSI.red)}`);
    const message = readString(payload, "message");
    this.write(message === "" ? "\n" : `: ${message}\n`);
  }

  private renderToolApproval(payload: Record<string, unknown>): void {
    const name = readString(payload, "toolName") || "tool";
    this.renderStatus("!", "Approval required", name, ANSI.yellow);
  }

  private renderProgress(payload: Record<string, unknown>): void {
    const stage = readString(payload, "stage");
    if (stage === "turn.start" || stage === "turn.end" || stage === "queue.update") return;
    this.renderStatus("↻", stage || "Progress", readString(payload, "message"), ANSI.yellow);
  }

  private renderStatus(symbol: string, label: string, message: string, color: string): void {
    this.endSection();
    const suffix = message === "" ? "" : ` — ${message}`;
    this.write(`${this.paint(symbol, color)} ${this.paint(label, ANSI.bold)}${suffix}\n`);
  }

  private writeIndented(text: string, prefix: string, style?: string): void {
    for (const [index, line] of text.split("\n").entries()) {
      this.write(this.paint(`${index === 0 ? prefix : "    "}${line}\n`, style));
    }
  }

  private endSection(): void {
    if (this.section !== undefined && this.lineOpen) this.write("\n");
    this.section = undefined;
  }

  private write(text: string): void {
    this.output.write(text);
    const visible = Object.values(ANSI).reduce(
      (current, controlSequence) => current.replaceAll(controlSequence, ""),
      text,
    );
    if (visible !== "") this.lineOpen = !visible.endsWith("\n");
  }

  private paint(text: string, style?: string): string {
    return this.color && style !== undefined ? `${style}${text}${ANSI.reset}` : text;
  }
}

export async function renderExpertTurn(
  turn: ExpertTurn,
  options: ConsoleTurnRendererOptions = {},
): Promise<unknown> {
  const renderer = new ConsoleTurnRenderer(options);
  try {
    for await (const event of turn.events()) {
      renderer.render(event);
    }
    const result = await turn.result;
    renderer.complete(result);
    return result;
  } catch (error) {
    renderer.fail(error);
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function hasMeaningfulPreview(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

function formatValue(value: unknown, maxLength: number): string {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}
