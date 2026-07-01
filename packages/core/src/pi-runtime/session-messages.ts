import { AgentMessageSchema, type AgentMessage } from "@pragma/shared";

export function convertPiAgentMessages(messages: readonly unknown[]): readonly AgentMessage[] {
  return messages.map((message) => convertPiAgentMessage(message));
}

function convertPiAgentMessage(message: unknown): AgentMessage {
  const parsedMessage = readRuntimeObject(message);

  if (parsedMessage === undefined) {
    return createUnknownRuntimeMessage("unknown", message);
  }

  switch (parsedMessage.role) {
    case "user":
    case "assistant":
    case "toolResult":
    case "bashExecution":
    case "custom":
    case "branchSummary":
    case "compactionSummary":
      return AgentMessageSchema.parse(parsedMessage);
    default:
      return createUnknownRuntimeMessage(parsedMessage.role, parsedMessage);
  }
}

function readRuntimeObject(message: unknown): RuntimeMessageObject | undefined {
  if (message === null || typeof message !== "object") {
    return undefined;
  }

  const role = (message as { readonly role?: unknown }).role;

  if (typeof role !== "string" || role.length === 0) {
    return undefined;
  }

  return message as RuntimeMessageObject;
}

function createUnknownRuntimeMessage(role: string, details: unknown): AgentMessage {
  const timestamp =
    typeof (details as { readonly timestamp?: unknown } | undefined)?.timestamp === "number"
      ? (details as { readonly timestamp: number }).timestamp
      : 0;

  return {
    role: "custom",
    customType: `pi.${role}`,
    content: `Unsupported PI runtime message role: ${role}`,
    display: false,
    details,
    timestamp,
  };
}

type RuntimeMessageObject = {
  readonly role: string;
  readonly [key: string]: unknown;
};
