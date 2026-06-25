import type { RuntimeStreamEvent, RuntimeSubmitHandle } from "@expertmesh/agent-core";

type StreamSection = "none" | "progress" | "thought" | "message" | "tool";

export async function printRunStream(run: RuntimeSubmitHandle<unknown>): Promise<void> {
  const printer = new StreamEventPrinter();

  for await (const event of run.events) {
    printer.print(event);
  }

  printer.finish();
}

class StreamEventPrinter {
  private section: StreamSection = "none";

  print(event: RuntimeStreamEvent): void {
    switch (event.type) {
      case "run.started":
        this.printBlock("Run started", [
          `runId: ${event.runId}`,
          `task: ${event.payload.task}`,
          event.payload.inputSummary === undefined
            ? undefined
            : `input: ${event.payload.inputSummary}`,
        ]);
        break;
      case "progress":
        this.ensureSection("progress", "Progress");
        console.log(formatProgress(event));
        break;
      case "thought.delta":
        this.ensureSection("thought", "Thought");
        process.stdout.write(event.payload.delta);
        break;
      case "tool.started":
        this.ensureSection("tool", "Tool calls");
        console.log(
          `\n> ${event.payload.kind} started: ${event.payload.toolName} (${event.payload.toolCallId})`,
        );
        printOptionalPreview("input", event.payload.inputPreview);
        break;
      case "tool.delta":
        this.ensureSection("tool", "Tool calls");
        console.log(
          `\n> ${event.payload.kind} delta: ${event.payload.toolName} (${event.payload.channel})`,
        );
        process.stdout.write(event.payload.delta);
        break;
      case "tool.approval_requested":
        this.ensureSection("tool", "Tool calls");
        console.log(
          `\n> ${event.payload.kind} approval requested: ${event.payload.toolName} (${event.payload.approvalId})`,
        );
        if (event.payload.reason !== undefined) {
          console.log(`reason: ${event.payload.reason}`);
        }
        printOptionalPreview("input", event.payload.inputPreview);
        break;
      case "tool.completed":
        this.ensureSection("tool", "Tool calls");
        console.log(
          `\n> ${event.payload.kind} completed: ${event.payload.toolName} (${event.payload.toolCallId})`,
        );
        printOptionalPreview("output", event.payload.outputPreview);
        break;
      case "tool.failed":
        this.ensureSection("tool", "Tool calls");
        console.log(
          `\n> ${event.payload.kind} failed: ${event.payload.toolName} (${event.payload.toolCallId})`,
        );
        console.log(event.payload.message);
        break;
      case "message.delta":
        this.ensureSection("message", "Assistant output");
        process.stdout.write(event.payload.delta);
        break;
      case "message.completed":
        this.endStreamingSection();
        break;
      case "artifact.created":
        this.printBlock("Artifact created", [
          `artifactId: ${event.payload.artifactId}`,
          `kind: ${event.payload.kind}`,
          event.payload.title === undefined ? undefined : `title: ${event.payload.title}`,
          event.payload.uri === undefined ? undefined : `uri: ${event.payload.uri}`,
        ]);
        break;
      case "run.completed":
        this.printBlock("Run completed", [
          event.payload.outputSummary === undefined
            ? undefined
            : `output: ${event.payload.outputSummary}`,
          event.payload.usage === undefined
            ? undefined
            : `usage: ${JSON.stringify(event.payload.usage)}`,
        ]);
        break;
      case "run.failed":
        this.printBlock("Run failed", [
          `message: ${event.payload.message}`,
          event.payload.code === undefined ? undefined : `code: ${event.payload.code}`,
          event.payload.retryable === undefined
            ? undefined
            : `retryable: ${String(event.payload.retryable)}`,
        ]);
        break;
      case "run.cancelled":
        this.printBlock("Run cancelled", [
          event.payload.reason === undefined ? undefined : `reason: ${event.payload.reason}`,
        ]);
        break;
    }
  }

  finish(): void {
    this.endStreamingSection();
  }

  private ensureSection(section: StreamSection, title: string): void {
    if (this.section === section) {
      return;
    }

    this.endStreamingSection();
    console.log("");
    console.log(`--- ${title} ---`);
    this.section = section;
  }

  private printBlock(title: string, lines: readonly (string | undefined)[]): void {
    this.endStreamingSection();
    console.log("");
    console.log(`--- ${title} ---`);
    for (const line of lines) {
      if (line !== undefined) {
        console.log(line);
      }
    }
  }

  private endStreamingSection(): void {
    if (this.section === "thought" || this.section === "message") {
      console.log("");
    }

    this.section = "none";
  }
}

function formatProgress(event: Extract<RuntimeStreamEvent, { type: "progress" }>): string {
  const data = event.payload.data === undefined ? "" : ` data=${formatPreview(event.payload.data)}`;
  const message = event.payload.message === undefined ? "" : ` ${event.payload.message}`;

  return `- ${event.payload.stage}${message}${data}`;
}

function printOptionalPreview(label: string, value: unknown): void {
  if (value !== undefined) {
    console.log(`${label}: ${formatPreview(value)}`);
  }
}

function formatPreview(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
