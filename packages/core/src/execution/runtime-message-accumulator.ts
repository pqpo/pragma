import {
  AgentMessageSchema,
  type AgentAssistantMessage,
  type AgentMessage,
  type AgentMessageUsage,
  type ExpertAgentStreamEvent,
} from "@pragma/shared";

export class RuntimeMessageAccumulator {
  private text = "";
  private thinking = "";
  private completedAssistant = false;
  private readonly recordedToolCallIds = new Set<string>();

  constructor(
    private readonly runtime: { readonly id: string; readonly kind: string },
    private readonly model = "unknown",
  ) {}

  consume(event: ExpertAgentStreamEvent): readonly AgentMessage[] {
    switch (event.type) {
      case "message.delta":
        this.text += event.payload.delta;
        return [];
      case "thought.delta":
        this.thinking += event.payload.delta;
        return [];
      case "message.completed": {
        if (event.payload.message !== undefined) {
          if (event.payload.message.role === "assistant") {
            for (const item of event.payload.message.content) {
              if (item.type === "toolCall") this.recordedToolCallIds.add(item.id);
            }
            if (event.payload.message.stopReason !== "toolUse") {
              this.completedAssistant = true;
            }
          }
          this.reset();
          return [event.payload.message];
        }
        const text = event.payload.text ?? this.text;
        const message = this.createAssistant(
          event,
          [
            ...(this.thinking === ""
              ? []
              : [{ type: "thinking" as const, thinking: this.thinking }]),
            ...(text === "" ? [] : [{ type: "text" as const, text }]),
          ],
          "stop",
        );
        this.reset();
        this.completedAssistant = true;
        return message.content.length === 0 ? [] : [message];
      }
      case "tool.started": {
        if (this.recordedToolCallIds.delete(event.payload.toolCallId)) {
          this.reset();
          return [];
        }
        const message = this.createAssistant(
          event,
          [
            ...(this.thinking === ""
              ? []
              : [{ type: "thinking" as const, thinking: this.thinking }]),
            ...(this.text === "" ? [] : [{ type: "text" as const, text: this.text }]),
            {
              type: "toolCall" as const,
              id: event.payload.toolCallId,
              name: event.payload.toolName,
              arguments: toArguments(event.payload.inputPreview),
            },
          ],
          "toolUse",
        );
        this.reset();
        return [message];
      }
      case "tool.completed":
        return [
          AgentMessageSchema.parse({
            role: "toolResult",
            toolCallId: event.payload.toolCallId,
            toolName: event.payload.toolName,
            content: [{ type: "text", text: stringify(event.payload.outputPreview) }],
            isError: false,
            timestamp: Date.parse(event.emittedAt),
          }),
        ];
      case "tool.failed":
        return [
          AgentMessageSchema.parse({
            role: "toolResult",
            toolCallId: event.payload.toolCallId,
            toolName: event.payload.toolName,
            content: [{ type: "text", text: event.payload.message }],
            isError: true,
            timestamp: Date.parse(event.emittedAt),
          }),
        ];
      default:
        return [];
    }
  }

  complete(output: unknown, usage?: AgentMessageUsage): AgentMessage | undefined {
    if (this.completedAssistant) return undefined;
    const text = typeof output === "string" ? output : JSON.stringify(output);
    if ((text === undefined || text === "") && this.thinking === "") return undefined;
    return AgentMessageSchema.parse({
      role: "assistant",
      content: [
        ...(this.thinking === "" ? [] : [{ type: "thinking", thinking: this.thinking }]),
        ...(text === undefined || text === "" ? [] : [{ type: "text", text }]),
      ],
      api: this.runtime.kind,
      provider: this.runtime.id,
      model: this.model,
      usage: usage ?? EMPTY_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    });
  }

  private createAssistant(
    event: ExpertAgentStreamEvent,
    content: AgentAssistantMessage["content"],
    stopReason: AgentAssistantMessage["stopReason"],
  ): AgentAssistantMessage {
    return AgentMessageSchema.parse({
      role: "assistant",
      content,
      api: this.runtime.kind,
      provider: this.runtime.id,
      model: this.model,
      usage: EMPTY_USAGE,
      stopReason,
      timestamp: Date.parse(event.emittedAt),
    }) as AgentAssistantMessage;
  }

  private reset(): void {
    this.text = "";
    this.thinking = "";
  }
}

const EMPTY_USAGE: AgentMessageUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return value === undefined ? {} : { input: value };
}

function stringify(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
