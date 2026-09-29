import type { AgentMessage } from "@pragma/shared";
import type { OpenCodeWireEvent } from "./client.ts";

export type OpenCodeStreamEvent =
  | { readonly kind: "message-delta" | "thought-delta"; readonly text: string }
  | {
      readonly kind: "message-completed";
      readonly text: string;
      readonly final: boolean;
      readonly thinking?: string;
      readonly message?: AgentMessage;
    }
  | {
      readonly kind: "tool-started" | "tool-completed" | "tool-failed";
      readonly id: string;
      readonly name: string;
      readonly value?: unknown;
    }
  | { readonly kind: "progress"; readonly stage: string };

interface Part {
  readonly messageId: string;
  readonly kind: "text" | "reasoning";
  text: string;
  ended: boolean;
  readonly ignored: boolean;
}

/** Native deltas and full-value snapshots share one cursor per content part. */
export class OpenCodeStream {
  private readonly roles = new Map<string, string>();
  private readonly parts = new Map<string, Part>();
  private readonly tools = new Map<string, { name: string; ended: boolean }>();
  private readonly toolInputs = new Map<string, { name: string; dependencies: readonly Part[] }>();
  private active: { messageId: string; text: string } | undefined;
  private lastText = "";
  private thinking = "";
  private readonly deferredTools: { event: OpenCodeWireEvent; dependencies: readonly Part[] }[] =
    [];

  consume(event: OpenCodeWireEvent): OpenCodeStreamEvent[] {
    const output: OpenCodeStreamEvent[] = [];
    const data = event.data;
    if (event.type === "message.updated") {
      const info = record(data["info"]);
      if (typeof info?.["id"] === "string" && typeof info["role"] === "string") {
        this.roles.set(info["id"], info["role"]);
      }
    } else if (event.type === "message.part.updated") {
      const value = record(data["part"]);
      if (value === undefined || typeof value["messageID"] !== "string") return output;
      if (this.roles.get(value["messageID"]) !== "assistant") return output;
      if (
        (value["type"] === "text" || value["type"] === "reasoning") &&
        typeof value["id"] === "string"
      ) {
        const part = this.part(
          value["id"],
          value["messageID"],
          value["type"],
          value["ignored"] === true || value["synthetic"] === true,
        );
        if (typeof value["text"] === "string") this.snapshot(part, value["text"], output);
        if (record(value["time"])?.["end"] !== undefined) {
          part.ended = true;
        }
      } else if (value["type"] === "tool" && typeof value["callID"] === "string") {
        const state = record(value["state"]);
        if (state?.["status"] === "pending") return output;
        this.tool(
          value["callID"],
          typeof value["tool"] === "string" ? value["tool"] : "unknown",
          state?.["status"],
          state?.["input"],
          state?.["output"] ?? state?.["error"],
          output,
        );
      }
    } else if (event.type === "message.part.delta") {
      // In 1.x, both reasoning and visible text use field="text". The part owns the channel.
      const part = typeof data["partID"] === "string" ? this.parts.get(data["partID"]) : undefined;
      if (part !== undefined && data["field"] === "text" && typeof data["delta"] === "string")
        this.delta(part, data["delta"], output);
    } else if (
      event.type.startsWith("session.text.") ||
      event.type.startsWith("session.reasoning.")
    ) {
      if (typeof data["assistantMessageID"] !== "string" || typeof data["ordinal"] !== "number")
        return output;
      const kind = event.type.startsWith("session.text.") ? "text" : "reasoning";
      const part = this.part(
        JSON.stringify([data["assistantMessageID"], kind, data["ordinal"]]),
        data["assistantMessageID"],
        kind,
      );
      if (event.type.endsWith(".delta") && typeof data["delta"] === "string")
        this.delta(part, data["delta"], output);
      if (event.type.endsWith(".ended") && typeof data["text"] === "string") {
        this.snapshot(part, data["text"], output);
        part.ended = true;
      }
    } else if (event.type === "session.step.started") {
      if (this.active !== undefined && this.active.messageId !== data["assistantMessageID"])
        this.complete(output);
    } else if (
      event.type === "session.tool.input.started" ||
      event.type === "session.tool.called" ||
      event.type === "session.tool.success" ||
      event.type === "session.tool.failed"
    ) {
      // Native text batching can deliver tool start before earlier text deltas/endings.
      // Started content parts preserve the provider order; wait for their full-value boundary.
      if (event.type === "session.tool.input.started") {
        if (
          typeof data["id"] === "string" &&
          typeof data["name"] === "string" &&
          !this.toolInputs.has(data["id"])
        )
          this.toolInputs.set(data["id"], {
            name: data["name"],
            dependencies: [...this.parts.values()].filter(
              (part) => !part.ended && part.messageId === data["assistantMessageID"],
            ),
          });
      } else {
        const dependencies =
          typeof data["id"] === "string"
            ? (this.toolInputs.get(data["id"])?.dependencies ?? [])
            : [];
        if (this.deferredTools.length > 0 || dependencies.some((part) => !part.ended))
          this.deferredTools.push({ event, dependencies });
        else this.nativeTool(event, output);
      }
    } else if (event.type.includes("compaction"))
      output.push({ kind: "progress", stage: event.type });
    this.flushTools(output);
    return output;
  }

