import { AgentMessageUsageSchema, type AgentMessage, type AgentMessageUsage } from "@pragma/shared";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CodexAppServerClient, CodexAppServerNotification } from "./app-server-client.ts";
import type {
  ExpertAgentStartupMessage,
  RuntimeEventMappingContext,
  RuntimeEventMappingResult,
  RuntimeStreamEventInput,
  RuntimeTurnContext,
  RuntimeTurnResult,
} from "@pragma/core";
import {
  createUsageFromTokenCounts,
  hasNonZeroUsage,
  readFirstTokenCount,
} from "@pragma/core";
import type { CodexRuntimeMessage } from "./types.ts";
import type { CodexUserInput } from "./types.ts";

export type CodexNotificationSubscriber = (notification: CodexAppServerNotification) => void;

export interface CodexNotificationBus {
  readonly publish: (notification: CodexAppServerNotification) => void;
  readonly subscribe: (subscriber: CodexNotificationSubscriber) => () => void;
}

export interface CodexRuntimeSessionState {
  threadId: string;
}

export interface CodexNativeSession {
  readonly client: CodexAppServerClient;
  readonly notificationBus: CodexNotificationBus;
  readonly state: CodexRuntimeSessionState;
  readonly messages: CodexRuntimeMessage[];
  readonly defaultModelName?: string | undefined;
  readonly codexHome?: string | undefined;
  pendingStartupMessages: readonly ExpertAgentStartupMessage[];
}

const CODEX_TOOL_ITEM_NAMES = {
  commandExecution: "exec_command",
  fileChange: "apply_patch",
  mcpToolCall: "mcp_tool_call",
} as const satisfies Record<string, string>;

export function createCodexNotificationBus(): CodexNotificationBus {
  const subscribers = new Set<CodexNotificationSubscriber>();

  return {
    publish(notification) {
      for (const subscriber of subscribers) {
        subscriber(notification);
      }
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
  };
}

export function createCodexNativeSession(options: {
  readonly client: CodexAppServerClient;
  readonly notificationBus: CodexNotificationBus;
  readonly state: CodexRuntimeSessionState;
  readonly defaultModelName?: string | undefined;
  readonly codexHome?: string | undefined;
  readonly startupMessages?: readonly ExpertAgentStartupMessage[] | undefined;
}): CodexNativeSession {
  return {
    client: options.client,
    notificationBus: options.notificationBus,
    state: options.state,
    messages: [],
    defaultModelName: options.defaultModelName,
    codexHome: options.codexHome,
    pendingStartupMessages: options.startupMessages ?? [],
  };
}

export function listCodexMessages(session: CodexNativeSession): readonly AgentMessage[] {
  return convertCodexMessages(session.messages, session.defaultModelName);
}

export function consumeCodexStartupMessages(session: CodexNativeSession): readonly ExpertAgentStartupMessage[] {
  const startupMessages = session.pendingStartupMessages;
  session.pendingStartupMessages = [];

  if (startupMessages.length > 0) {
    const timestamp = Date.now();
    session.messages.push(
      ...startupMessages.map((message, index) => ({
        role: message.role,
        content: message.content,
        timestamp: timestamp + index,
      })),
    );
  }

  return startupMessages;
}

export async function startCodexTurn(
  session: CodexNativeSession,
  turn: RuntimeTurnContext<CodexAppServerNotification>,
): Promise<RuntimeTurnResult> {
  let outputText = "";
  let assistantUsage: AgentMessageUsage | undefined;
  const observer = createTurnObserver({
    onOutputText(text) {
      outputText = text;
    },
    onUsage(usage) {
      assistantUsage = usage;
    },
    onNotification(notification) {
      turn.stream.writeNative(notification);
    },
  });
  const unsubscribe = session.notificationBus.subscribe(observer.handleNotification);

  session.messages.push({
    role: "user",
    content: turn.rawQuery,
    timestamp: Date.now(),
  });

  try {
    await session.client.startTurn({
      threadId: session.state.threadId,
      model: turn.modelName,
      input: createTextInputList(
        ...turn.startupMessages.map((message) => message.content),
        turn.prompt,
      ),
    });
    await observer.completed;
  } finally {
    unsubscribe();
  }

  session.messages.push({
    role: "assistant",
    content: outputText,
    timestamp: Date.now(),
    details: assistantUsage,
  });

  return {
    outputText,
    runtimeSessionId: session.state.threadId,
  };
}

export function mapCodexNotificationToRuntimeEvent(
  notification: CodexAppServerNotification,
  context: RuntimeEventMappingContext,
): RuntimeEventMappingResult {
  const events: RuntimeStreamEventInput[] = [];
  let outputDelta: string | undefined;
  let completedText: string | undefined;
  let usage: AgentMessageUsage | undefined;
  const delta = readAssistantDelta(notification);

  if (delta !== undefined) {
    outputDelta = delta;
    events.push(context.events.messageDelta(delta));
  }

  const completed = readCompletedAssistantText(notification);
  if (completed !== undefined) {
    completedText = completed;
    events.push(context.events.messageCompleted(completed));
  }

  const toolEvent = readToolEvent(notification);
  if (toolEvent !== undefined) {
    events.push(
      toolEvent.completed
        ? context.events.toolCompleted({
            toolCallId: toolEvent.id,
            toolName: toolEvent.name,
            outputPreview: toolEvent.preview,
          })
        : context.events.toolStarted({
            toolCallId: toolEvent.id,
            toolName: toolEvent.name,
            inputPreview: toolEvent.preview,
          }),
    );
  }

  if (notification.method === "turn/started" || notification.method === "thread/started") {
    events.push(context.events.progress(notification.method, notification.params));
  }

  if (notification.method === "turn/completed") {
    usage = readUsage(notification.params);
  }

  return {
    events,
    ...(outputDelta === undefined ? {} : { outputDelta }),
    ...(completedText === undefined ? {} : { completedText }),
    ...(usage === undefined ? {} : { usage }),
  };
}

export async function collectCodexUsage(
  session: CodexNativeSession,
  startedAt: Date,
  currentUsage: AgentMessageUsage | undefined,
): Promise<AgentMessageUsage | undefined> {
  if (hasNonZeroUsage(currentUsage)) {
    return currentUsage;
  }

  return await scanCodexSessionUsage({
    codexHome: session.codexHome,
    startTime: startedAt,
  });
}

function createTurnObserver({
  onNotification,
  onOutputText,
  onUsage,
}: {
  readonly onNotification: (notification: CodexAppServerNotification) => void;
  readonly onOutputText: (text: string) => void;
  readonly onUsage: (usage: AgentMessageUsage | undefined) => void;
}): {
  readonly completed: Promise<void>;
  readonly handleNotification: CodexNotificationSubscriber;
} {
  let outputText = "";
  let resolved = false;
  let resolveCompleted: () => void = () => undefined;
  let rejectCompleted: (error: Error) => void = () => undefined;
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });

  return {
    completed,
    handleNotification(notification) {
      if (resolved) {
        return;
      }

      onNotification(notification);

      const delta = readAssistantDelta(notification);
      if (delta !== undefined) {
        outputText += delta;
        onOutputText(outputText);
      }

      const completedText = readCompletedAssistantText(notification);
      if (completedText !== undefined) {
        outputText = completedText;
        onOutputText(outputText);
      }

      if (notification.method === "turn/completed") {
        resolved = true;
        onUsage(readUsage(notification.params));
        resolveCompleted();
        return;
      }

      if (notification.method === "turn/failed") {
        resolved = true;
        rejectCompleted(new Error(readFailureMessage(notification.params)));
      }
    },
  };
}

