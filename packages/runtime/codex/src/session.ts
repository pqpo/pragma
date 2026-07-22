import { AgentMessageUsageSchema, type AgentMessage, type AgentMessageUsage } from "@pragma/shared";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
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
import { createUsageFromTokenCounts, hasNonZeroUsage, readFirstTokenCount } from "@pragma/core";
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
  readonly defaultThinkingLevel?: string | undefined;
  readonly codexHome?: string | undefined;
  readonly subagentThreads: Map<string, CodexSubagentThread>;
  pendingStartupMessages: readonly ExpertAgentStartupMessage[];
}

export interface CodexSubagentThread {
  readonly threadId: string;
  readonly parentThreadId: string;
  readonly displayName?: string | undefined;
  readonly role?: string | undefined;
}

export interface CodexRuntimeNotification {
  readonly rootThreadId: string;
  readonly notification: CodexAppServerNotification;
  readonly thread?: CodexSubagentThread | undefined;
}

const CODEX_TOOL_ITEM_NAMES = {
  commandExecution: "exec_command",
  dynamicToolCall: "dynamic_tool_call",
  fileChange: "apply_patch",
  mcpToolCall: "mcp_tool_call",
} as const satisfies Record<string, string>;
const CODEX_SESSION_USAGE_MTIME_TOLERANCE_MS = 5_000;

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
  readonly defaultThinkingLevel?: string | undefined;
  readonly codexHome?: string | undefined;
  readonly startupMessages?: readonly ExpertAgentStartupMessage[] | undefined;
}): CodexNativeSession {
  return {
    client: options.client,
    notificationBus: options.notificationBus,
    state: options.state,
    messages: [],
    defaultModelName: options.defaultModelName,
    defaultThinkingLevel: options.defaultThinkingLevel,
    codexHome: options.codexHome,
    subagentThreads: new Map(),
    pendingStartupMessages: options.startupMessages ?? [],
  };
}

export function listCodexMessages(session: CodexNativeSession): readonly AgentMessage[] {
  return convertCodexMessages(session.messages, session.defaultModelName);
}

