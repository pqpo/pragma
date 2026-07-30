import type { AgentMessage, AgentMessageUsage, RuntimeContextWindowUsage } from "@pragma/shared";

import type { Expert } from "../agent/expert-agent.ts";
import type { PragmaLogger } from "../logging/logger.ts";
import { dispatchExpertAgentHook } from "../plugins/expert-agent-plugin.ts";
import type { RuntimeSessionInfo } from "./runtime-adapter.ts";
import type { ExpertAgentRunContext } from "./run-context.ts";
import { mergeUsage } from "./usage.ts";
import {
  createRuntimeEventEmitter,
  type RuntimeEventEmitter,
  type RuntimeStreamEventInput,
} from "./runtime-event-emitter.ts";
import type { RuntimeStreamEvent } from "./stream-events.ts";

export interface RuntimeStreamWriter<TNativeEvent> {
  readonly writeNative: (event: TNativeEvent) => void;
  readonly write: (event: RuntimeStreamEventInput) => void;
}

export interface RuntimeEventMappingContext {
  readonly runId: string;
  readonly source: RuntimeStreamEvent["source"];
  readonly events: RuntimeStreamEventFactory;
}

export interface RuntimeEventMappingResult {
  readonly events?: readonly RuntimeStreamEventInput[] | undefined;
  readonly outputDelta?: string | undefined;
  readonly completedText?: string | undefined;
  readonly usage?: AgentMessageUsage | undefined;
  readonly contextWindowUsage?: RuntimeContextWindowUsage | undefined;
  readonly runtimeSessionId?: string | undefined;
}

export interface RuntimeStreamEventFactory {
  readonly messageDelta: (delta: string, role?: "assistant" | "system") => RuntimeStreamEventInput;
  readonly messageCompleted: (
    message: string | AgentMessage,
    role?: "assistant" | "system",
  ) => RuntimeStreamEventInput;
  readonly thoughtDelta: (delta: string) => RuntimeStreamEventInput;
  readonly progress: (
    stage: string,
    data?: unknown,
    message?: string | undefined,
  ) => RuntimeStreamEventInput;
  readonly toolStarted: (input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly inputPreview?: unknown;
  }) => RuntimeStreamEventInput;
  readonly toolDelta: (input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly delta: string;
    readonly channel?: "stdout" | "stderr" | "message" | "data" | undefined;
  }) => RuntimeStreamEventInput;
  readonly toolCompleted: (input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly outputPreview?: unknown;
  }) => RuntimeStreamEventInput;
  readonly toolFailed: (input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly message: string;
  }) => RuntimeStreamEventInput;
}

export interface RuntimeStreamController<TNativeEvent> {
  readonly events: AsyncIterable<RuntimeStreamEvent>;
  readonly emitter: RuntimeEventEmitter;
  readonly source: RuntimeStreamEvent["source"];
  readonly writer: RuntimeStreamWriter<TNativeEvent>;
  readonly getOutputText: () => string;
  readonly getUsage: () => AgentMessageUsage | undefined;
  readonly getRuntimeSessionId: () => string | undefined;
  readonly resetCapture: () => void;
  readonly beginUsagePreview: (input: {
    readonly prompt: string;
    readonly startupMessages?: readonly string[] | undefined;
    readonly contextBaselineCalibrated?: boolean | undefined;
    readonly accumulatedUsage?: AgentMessageUsage | undefined;
    readonly contextWindow?: RuntimeContextWindowUsage | undefined;
  }) => void;
  readonly updateContextWindowUsage: (usage: RuntimeContextWindowUsage | undefined) => void;
  readonly updateUsage: (usage: AgentMessageUsage | undefined) => void;
  readonly flushTelemetry: (provisional: boolean) => void;
  readonly complete: () => Promise<void>;
}