function readAssistantDelta(notification: CodexAppServerNotification): string | undefined {
  if (notification.method !== "item/agentMessage/delta") {
    return undefined;
  }

  const candidates = [
    notification.params["delta"],
    readRecord(notification.params["delta"])?.["text"],
    notification.params["text"],
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "") {
      return candidate;
    }
  }

  return undefined;
}

function readCompletedAssistantText(notification: CodexAppServerNotification): string | undefined {
  if (notification.method !== "item/completed") {
    return undefined;
  }

  const item = readRecord(notification.params["item"]);

  if (item?.["type"] !== "agentMessage") {
    return undefined;
  }

  const text = item["text"];
  return typeof text === "string" ? text : undefined;
}

function readToolEvent(notification: CodexAppServerNotification):
  | {
      readonly id: string;
      readonly name: string;
      readonly preview: unknown;
      readonly completed: boolean;
    }
  | undefined {
  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return undefined;
  }

  const item = readRecord(notification.params["item"]);
  const id = readString(item?.["id"]) ?? randomUUID();
  const type = readString(item?.["type"]);
  const name = type === undefined ? undefined : codexItemTypeToToolName(type);

  if (name === undefined) {
    return undefined;
  }

  return {
    id,
    name,
    preview: item,
    completed: notification.method === "item/completed",
  };
}

function codexItemTypeToToolName(type: string): string | undefined {
  return CODEX_TOOL_ITEM_NAMES[type as keyof typeof CODEX_TOOL_ITEM_NAMES];
}

function readUsage(params: Record<string, unknown>): AgentMessageUsage | undefined {
  const sources = [params, readRecord(params["turn"])].filter(
    (source): source is Record<string, unknown> => source !== undefined,
  );

  for (const source of sources) {
    const usage = readUsageFromRecord(source);

    if (usage !== undefined) {
      return usage;
    }
  }

  return undefined;
}

