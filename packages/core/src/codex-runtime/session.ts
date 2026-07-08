import {
  AgentMessageUsageSchema,
  type AgentMessage,
  type AgentMessageUsage,
} from "@pragma/shared";
import { randomUUID } from "node:crypto";

import type { CodexAppServerClient, CodexAppServerNotification } from "./app-server-client.ts";
import type {
  RuntimeAgentSession,
  RuntimeOutputSchema,
  RuntimeRunResult,
  RuntimeSessionInfo,
  RuntimeSubmitRequest,
} from "../runtime/runtime-adapter.ts";
import type { AgentLifecycle } from "../runtime/agent-lifecycle.ts";
import type { ExpertAgentRunContext } from "../runtime/run-context.ts";
import type { RuntimeStreamEvent } from "../runtime/stream-events.ts";
import type { RuntimeStreamEventInput } from "../runtime/runtime-event-emitter.ts";
import type { ExpertAgent } from "../agent/expert-agent.ts";
import type { ExpertAgentLogger } from "../logging/logger.ts";
import {
  AsyncPushQueue,
} from "../runtime/async-push-queue.ts";
import {
  createRuntimeEventEmitter,
} from "../runtime/runtime-event-emitter.ts";
import {
  dispatchExpertAgentHook,
} from "../plugins/expert-agent-plugin.ts";
import type { CodexRuntimeMessage, CodexTokenUsage } from "./types.ts";

export type CodexNotificationSubscriber = (notification: CodexAppServerNotification) => void;

export interface CodexNotificationBus {
  readonly subscribe: (subscriber: CodexNotificationSubscriber) => () => void;
}

export interface CodexRuntimeSessionState {
  threadId: string;
}

export function createCodexRuntimeSession({
  agent,
  client,
  info,
  lifecycle,
  logger,
  notificationBus,
  state,
  defaultModelName,
  outputRetryLimit,
}: {
  readonly agent: ExpertAgent;
  readonly client: CodexAppServerClient;
  readonly info: Omit<RuntimeSessionInfo, "sessionState" | "runState">;
  readonly lifecycle: AgentLifecycle<ExpertAgentRunContext | undefined>;
  readonly logger: ExpertAgentLogger;
  readonly notificationBus: CodexNotificationBus;
  readonly state: CodexRuntimeSessionState;
  readonly defaultModelName?: string | undefined;
  readonly outputRetryLimit?: number | undefined;
}): RuntimeAgentSession {
  const messages: CodexRuntimeMessage[] = [];

  return {
    info: () => ({
      ...info,
      runtimeSession: {
        type: info.runtimeSession.type,
        id: state.threadId,
      },
      sessionState: lifecycle.sessionState,
      runState: lifecycle.runState,
    }),
    messages: () => convertCodexMessages(messages, defaultModelName),
    submit<TSubmitOutput = string>(submission: RuntimeSubmitRequest<TSubmitOutput>) {
      const runId = submission.runId ?? randomUUID();
      const queue = new AsyncPushQueue<RuntimeStreamEvent>();
      const emitter = createRuntimeEventEmitter(queue);
      const pendingHookCalls: Promise<void>[] = [];
      let cancelled = false;

      const result = lifecycle.enqueue(async ({ signal }) => {
        const source = {
          kind: "agent" as const,
          runId,
          agentId: agent.id,
          displayName: agent.name,
          path: [],
        };
        let emittedSequence = 0;
        const emitRuntimeEvent = (event: RuntimeStreamEventInput): void => {
          const completeEvent = {
            schemaVersion: "pragma.stream/v1",
            eventId: randomUUID(),
            emittedAt: new Date().toISOString(),
            sequence: emittedSequence++,
            ...event,
          } as RuntimeStreamEvent;
          emitter.emit(completeEvent);
          pendingHookCalls.push(
            dispatchExpertAgentHook(agent.hooks, "onStreamEvent", {
              agent,
              session: createSessionInfo(info, lifecycle, state.threadId),
              runId,
              event: completeEvent,
              context: lifecycle.currentContext,
              logger,
            }),
          );
        };

        await dispatchExpertAgentHook(agent.hooks, "beforeTaskSubmit", {
          agent,
          session: createSessionInfo(info, lifecycle, state.threadId),
          runId,
          submission,
          context: lifecycle.currentContext,
          logger,
        });

        emitRuntimeEvent({
          runId,
          source,
          type: "run.started",
          payload: {
            task: submission.query,
            inputSummary: summarizeInput(submission.query),
          },
        });

        messages.push({
          role: "user",
          content: submission.query,
          timestamp: Date.now(),
        });

        try {
          const maxAttempts =
            submission.output === undefined
              ? 1
              : normalizeOutputRetryLimit(submission.outputRetryLimit ?? outputRetryLimit) + 1;
          let outputText = "";
          let usage: AgentMessageUsage | undefined;
          let parseResult: ParseRuntimeOutputResult<TSubmitOutput> | undefined;

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            outputText = "";
            const turn = createTurnObserver({
              runId,
              source,
              emitRuntimeEvent,
              onOutputText(text) {
                outputText = text;
              },
              onUsage(nextUsage) {
                usage = nextUsage;
              },
            });
            const unsubscribe = notificationBus.subscribe(turn.handleNotification);

            try {
              await client.startTurn({
                threadId: state.threadId,
                model: submission.modelName,
                input:
                  attempt === 1
                    ? createInitialPrompt(submission.query, submission.output)
                    : createOutputRetryPrompt(parseResult),
              });
              await turn.completed;
            } finally {
              unsubscribe();
            }

            parseResult = parseRuntimeOutput(outputText, submission.output);

            if (parseResult.ok) {
              break;
            }

            if (attempt === maxAttempts) {
              throw parseResult.error;
            }
          }

          if (parseResult === undefined || !parseResult.ok) {
            throw new Error("Codex runtime output parsing did not complete.");
          }

          messages.push({
            role: "assistant",
            content: outputText,
            timestamp: Date.now(),
            details: usage,
          });
          const runResult = createRuntimeRunResult(runId, parseResult.value, usage);

          emitRuntimeEvent({
            runId,
            source,
            type: "run.completed",
            payload: usage === undefined ? {} : { usage },
          });
          await dispatchExpertAgentHook(agent.hooks, "afterTaskSubmit", {
            agent,
            session: createSessionInfo(info, lifecycle, state.threadId),
            runId,
            submission,
            result: runResult,
            context: lifecycle.currentContext,
            logger,
          });

          return runResult;
        } catch (error) {
          const wasCancelled = signal.aborted || cancelled;
          const message = error instanceof Error ? error.message : "Codex runtime run failed.";

          emitRuntimeEvent({
            runId,
            source,
            type: wasCancelled ? "run.cancelled" : "run.failed",
            payload: wasCancelled ? { reason: "cancelled" } : { message },
          });
          await dispatchExpertAgentHook(agent.hooks, "afterTaskSubmit", {
            agent,
            session: createSessionInfo(info, lifecycle, state.threadId),
            runId,
            submission,
            error,
            context: lifecycle.currentContext,
            logger,
          });
          throw error;
        } finally {
          await Promise.allSettled(pendingHookCalls);
          emitter.complete();
        }
      });

      return {
        runId,
        events: queue,
        result,
        async cancel() {
          cancelled = true;
          await client.interruptTurn(state.threadId).catch(() => undefined);
          await lifecycle.abort();
        },
      };
    },
    async abort() {
      await lifecycle.abort();
    },
  };
}