export function consumeCodexStartupMessages(
  session: CodexNativeSession,
): readonly ExpertAgentStartupMessage[] {
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
  turn: RuntimeTurnContext<CodexRuntimeNotification>,
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
      rememberSubagentThread(session, notification);
      const threadId = readNotificationThreadId(notification);
      turn.stream.writeNative({
        rootThreadId: session.state.threadId,
        notification,
        ...(threadId === undefined || session.subagentThreads.get(threadId) === undefined
          ? {}
          : { thread: session.subagentThreads.get(threadId)! }),
      });
    },
    rootThreadId: session.state.threadId,
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
      model: turn.modelSelection?.model.modelId,
      thinkingLevel: turn.modelSelection?.thinkingLevel,
      input: createTextInputList(
        ...turn.startupMessages.map((message) => message.content),
        turn.prompt,
      ),
    });
    await observer.completed;
  } finally {
    unsubscribe();
  }

  if (outputText.trim() === "") {
    throw new Error(
      "Codex turn completed without assistant output. Verify Codex authentication and connectivity.",
    );
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
  input: CodexRuntimeNotification,
  context: RuntimeEventMappingContext,
): RuntimeEventMappingResult {
  const { notification, rootThreadId } = input;
  const events: RuntimeStreamEventInput[] = [];
  let outputDelta: string | undefined;
  let completedText: string | undefined;
  let usage: AgentMessageUsage | undefined;
  const threadId = readNotificationThreadId(notification) ?? rootThreadId;
  const turnId = readNotificationTurnId(notification);
  const nested = threadId !== rootThreadId;
  const runId = nested ? (turnId ?? threadId) : context.runId;
  const source = createCodexEventSource(input, context, threadId, runId);
  const frame = (event: RuntimeStreamEventInput): RuntimeStreamEventInput => ({
    ...event,
    runId,
    ...(nested ? { parentRunId: context.runId } : {}),
    source,
  });
  const delta = readAssistantDelta(notification);

  if (delta !== undefined) {
    if (!nested) outputDelta = delta;
    events.push(frame(context.events.messageDelta(delta)));
  }

  const thoughtDelta = readThoughtDelta(notification);
  if (thoughtDelta !== undefined) events.push(frame(context.events.thoughtDelta(thoughtDelta)));

  const completed = readCompletedAssistantText(notification);
  if (completed !== undefined) {
    if (!nested) completedText = completed;
    events.push(frame(context.events.messageCompleted(completed)));
  }

  const agentCommand = readAgentCommand(notification, source, runId, context.runId);
  if (agentCommand !== undefined) events.push(agentCommand);

  const toolEvent = agentCommand === undefined ? readToolEvent(notification) : undefined;
  if (toolEvent !== undefined) {
    events.push(
      frame(
        toolEvent.failed
          ? context.events.toolFailed({
              toolCallId: toolEvent.id,
              toolName: toolEvent.name,
              message: toolEvent.failureMessage,
            })
          : toolEvent.completed
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
      ),
    );
  }

  if (nested && notification.method === "turn/started") {
    events.push({
      runId,
      parentRunId: context.runId,
      source,
      type: "run.started",
      payload: { task: readTurnTask(notification) ?? "Subagent task" },
    });
  } else if (nested && notification.method === "turn/completed") {
    const status = readTurnStatus(notification);
    events.push(
      status === "failed"
        ? {
            runId,
            parentRunId: context.runId,
            source,
            type: "run.failed",
            payload: { message: readFailureMessage(notification.params) },
          }
        : status === "interrupted"
          ? {
              runId,
              parentRunId: context.runId,
              source,
              type: "run.cancelled",
              payload: { reason: "Subagent turn interrupted." },
            }
          : {
              runId,
              parentRunId: context.runId,
              source,
              type: "run.completed",
              payload: {},
            },
    );
  } else if (
    nested &&
    (notification.method === "thread/started" ||
      notification.method === "thread/status/changed" ||
      isSubagentActivity(notification))
  ) {
    events.push(frame(context.events.progress(notification.method, notification.params)));
  } else if (notification.method === "turn/started" || notification.method === "thread/started") {
    events.push(frame(context.events.progress(notification.method, notification.params)));
  }

  if (
    notification.method === "thread/tokenUsage/updated" ||
    notification.method === "turn/completed"
  ) {
    if (!nested) usage = readUsage(notification.params);
  }

  return {
    events,
    ...(outputDelta === undefined ? {} : { outputDelta }),
    ...(completedText === undefined ? {} : { completedText }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function createCodexEventSource(
  input: CodexRuntimeNotification,
  context: RuntimeEventMappingContext,
  threadId: string,
  runId: string,
): RuntimeStreamEventInput["source"] {
  if (threadId === input.rootThreadId) {
    return {
      ...context.source,
      runId: context.runId,
      sessionId: input.rootThreadId,
    };
  }
  const thread = input.thread;
  const displayName = thread?.displayName ?? thread?.role;
  return {
    kind: "agent",
    runId,
    parentRunId: context.runId,
    sessionId: threadId,
    parentSessionId: thread?.parentThreadId ?? input.rootThreadId,
    agentId: threadId,
    agentType: "codex-subagent",
    ...(displayName === undefined ? {} : { displayName }),
    path: [
      ...context.source.path,
      {
        runId,
        agentId: threadId,
        agentType: "codex-subagent",
        ...(displayName === undefined ? {} : { displayName }),
      },
    ],
  };
}

function readAgentCommand(
  notification: CodexAppServerNotification,
  source: RuntimeStreamEventInput["source"],
  runId: string,
  parentRunId: string,
): RuntimeStreamEventInput | undefined {
  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return undefined;
  }
  const item = readRecord(notification.params["item"]);
  const type = readString(item?.["type"]);
  const nativeTool = type === "collabAgentToolCall" ? readString(item?.["tool"]) : undefined;
  const genericTool =
    type === "dynamicToolCall" || type === "mcpToolCall" ? readString(item?.["tool"]) : undefined;
  const action = readAgentCommandAction(nativeTool ?? genericTool);
  if (action === undefined) return undefined;
  const status = readString(item?.["status"]);
  const failed = status === "failed" || item?.["success"] === false;
  const phase =
    notification.method === "item/started" ? "started" : failed ? "failed" : "completed";
  const senderSessionId = readString(item?.["senderThreadId"]) ?? source.sessionId;
  const receivers = item?.["receiverThreadIds"];
  const targetSessionIds = Array.isArray(receivers)
    ? receivers.filter((value): value is string => typeof value === "string" && value !== "")
    : [];
  const states = readRecord(item?.["agentsStates"]);
  const commandId = readString(item?.["id"]) ?? randomUUID();
  return {
    runId,
    ...(source.parentSessionId === undefined ? {} : { parentRunId }),
    source,
    type: "agent.command",
    payload: {
      commandId,
      action,
      phase,
      ...(senderSessionId === undefined ? {} : { senderSessionId }),
      targetSessionIds,
      ...(typeof item?.["prompt"] === "string" ? { prompt: item["prompt"] } : {}),
      ...(states === undefined ? {} : { states }),
      ...(phase !== "failed"
        ? {}
        : { error: readToolFailureMessage(item, nativeTool ?? genericTool ?? action) }),
    },
  };
}

function readAgentCommandAction(
  value: string | undefined,
): "spawn" | "wait" | "list" | "send" | "resume" | "interrupt" | undefined {
  if (value === undefined) return undefined;
  const segment = value.split(/[./:]/u).at(-1);
  switch (segment) {
    case "spawnAgent":
    case "spawn_agent":
      return "spawn";
    case "wait":
    case "wait_agent":
    case "wait_agents":
      return "wait";
    case "list_agents":
    case "list_experts":
      return "list";
    case "sendInput":
    case "send_message":
    case "followup_expert":
      return "send";
    case "resumeAgent":
    case "resume_agent":
      return "resume";
    case "closeAgent":
    case "interrupt_agent":
    case "interrupt_expert":
      return "interrupt";
    default:
      return undefined;
  }
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
  rootThreadId,
}: {
  readonly onNotification: (notification: CodexAppServerNotification) => void;
  readonly onOutputText: (text: string) => void;
  readonly onUsage: (usage: AgentMessageUsage | undefined) => void;
  readonly rootThreadId: string;
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

      const notificationThreadId = readNotificationThreadId(notification);
      if (notificationThreadId !== undefined && notificationThreadId !== rootThreadId) return;

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

      if (notification.method === "thread/tokenUsage/updated") {
        const usage = readUsage(notification.params);

        if (usage !== undefined) {
          onUsage(usage);
        }
      }

      if (notification.method === "turn/completed") {
        resolved = true;
        const usage = readUsage(notification.params);

        if (usage !== undefined) {
          onUsage(usage);
        }
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

function rememberSubagentThread(
  session: CodexNativeSession,
  notification: CodexAppServerNotification,
): void {
  if (notification.method !== "thread/started") return;
  const thread = readRecord(notification.params["thread"]);
  const threadId = readString(thread?.["id"]);
  const parentThreadId = readString(thread?.["parentThreadId"]);
  if (threadId === undefined || parentThreadId === undefined) return;
  const nickname = readString(thread?.["agentNickname"]);
  const role = readString(thread?.["agentRole"]);
  session.subagentThreads.set(threadId, {
    threadId,
    parentThreadId,
    ...(nickname === undefined ? {} : { displayName: nickname }),
    ...(role === undefined ? {} : { role }),
  });
}

function readNotificationThreadId(notification: CodexAppServerNotification): string | undefined {
  const direct = readString(notification.params["threadId"]);
  if (direct !== undefined) return direct;
  const thread = readRecord(notification.params["thread"]);
  return readString(thread?.["id"]);
}

function readNotificationTurnId(notification: CodexAppServerNotification): string | undefined {
  const direct = readString(notification.params["turnId"]);
  if (direct !== undefined) return direct;
  return readString(readRecord(notification.params["turn"])?.["id"]);
}

function readThoughtDelta(notification: CodexAppServerNotification): string | undefined {
  if (
    notification.method !== "item/reasoning/textDelta" &&
    notification.method !== "item/reasoning/summaryTextDelta"
  ) {
    return undefined;
  }
  return readString(notification.params["delta"]);
}

function readTurnTask(notification: CodexAppServerNotification): string | undefined {
  const turn = readRecord(notification.params["turn"]);
  const items = turn?.["items"];
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    const record = readRecord(item);
    if (record?.["type"] === "userMessage") {
      const text = readString(record["text"]);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

function readTurnStatus(
  notification: CodexAppServerNotification,
): "completed" | "failed" | "interrupted" {
  const status = readString(readRecord(notification.params["turn"])?.["status"]);
  if (status === "failed") return "failed";
  if (status === "interrupted" || status === "cancelled") return "interrupted";
  return "completed";
}

function isSubagentActivity(notification: CodexAppServerNotification): boolean {
  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return false;
  }
  return readRecord(notification.params["item"])?.["type"] === "subAgentActivity";
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
      readonly failed: boolean;
      readonly failureMessage: string;
    }
  | undefined {
  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return undefined;
  }

  const item = readRecord(notification.params["item"]);
  const id = readString(item?.["id"]) ?? randomUUID();
  const type = readString(item?.["type"]);
  const fallbackName = type === undefined ? undefined : codexItemTypeToToolName(type);
  const name =
    type === "mcpToolCall" || type === "dynamicToolCall"
      ? (readString(item?.["tool"]) ?? fallbackName)
      : fallbackName;

  if (name === undefined) {
    return undefined;
  }

  const completed = notification.method === "item/completed";
  const failed =
    completed &&
    (readString(item?.["status"]) === "failed" ||
      item?.["success"] === false ||
      readRecord(item?.["error"]) !== undefined);

  return {
    id,
    name,
    preview: item,
    completed,
    failed,
    failureMessage: readToolFailureMessage(item, name),
  };
}

function readToolFailureMessage(item: Record<string, unknown> | undefined, name: string): string {
  const error = readRecord(item?.["error"]);
  const directMessage = readString(error?.["message"]) ?? readString(item?.["message"]);

  if (directMessage !== undefined && directMessage !== "") {
    return directMessage;
  }

  const contentItems = item?.["contentItems"];
  if (Array.isArray(contentItems)) {
    for (const contentItem of contentItems) {
      const text = readString(readRecord(contentItem)?.["text"]);
      if (text !== undefined && text !== "") {
        return text;
      }
    }
  }

  return `${name} failed.`;
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
  for (const key of ["usage", "token_usage", "tokenUsage", "tokens"]) {
    const usage = readRecord(record[key]);

    if (usage === undefined) {
      continue;
    }

    const parsed = createUsageFromCodexTokenUsageRecord(usage);

    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function createUsageFromCodexTokenUsageRecord(
  record: Record<string, unknown>,
): AgentMessageUsage | undefined {
  const lastUsage = readRecord(record["last"]) ?? readRecord(record["last_token_usage"]);
  const totalUsage = readRecord(record["total"]) ?? readRecord(record["total_token_usage"]);

  if (lastUsage !== undefined || totalUsage !== undefined) {
    // See docs/conventions/runtime-usage-accounting.md: Codex total usage is thread-cumulative.
    return createUsageFromCodexTokenRecord(lastUsage ?? totalUsage ?? {});
  }

  return createUsageFromCodexTokenRecord(record);
}

function createUsageFromCodexTokenRecord(
  record: Record<string, unknown>,
): AgentMessageUsage | undefined {
  const inputTokens = readFirstTokenCount(record, [
    "input_tokens",
    "inputTokens",
    "input",
    "prompt_tokens",
    "promptTokens",
  ]);
  const cacheReadTokens = readFirstTokenCount(record, [
    "cached_input_tokens",
    "cachedInputTokens",
    "cache_read_tokens",
    "cacheReadTokens",
    "cache_read_input_tokens",
  ]);
  const outputTokens = readFirstTokenCount(record, [
    "output_tokens",
    "outputTokens",
    "output",
    "completion_tokens",
    "completionTokens",
  ]);
  const reasoningOutputTokens = readFirstTokenCount(record, [
    "reasoning_output_tokens",
    "reasoningOutputTokens",
  ]);
  const cacheWriteTokens = readFirstTokenCount(record, [
    "cache_write_tokens",
    "cacheWriteTokens",
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
    inputTokensIncludeCacheRead: true,
    outputTokens: outputTokens ?? 0,
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

    if (
      info === undefined ||
      info.mtime.getTime() + CODEX_SESSION_USAGE_MTIME_TOLERANCE_MS < startTime.getTime()
    ) {
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
  if (codexHome === undefined || codexHome.trim() === "") {
    return undefined;
  }

  const root = join(codexHome, "sessions");
  return (await stat(root).catch(() => undefined))?.isDirectory() === true ? root : undefined;
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
    // Prefer per-turn usage; total_token_usage is cumulative for resumed/multi-turn threads.
    // See docs/conventions/runtime-usage-accounting.md.
    const tokenUsage =
      readRecord(info?.["last_token_usage"]) ?? readRecord(info?.["total_token_usage"]);
    const usage =
      tokenUsage === undefined ? undefined : createUsageFromCodexTokenUsageRecord(tokenUsage);

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
    inputTokensIncludeCacheRead: true,
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