function readUsageFromRecord(record: Record<string, unknown>): AgentMessageUsage | undefined {
  for (const key of ["usage", "token_usage", "tokens"]) {
    const usage = readRecord(record[key]);

    if (usage === undefined) {
      continue;
    }

    const parsed = createUsageFromCodexTokenRecord(usage);

    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function createUsageFromCodexTokenRecord(
  record: Record<string, unknown>,
): AgentMessageUsage | undefined {
  const inputTokens = readFirstTokenCount(record, ["input_tokens", "input", "prompt_tokens"]);
  const cacheReadTokens = readFirstTokenCount(record, [
    "cached_input_tokens",
    "cache_read_tokens",
    "cache_read_input_tokens",
  ]);
  const outputTokens = readFirstTokenCount(record, [
    "output_tokens",
    "output",
    "completion_tokens",
  ]);
  const reasoningOutputTokens = readFirstTokenCount(record, ["reasoning_output_tokens"]);
  const cacheWriteTokens = readFirstTokenCount(record, [
    "cache_write_tokens",
    "cache_creation_input_tokens",
  ]);

  if (
    inputTokens === undefined &&
    cacheReadTokens === undefined &&
    outputTokens === undefined &&
    reasoningOutputTokens === undefined &&
    cacheWriteTokens === undefined
  ) {
    return undefined;
  }

  return createUsageFromTokenCounts({
    inputTokens: inputTokens ?? 0,
    outputTokens: (outputTokens ?? 0) + (reasoningOutputTokens ?? 0),
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
  });
}

async function scanCodexSessionUsage({
  codexHome,
  startTime,
}: {
  readonly codexHome?: string | undefined;
  readonly startTime: Date;
}): Promise<AgentMessageUsage | undefined> {
  const root = await findCodexSessionRoot(codexHome);

  if (root === undefined) {
    return undefined;
  }

  const dateDir = join(
    root,
    String(startTime.getFullYear()).padStart(4, "0"),
    String(startTime.getMonth() + 1).padStart(2, "0"),
    String(startTime.getDate()).padStart(2, "0"),
  );
  const entries = await readdir(dateDir).catch(() => []);
  const candidates = [];

  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) {
      continue;
    }

    const path = join(dateDir, entry);
    const info = await stat(path).catch(() => undefined);

    if (info === undefined || info.mtime < startTime) {
      continue;
    }

    candidates.push({ path, mtime: info.mtime.getTime() });
  }

  candidates.sort((left, right) => left.mtime - right.mtime || left.path.localeCompare(right.path));

  let result: AgentMessageUsage | undefined;

  for (const candidate of candidates) {
    result = (await parseCodexSessionUsageFile(candidate.path)) ?? result;
  }

  return hasNonZeroUsage(result) ? result : undefined;
}

async function findCodexSessionRoot(codexHome: string | undefined): Promise<string | undefined> {
  const roots = [
    codexHome === undefined || codexHome.trim() === "" ? undefined : join(codexHome, "sessions"),
    process.env.CODEX_HOME === undefined || process.env.CODEX_HOME.trim() === ""
      ? undefined
      : join(process.env.CODEX_HOME, "sessions"),
    join(homedir(), ".codex", "sessions"),
  ];

  for (const root of roots) {
    if (root === undefined) {
      continue;
    }

    const info = await stat(root).catch(() => undefined);

    if (info?.isDirectory() === true) {
      return root;
    }
  }

  return undefined;
}

async function parseCodexSessionUsageFile(path: string): Promise<AgentMessageUsage | undefined> {
  const content = await readFile(path, "utf8").catch(() => undefined);

  if (content === undefined) {
    return undefined;
  }

  let result: AgentMessageUsage | undefined;

  for (const line of content.split("\n")) {
    if (!line.includes("token_count") && !line.includes("turn_context")) {
      continue;
    }

    const event = parseJsonRecord(line);
    const payload = readRecord(event?.["payload"]);

    if (payload?.["type"] !== "token_count") {
      continue;
    }

    const info = readRecord(payload["info"]);
    const tokenUsage =
      readRecord(info?.["total_token_usage"]) ?? readRecord(info?.["last_token_usage"]);
    const usage =
      tokenUsage === undefined ? undefined : createUsageFromCodexTokenRecord(tokenUsage);

    if (usage !== undefined) {
      result = usage;
    }
  }

  return result;
}

function convertCodexMessages(
  messages: readonly CodexRuntimeMessage[],
  modelName: string | undefined,
): readonly AgentMessage[] {
  return messages.map((message): AgentMessage => {
    if (message.role === "user") {
      return {
        role: "user",
        content: message.content,
        timestamp: message.timestamp,
      };
    }

    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: [{ type: "text", text: message.content }],
        api: "codex-app-server",
        provider: "openai",
        model: modelName ?? "codex",
        usage: readAgentMessageUsage(message.details),
        stopReason: "stop",
        timestamp: message.timestamp,
      };
    }

    return {
      role: "custom",
      customType: "codex.runtime",
      content: message.content,
      display: false,
      details: message.details,
      timestamp: message.timestamp,
    };
  });
}

function readAgentMessageUsage(value: unknown): AgentMessageUsage {
  const result = AgentMessageUsageSchema.safeParse(value);

  if (result.success) {
    return result.data;
  }

  return createUsageFromTokenCounts({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}

function createTextInputList(...texts: readonly string[]): readonly CodexUserInput[] {
  return texts.map((text) => ({
    type: "text",
    text,
    text_elements: [],
  }));
}

function readFailureMessage(params: Record<string, unknown>): string {
  const error = readRecord(params["error"]);
  const candidates = [params["message"], error?.["message"], params["reason"]];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate;
    }
  }

  return "Codex turn failed.";
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    return readRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