function createSessionInfo(
  info: Omit<RuntimeSessionInfo, "sessionState" | "runState">,
  lifecycle: AgentLifecycle,
  threadId: string,
): RuntimeSessionInfo {
  return {
    ...info,
    runtimeSession: {
      type: info.runtimeSession.type,
      id: threadId,
    },
    sessionState: lifecycle.sessionState,
    runState: lifecycle.runState,
  };
}

function createTurnObserver({
  runId,
  source,
  emitRuntimeEvent,
  onOutputText,
  onUsage,
}: {
  readonly runId: string;
  readonly source: RuntimeStreamEvent["source"];
  readonly emitRuntimeEvent: (event: RuntimeStreamEventInput) => void;
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

      const event = mapCodexNotificationToRuntimeEvent(notification, runId, source);

      if (event !== undefined) {
        emitRuntimeEvent(event);
      }

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

function mapCodexNotificationToRuntimeEvent(
  notification: CodexAppServerNotification,
  runId: string,
  source: RuntimeStreamEvent["source"],
): RuntimeStreamEventInput | undefined {
  const delta = readAssistantDelta(notification);

  if (delta !== undefined) {
    return {
      runId,
      source,
      type: "message.delta",
      payload: {
        role: "assistant",
        contentType: "text",
        delta,
      },
    };
  }

  const completedText = readCompletedAssistantText(notification);

  if (completedText !== undefined) {
    return {
      runId,
      source,
      type: "message.completed",
      payload: {
        role: "assistant",
        contentType: "text",
        text: completedText,
      },
    };
  }

  const toolEvent = readToolEvent(notification);

  if (toolEvent !== undefined) {
    return {
      runId,
      source,
      type: toolEvent.completed ? "tool.completed" : "tool.started",
      payload: {
        toolCallId: toolEvent.id,
        toolName: toolEvent.name,
        kind: "tool",
        ...(toolEvent.completed
          ? { outputPreview: toolEvent.preview }
          : { inputPreview: toolEvent.preview }),
      },
    };
  }

  if (notification.method === "turn/started" || notification.method === "thread/started") {
    return {
      runId,
      source,
      type: "progress",
      payload: {
        stage: notification.method,
        data: notification.params,
      },
    };
  }

  return undefined;
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

function readToolEvent(
  notification: CodexAppServerNotification,
): { readonly id: string; readonly name: string; readonly preview: unknown; readonly completed: boolean } | undefined {
  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return undefined;
  }

  const item = readRecord(notification.params["item"]);
  const id = readString(item?.["id"]) ?? randomUUID();
  const type = readString(item?.["type"]);

  if (type === undefined || type === "agentMessage" || type === "reasoning") {
    return undefined;
  }

  return {
    id,
    name: codexItemTypeToToolName(type),
    preview: item,
    completed: notification.method === "item/completed",
  };
}

function codexItemTypeToToolName(type: string): string {
  switch (type) {
    case "commandExecution":
      return "exec_command";
    case "fileChange":
      return "apply_patch";
    case "mcpToolCall":
      return "mcp_tool_call";
    default:
      return type;
  }
}

function readUsage(params: Record<string, unknown>): AgentMessageUsage | undefined {
  const usage = readRecord(params["usage"]);
  const input = readNumber(usage?.["input_tokens"]);
  const output = readNumber(usage?.["output_tokens"]);
  const cacheRead = readNumber(usage?.["cached_input_tokens"]);

  if (input === undefined && output === undefined && cacheRead === undefined) {
    return undefined;
  }

  return createUsage({
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cachedInputTokens: cacheRead ?? 0,
  });
}

function createUsage(usage: CodexTokenUsage): AgentMessageUsage {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cachedInputTokens,
    cacheWrite: 0,
    totalTokens: usage.inputTokens + usage.outputTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
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

function createRuntimeRunResult<TOutput>(
  runId: string,
  output: TOutput,
  usage: AgentMessageUsage | undefined,
): RuntimeRunResult<TOutput> {
  return {
    runId,
    result: {
      output,
      ...(usage === undefined ? {} : { usage }),
    },
  };
}

function parseRuntimeOutput<TOutput>(
  text: string,
  output: RuntimeOutputSchema<TOutput> | undefined,
): ParseRuntimeOutputResult<TOutput> {
  try {
    if (output === undefined) {
      return { ok: true, value: text as TOutput };
    }

    const json = tryParseJsonLike(text);
    return { ok: true, value: output.parse(json.ok ? json.value : text) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

type ParseRuntimeOutputResult<TOutput> =
  | { readonly ok: true; readonly value: TOutput }
  | { readonly ok: false; readonly error: Error };

function createInitialPrompt(
  query: string,
  output: RuntimeOutputSchema<unknown> | undefined,
): string {
  if (output === undefined) {
    return query;
  }

  return `${query}

Return the final answer as valid JSON only. Do not include Markdown fences, prose, comments, or any characters before or after the JSON value. The JSON value must satisfy the requested output schema.`;
}

function createOutputRetryPrompt(
  parseResult: ParseRuntimeOutputResult<unknown> | undefined,
): string {
  const message =
    parseResult !== undefined && !parseResult.ok
      ? parseResult.error.message
      : "The previous response could not be parsed.";

  return `The previous response did not satisfy the required JSON output format.

Parser error:
${message}

Reply again with valid JSON only. Do not include Markdown fences, prose, comments, or any characters before or after the JSON value.`;
}

function normalizeOutputRetryLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return 1;
  }

  return Math.trunc(value);
}

function tryParseJsonLike(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const trimmed = text.trim();
  const candidates = [trimmed, ...extractFencedCodeBlocks(trimmed)];
  const balanced = extractBalancedJsonValue(trimmed);

  if (balanced !== undefined) {
    candidates.push(balanced);
  }

  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch {
      continue;
    }
  }

  return { ok: false };
}

function extractFencedCodeBlocks(text: string): string[] {
  const matches = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g);
  return [...matches].map((match) => match[1] ?? "");
}

function extractBalancedJsonValue(text: string): string | undefined {
  const start = [...text].findIndex((char) => char === "{" || char === "[");

  if (start < 0) {
    return undefined;
  }

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);

  if (end <= start) {
    return undefined;
  }

  return text.slice(start, end + 1);
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

  return createUsage({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
}

function summarizeInput(input: string): string {
  const compact = input.replace(/\s+/g, " ").trim();
  return compact.length <= 160 ? compact : `${compact.slice(0, 157)}...`;
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

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