export function createRuntimeStreamController<TNativeEvent>(options: {
  readonly agent: Expert;
  readonly queue: {
    readonly push: (event: RuntimeStreamEvent) => void;
    readonly close: () => void;
  } & AsyncIterable<RuntimeStreamEvent>;
  readonly runId: string;
  readonly source?: RuntimeStreamEvent["source"] | undefined;
  readonly session: () => RuntimeSessionInfo;
  readonly context?: ExpertAgentRunContext | undefined;
  readonly logger: PragmaLogger;
  readonly mapEvent: (
    event: TNativeEvent,
    context: RuntimeEventMappingContext,
  ) => RuntimeEventMappingResult;
}): RuntimeStreamController<TNativeEvent> {
  const emitter = createRuntimeEventEmitter(options.queue);
  const source =
    options.source ??
    ({
      kind: "agent",
      runId: options.runId,
      agentId: options.agent.id,
      path: [],
    } satisfies RuntimeStreamEvent["source"]);
  const eventFactory = createRuntimeStreamEventFactory(options.runId, source);
  const pendingHookCalls: Promise<void>[] = [];
  let outputText = "";
  let thoughtText = "";
  let usage: AgentMessageUsage | undefined;
  let accumulatedUsage: AgentMessageUsage | undefined;
  let estimatedInputTokens = 0;
  let estimatedContextInputTokens = 0;
  let contextBaselineCalibrated = false;
  let contextWindowBase: RuntimeContextWindowUsage | undefined;
  let contextWindowUsage: RuntimeContextWindowUsage | undefined;
  let runtimeSessionId: string | undefined;
  let latestUsagePreview: AgentMessageUsage | undefined;
  let latestContextWindowPreview: RuntimeContextWindowUsage | undefined;
  let lastUsageSignature = "";
  let lastContextWindowSignature = "";
  let telemetryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastTelemetryAt = 0;
  let telemetryFinalized = false;
  const streamStartedAt = performance.now();
  let firstNativeEventLogged = false;
  let firstReasoningDeltaLogged = false;
  let firstTextDeltaLogged = false;

  const emit = (event: RuntimeStreamEventInput): void => {
    const emitted = emitter.emit(event);
    pendingHookCalls.push(
      dispatchExpertAgentHook(options.agent.hooks, "onStreamEvent", {
        agent: options.agent,
        session: options.session(),
        runId: options.runId,
        event: emitted,
        context: options.context,
        logger: options.logger,
      }),
    );
  };

  const emitTelemetry = (provisional: boolean): void => {
    if (telemetryTimer !== undefined) {
      clearTimeout(telemetryTimer);
      telemetryTimer = undefined;
    }
    lastTelemetryAt = performance.now();
    if (!provisional) telemetryFinalized = true;
    if (latestUsagePreview !== undefined) {
      const signature = JSON.stringify(latestUsagePreview);
      if (signature !== lastUsageSignature || !provisional) {
        lastUsageSignature = signature;
        emit({
          runId: options.runId,
          source,
          type: "usage.updated",
          payload: { usage: latestUsagePreview, provisional },
        });
      }
    }
    if (latestContextWindowPreview !== undefined) {
      const signature = JSON.stringify(latestContextWindowPreview);
      if (signature !== lastContextWindowSignature || !provisional) {
        lastContextWindowSignature = signature;
        emit({
          runId: options.runId,
          source,
          type: "context-window.updated",
          payload: { usage: latestContextWindowPreview, provisional },
        });
      }
    }
  };

  const scheduleTelemetry = (): void => {
    const elapsed = performance.now() - lastTelemetryAt;
    if (lastTelemetryAt === 0 || elapsed >= 100) {
      emitTelemetry(true);
      return;
    }
    if (telemetryTimer !== undefined) return;
    telemetryTimer = setTimeout(() => emitTelemetry(true), Math.max(0, 100 - elapsed));
  };

  const updateUsagePreview = (): void => {
    const estimatedOutputTokens = estimateTokenCount(`${thoughtText}${outputText}`);
    const attemptUsage =
      usage ??
      createEstimatedUsage({
        input: estimatedInputTokens,
        output: estimatedOutputTokens,
      });
    latestUsagePreview = mergeUsage(accumulatedUsage, attemptUsage);
    const contextSource = contextWindowUsage ?? contextWindowBase;
    if (contextSource !== undefined) {
      const usedTokens =
        contextWindowUsage !== undefined
          ? contextWindowUsage.usedTokens
          : !contextBaselineCalibrated || contextSource.usedTokens === null
            ? null
            : contextSource.usedTokens + estimatedContextInputTokens + estimatedOutputTokens;
      latestContextWindowPreview = {
        usedTokens,
        contextWindowTokens: contextSource.contextWindowTokens,
        percent:
          usedTokens === null ? null : (usedTokens / contextSource.contextWindowTokens) * 100,
        measurement:
          contextWindowUsage === undefined ? "estimated" : contextWindowUsage.measurement,
        observedAt: new Date().toISOString(),
      };
    }
    scheduleTelemetry();
  };

  const applyMappingResult = (result: RuntimeEventMappingResult): void => {
    if (!firstReasoningDeltaLogged && containsReasoningDelta(result)) {
      firstReasoningDeltaLogged = true;
      options.logger.info(
        "runtime.first_reasoning_delta",
        "Runtime emitted its first reasoning delta",
        {
          runId: options.runId,
          elapsedMs: Math.round((performance.now() - streamStartedAt) * 100) / 100,
        },
      );
    }
    if (!firstTextDeltaLogged && containsTextDelta(result)) {
      firstTextDeltaLogged = true;
      options.logger.info("runtime.first_text_delta", "Runtime emitted its first text delta", {
        runId: options.runId,
        elapsedMs: Math.round((performance.now() - streamStartedAt) * 100) / 100,
      });
    }
    for (const event of result.events ?? []) {
      emit(event);
    }
    if (result.outputDelta !== undefined) {
      outputText += result.outputDelta;
    }
    if (result.completedText !== undefined) {
      outputText = result.completedText;
    }
    usage = result.usage ?? usage;
    contextWindowUsage = result.contextWindowUsage ?? contextWindowUsage;
    runtimeSessionId = result.runtimeSessionId ?? runtimeSessionId;
    for (const event of result.events ?? []) {
      if (
        event.type === "thought.delta" &&
        "delta" in event.payload &&
        typeof event.payload.delta === "string"
      ) {
        thoughtText += event.payload.delta;
      }
    }
    updateUsagePreview();
  };

  return {
    events: options.queue,
    emitter,
    source,
    writer: {
      writeNative(event) {
        if (!firstNativeEventLogged) {
          firstNativeEventLogged = true;
          options.logger.info(
            "runtime.first_protocol_event",
            "Runtime delivered its first native protocol event",
            {
              runId: options.runId,
              elapsedMs: Math.round((performance.now() - streamStartedAt) * 100) / 100,
            },
          );
        }
        applyMappingResult(
          options.mapEvent(event, {
            runId: options.runId,
            source,
            events: eventFactory,
          }),
        );
      },
      write(event) {
        emit(event);
        if (event.type === "message.delta" && "delta" in event.payload) {
          outputText += event.payload.delta;
          updateUsagePreview();
        } else if (event.type === "thought.delta" && "delta" in event.payload) {
          thoughtText += event.payload.delta;
          updateUsagePreview();
        } else if (event.type === "message.completed") {
          if ("text" in event.payload && typeof event.payload.text === "string") {
            outputText = event.payload.text;
          }
          if (
            "message" in event.payload &&
            typeof event.payload.message === "object" &&
            event.payload.message !== null &&
            event.payload.message.role === "assistant"
          ) {
            usage = event.payload.message.usage;
          }
          updateUsagePreview();
        }
      },
    },
    getOutputText: () => outputText,
    getUsage: () => usage,
    getRuntimeSessionId: () => runtimeSessionId,
    resetCapture() {
      outputText = "";
      thoughtText = "";
      usage = undefined;
      contextWindowUsage = undefined;
      runtimeSessionId = undefined;
    },
    beginUsagePreview(input) {
      accumulatedUsage = input.accumulatedUsage;
      const turnInput = [...(input.startupMessages ?? []), input.prompt].join("\n\n");
      estimatedInputTokens = estimateTokenCount(turnInput);
      estimatedContextInputTokens = estimatedInputTokens;
      contextBaselineCalibrated =
        input.contextBaselineCalibrated ??
        (input.contextWindow?.usedTokens !== null &&
          input.contextWindow?.usedTokens !== undefined &&
          input.contextWindow.usedTokens > 0);
      contextWindowBase = input.contextWindow;
      contextWindowUsage = undefined;
      updateUsagePreview();
    },
    updateContextWindowUsage(next) {
      if (next === undefined) return;
      contextWindowUsage = next;
      updateUsagePreview();
    },
    updateUsage(next) {
      if (next === undefined) return;
      latestUsagePreview = next;
      scheduleTelemetry();
    },
    flushTelemetry(provisional) {
      emitTelemetry(provisional);
    },
    async complete() {
      if (!telemetryFinalized) emitTelemetry(false);
      else if (telemetryTimer !== undefined) {
        clearTimeout(telemetryTimer);
        telemetryTimer = undefined;
      }
      await Promise.allSettled(pendingHookCalls);
      emitter.complete();
    },
  };
}