  finish(text: string): OpenCodeStreamEvent[] {
    const output: OpenCodeStreamEvent[] = [];
    this.flushTools(output, true);
    const current = this.active?.text ?? this.lastText;
    if (text !== current) {
      if (this.active !== undefined && text.startsWith(current))
        output.push({ kind: "message-delta", text: text.slice(current.length) });
      else if (this.active === undefined) output.push({ kind: "message-delta", text });
    }
    this.active = undefined;
    this.lastText = text;
    // Keep a native completion open until a subsequent message/tool or settled turn.
    // Otherwise the last native snapshot and final answer create duplicate history rows.
    // Only the Adapter's settled Pragma turn owns the final-answer boundary.
    output.push({
      kind: "message-completed",
      text,
      final: true,
      ...(this.thinking === "" ? {} : { thinking: this.thinking }),
    });
    this.thinking = "";
    return output;
  }

  private flushTools(output: OpenCodeStreamEvent[], force = false): void {
    while (this.deferredTools.length > 0) {
      const next = this.deferredTools[0]!;
      if (!force && next.dependencies.some((part) => !part.ended)) return;
      this.deferredTools.shift();
      this.nativeTool(next.event, output);
    }
  }

  private nativeTool(event: OpenCodeWireEvent, output: OpenCodeStreamEvent[]): void {
    const data = event.data;
    if (typeof data["id"] !== "string") return;
    const name =
      this.toolInputs.get(data["id"])?.name ?? this.tools.get(data["id"])?.name ?? "unknown";
    if (event.type === "session.tool.called")
      this.tool(data["id"], name, "running", data["input"], undefined, output);
    else
      this.tool(
        data["id"],
        name,
        event.type === "session.tool.success" ? "completed" : "error",
        undefined,
        data["error"] ?? data["content"],
        output,
      );
  }

  private part(id: string, messageId: string, kind: Part["kind"], ignored = false): Part {
    let part = this.parts.get(id);
    if (part === undefined) {
      part = { messageId, kind, text: "", ended: false, ignored };
      this.parts.set(id, part);
    }
    return part;
  }

  private snapshot(part: Part, text: string, output: OpenCodeStreamEvent[]): void {
    if (part.ended || !text.startsWith(part.text)) return;
    this.delta(part, text.slice(part.text.length), output);
  }

  private delta(part: Part, text: string, output: OpenCodeStreamEvent[]): void {
    if (part.ended || text === "" || part.ignored) return;
    part.text += text;
    if (part.kind === "reasoning") {
      if (this.active !== undefined && this.active.messageId !== part.messageId)
        this.complete(output);
      this.thinking += text;
      output.push({ kind: "thought-delta", text });
      return;
    }
    if (this.active !== undefined && this.active.messageId !== part.messageId)
      this.complete(output);
    this.active ??= { messageId: part.messageId, text: "" };
    this.active.text += text;
    output.push({ kind: "message-delta", text });
  }

  private complete(output: OpenCodeStreamEvent[]): void {
    if (this.active === undefined) return;
    this.lastText = this.active.text;
    output.push({
      kind: "message-completed",
      text: this.lastText,
      final: false,
      ...(this.thinking === "" ? {} : { thinking: this.thinking }),
    });
    this.thinking = "";
    this.active = undefined;
  }

  private tool(
    id: string,
    name: string,
    status: unknown,
    input: unknown,
    value: unknown,
    output: OpenCodeStreamEvent[],
  ): void {
    let tool = this.tools.get(id);
    if (tool === undefined) {
      this.complete(output);
      tool = { name, ended: false };
      this.tools.set(id, tool);
      output.push({ kind: "tool-started", id, name, value: input });
      // With no visible text, Core commits the preceding thought on tool.started.
      this.thinking = "";
    }
    if (!tool.ended && (status === "completed" || status === "error")) {
      tool.ended = true;
      output.push({
        kind: status === "completed" ? "tool-completed" : "tool-failed",
        id,
        name: tool.name,
        value,
      });
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
