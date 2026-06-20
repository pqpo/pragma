import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export function readAssistantTextDelta(event: AgentSessionEvent): string | undefined {
  if (event.type !== "message_update") {
    return undefined;
  }

  if (event.assistantMessageEvent.type === "text_delta") {
    return event.assistantMessageEvent.delta;
  }

  return undefined;
}