function estimateTokenCount(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

function createEstimatedUsage(input: { readonly input: number; readonly output: number }) {
  return {
    measurement: "estimated" as const,
    input: input.input,
    output: input.output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input.input + input.output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function containsTextDelta(result: RuntimeEventMappingResult): boolean {
  if (result.outputDelta !== undefined && result.outputDelta.length > 0) return true;
  return (result.events ?? []).some(
    (event) =>
      event.type === "message.delta" &&
      "delta" in event.payload &&
      typeof event.payload.delta === "string" &&
      event.payload.delta.length > 0,
  );
}

function containsReasoningDelta(result: RuntimeEventMappingResult): boolean {
  return (result.events ?? []).some(
    (event) =>
      event.type === "thought.delta" &&
      "delta" in event.payload &&
      typeof event.payload.delta === "string" &&
      event.payload.delta.length > 0,
  );
}

export function createRuntimeStreamEventFactory(
  runId: string,
  source: RuntimeStreamEvent["source"],
): RuntimeStreamEventFactory {
  return {
    messageDelta(delta, role = "assistant") {
      return {
        runId,
        source,
        type: "message.delta",
        payload: {
          role,
          contentType: "text",
          delta,
        },
      };
    },
    messageCompleted(message, role = "assistant") {
      return {
        runId,
        source,
        type: "message.completed",
        payload: {
          role,
          contentType: "text",
          ...(typeof message === "string" ? { text: message } : { message }),
        },
      };
    },
    thoughtDelta(delta) {
      return {
        runId,
        source,
        type: "thought.delta",
        payload: {
          contentType: "text",
          delta,
        },
      };
    },
    progress(stage, data, message) {
      return {
        runId,
        source,
        type: "progress",
        payload: {
          stage,
          ...(message === undefined ? {} : { message }),
          ...(data === undefined ? {} : { data }),
        },
      };
    },
    toolStarted(input) {
      return {
        runId,
        source: createToolSource(source, input.toolCallId),
        type: "tool.started",
        payload: {
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          kind: "tool",
          ...(input.inputPreview === undefined ? {} : { inputPreview: input.inputPreview }),
        },
      };
    },
    toolDelta(input) {
      return {
        runId,
        source: createToolSource(source, input.toolCallId),
        type: "tool.delta",
        payload: {
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          kind: "tool",
          channel: input.channel ?? "message",
          delta: input.delta,
        },
      };
    },
    toolCompleted(input) {
      return {
        runId,
        source: createToolSource(source, input.toolCallId),
        type: "tool.completed",
        payload: {
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          kind: "tool",
          ...(input.outputPreview === undefined ? {} : { outputPreview: input.outputPreview }),
        },
      };
    },
    toolFailed(input) {
      return {
        runId,
        source: createToolSource(source, input.toolCallId),
        type: "tool.failed",
        payload: {
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          kind: "tool",
          message: input.message,
        },
      };
    },
  };
}

function createToolSource(
  source: RuntimeStreamEvent["source"],
  toolCallId: string,
): RuntimeStreamEvent["source"] {
  return {
    ...source,
    kind: "tool",
    toolCallId,
  };
}
