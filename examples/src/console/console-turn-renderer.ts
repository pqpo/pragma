import type { ExecutionOutputItem, ExpertTurn } from "@pragma/core";

import {
  asConsoleRecord as asRecord,
  formatConsoleValue,
  readConsoleString as readString,
} from "./execution-output-accumulator.ts";

interface ConsoleOutput {
  readonly isTTY?: boolean | undefined;
  write(text: string): unknown;
}

export interface ConsoleTurnRendererOptions {
  readonly output?: ConsoleOutput | undefined;
  readonly color?: boolean | undefined;
  readonly maxPreviewLength?: number | undefined;
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

  renderOutput(item: ExecutionOutputItem): void {
    switch (item.channel) {
      case "thought":
        this.renderDelta(
          "thinking",
          "Thinking",
          item.delta ?? formatValue(item.value, this.maxPreviewLength),
          ANSI.dim,
        );
        break;
      case "message":
        if (item.delta !== undefined) {
          this.answerRendered = true;
          this.renderDelta("answer", "Expert", item.delta);
        }
        break;
      case "tool": {
        const payload = asRecord(item.value);
        if (payload["message"] !== undefined) this.renderToolFailed(payload);
        else if (payload["outputPreview"] !== undefined) this.renderToolCompleted(payload);
        else if (payload["toolName"] !== undefined) this.renderToolStarted(payload);
        else if (item.delta !== undefined)
          this.renderDelta("tool-output", "Tool output", item.delta, ANSI.dim);
        break;
      }
      case "progress":
        this.renderProgress(asRecord(item.value));
        break;
      case "result":
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
  const subscription = await turn.subscribeOutput({ scope: { kind: "all" } });
  try {
    for await (const output of subscription) renderer.renderOutput(output);
    const result = await turn.result;
    renderer.complete(result);
    return result;
  } catch (error) {
    renderer.fail(error);
    throw error;
  } finally {
    await subscription.close();
  }
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
  return formatConsoleValue(value, maxLength) ?? String(value);
}
