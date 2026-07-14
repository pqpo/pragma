import type { AgentMessage, AgentMessageUsage } from "@pragma/shared";

import type { Expert } from "../agent/expert-agent.ts";
import type { ExpertAgentLogger } from "../logging/logger.ts";
import { dispatchExpertAgentHook } from "../plugins/expert-agent-plugin.ts";
import type { RuntimeSessionInfo } from "./runtime-adapter.ts";
import type { ExpertAgentRunContext } from "./run-context.ts";
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
  readonly logger: ExpertAgentLogger;
  readonly mapEvent: (
    event: TNativeEvent,
    context: RuntimeEventMappingContext,
  ) => RuntimeEventMappingResult;
  readonly mergeUsage: (
    current: AgentMessageUsage | undefined,
    next: AgentMessageUsage | undefined,
  ) => AgentMessageUsage | undefined;
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
  let usage: AgentMessageUsage | undefined;
  let runtimeSessionId: string | undefined;

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

  const applyMappingResult = (result: RuntimeEventMappingResult): void => {
    for (const event of result.events ?? []) {
      emit(event);
    }
    if (result.outputDelta !== undefined) {
      outputText += result.outputDelta;
    }
    if (result.completedText !== undefined) {
      outputText = result.completedText;
    }
    usage = options.mergeUsage(usage, result.usage);
    runtimeSessionId = result.runtimeSessionId ?? runtimeSessionId;
  };

  return {
    events: options.queue,
    emitter,
    source,
    writer: {
      writeNative(event) {
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
      },
    },
    getOutputText: () => outputText,
    getUsage: () => usage,
    getRuntimeSessionId: () => runtimeSessionId,
    resetCapture() {
      outputText = "";
      usage = undefined;
      runtimeSessionId = undefined;
    },
    async complete() {
      await Promise.allSettled(pendingHookCalls);
      emitter.complete();
    },
  };
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
