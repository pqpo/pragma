import { ExpertAgentHumanRequestSchema } from "@pragma/core";
import type { ExpertMessageHistory } from "@pragma/shared";

import type { StewardChatEntry } from "./contracts.ts";

export function toStewardChatEntries(
  histories: readonly ExpertMessageHistory[],
): StewardChatEntry[] {
  const entries = histories.flatMap((history) =>
    history.invocations.flatMap((invocation) => invocation.messages.flatMap(toChatEntries)),
  );
  const settledToolCalls = new Set(
    entries.flatMap((entry) =>
      entry.role === "tool" && entry.toolStatus !== "running" && entry.toolCallId !== undefined
        ? [entry.toolCallId]
        : [],
    ),
  );
  return entries.filter(
    (entry) =>
      entry.role !== "tool" ||
      entry.toolStatus !== "running" ||
      entry.toolCallId === undefined ||
      !settledToolCalls.has(entry.toolCallId),
  );
}

export function toStewardHumanResponseEntries(
  events: readonly {
    readonly eventId: string;
    readonly type: string;
    readonly data: unknown;
    readonly occurredAt: string;
  }[],
): StewardChatEntry[] {
  const requests = new Map<string, ReturnType<typeof ExpertAgentHumanRequestSchema.parse>>();
  for (const event of events) {
    if (event.type !== "human.requested") continue;
    const data = event.data as { interactionId?: unknown; request?: unknown };
    if (typeof data.interactionId !== "string") continue;
    const request = ExpertAgentHumanRequestSchema.safeParse(data.request);
    if (request.success) requests.set(data.interactionId, request.data);
  }
  return events.flatMap((event): StewardChatEntry[] => {
    if (event.type !== "human.responded") return [];
    const data = event.data as { interactionId?: unknown; response?: unknown };
    if (typeof data.interactionId !== "string") return [];
    const request = requests.get(data.interactionId);
    const response = data.response as {
      kind?: unknown;
      approved?: unknown;
      reason?: unknown;
      answers?: unknown;
    };
    let content: string;
    if (response.kind === "tool_approval" && typeof response.approved === "boolean") {
      const target = request?.kind === "tool_approval" ? ` ${request.toolName}` : "";
      content = `${response.approved ? "Approved" : "Rejected"}${target}.`;
      if (typeof response.reason === "string" && response.reason.trim() !== "") {
        content += `\n${response.reason.trim()}`;
      }
    } else if (response.kind === "user_question" && response.answers !== undefined) {
      content = formatHumanAnswers(response.answers);
    } else {
      return [];
    }
    return [
      {
        id: `human-response:${data.interactionId}`,
        role: "user",
        content,
        createdAt: event.occurredAt,
      },
    ];
  });
}

export function mergeStewardChatEntries(
  ...groups: readonly (readonly StewardChatEntry[])[]
): StewardChatEntry[] {
  return groups
    .flatMap((group) => [...group])
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function toChatEntries(record: {
  readonly sequence: number;
  readonly executionId: string;
  readonly message: {
    readonly role: string;
    readonly timestamp: number;
    readonly content?: unknown;
    readonly toolName?: string | undefined;
    readonly toolCallId?: string | undefined;
    readonly isError?: boolean | undefined;
  };
}): StewardChatEntry[] {
  const createdAt = new Date(record.message.timestamp).toISOString();
  const baseId = `${record.executionId}:${record.sequence}`;
  if (record.message.role === "user") {
    return [
      {
        id: baseId,
        role: "user",
        content: visibleUserMessage(messageText(record.message.content)),
        createdAt,
      },
    ];
  }
  if (record.message.role === "assistant" && Array.isArray(record.message.content)) {
    return record.message.content.flatMap((item, index): StewardChatEntry[] => {
      const value = item as {
        type?: unknown;
        text?: unknown;
        thinking?: unknown;
        id?: unknown;
        name?: unknown;
      };
      if (value.type === "text" && typeof value.text === "string") {
        return [
          { id: `${baseId}:${index}`, role: "assistant" as const, content: value.text, createdAt },
        ];
      }
      if (value.type === "thinking" && typeof value.thinking === "string") {
        return [
          {
            id: `${baseId}:${index}`,
            role: "thinking" as const,
            content: value.thinking,
            createdAt,
          },
        ];
      }
      if (
        value.type === "toolCall" &&
        typeof value.id === "string" &&
        typeof value.name === "string"
      ) {
        return [
          {
            id: `${baseId}:${index}`,
            role: "tool" as const,
            toolName: value.name,
            toolCallId: value.id,
            toolStatus: "running",
            content: "Running",
            createdAt,
          },
        ];
      }
      return [];
    });
  }
  if (record.message.role === "toolResult") {
    return [
      {
        id: baseId,
        role: "tool",
        toolName: record.message.toolName ?? "tool",
        ...(record.message.toolCallId === undefined
          ? {}
          : { toolCallId: record.message.toolCallId }),
        toolStatus: record.message.isError === true ? "failed" : "succeeded",
        content: messageText(record.message.content),
        isError: record.message.isError ?? false,
        createdAt,
      },
    ];
  }
  return [];
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      const value = item as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n");
}

function visibleUserMessage(content: string): string {
  if (!content.startsWith("[Pragma Home context]\n")) return content;
  const end = content.indexOf("\n[/Pragma Home context]\n");
  return end < 0 ? content : content.slice(end + "\n[/Pragma Home context]\n".length).trimStart();
}

function formatHumanAnswers(answers: unknown): string {
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    return String(answers);
  }
  return Object.entries(answers as Record<string, unknown>)
    .map(([question, answer]) => {
      const value = Array.isArray(answer) ? answer.join(", ") : String(answer);
      return `${question}\n${value}`;
    })
    .join("\n\n");
}
