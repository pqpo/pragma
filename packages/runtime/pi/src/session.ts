import type {
  AgentSession,
  AgentSessionEvent,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { AgentMessageUsageSchema, type AgentMessage, type AgentMessageUsage } from "@pragma/shared";
import type {
  Expert,
  RuntimeEventMappingContext,
  RuntimeEventMappingResult,
  RuntimeTurnContext,
  RuntimeTurnResult,
} from "@pragma/core";
import type { RuntimeStreamEventInput } from "@pragma/core";

import {
  readAssistantMessageText,
  readAssistantTextDelta,
  readAssistantThinkingDelta,
  readProgressEvent,
  readToolExecutionEvent,
} from "./session-events.ts";
import { convertPiAgentMessages } from "./session-messages.ts";
import { createToolStreamEvents } from "./stream.ts";
import { resolveRequiredRuntimeModel } from "./models.ts";
import type { PiRuntimeStreamState } from "./types.ts";

export interface PiNativeSession {
  readonly agent: Expert;
  readonly session: AgentSession;
  readonly streamState: PiRuntimeStreamState;
  readonly models: {
    readonly defaultModelName?: string | undefined;
    readonly modelRegistry: ModelRegistry;
  };
  messageCountBeforeRun: number;
}

export function createPiNativeSession(options: {
  readonly agent: Expert;
  readonly session: AgentSession;
  readonly streamState: PiRuntimeStreamState;
  readonly models: {
    readonly defaultModelName?: string | undefined;
    readonly modelRegistry: ModelRegistry;
  };
}): PiNativeSession {
  return {
    ...options,
    messageCountBeforeRun: options.session.messages.length,
  };
}

export function listPiMessages(session: PiNativeSession): readonly AgentMessage[] {
  return convertPiAgentMessages(session.session.messages);
}

export async function startPiTurn(
  nativeSession: PiNativeSession,
  turn: RuntimeTurnContext<AgentSessionEvent>,
): Promise<RuntimeTurnResult> {
  nativeSession.streamState.runId = turn.runId;
  nativeSession.streamState.source = turn.source;
  nativeSession.streamState.emitter = {
    emit(event) {
      turn.stream.write(event);
    },
    complete() {
      return undefined;
    },
  };
  if (turn.attempt === 1) {
    nativeSession.messageCountBeforeRun = nativeSession.session.messages.length;
  }

  const unsubscribe = nativeSession.session.subscribe((event) => {
    turn.stream.writeNative(event);
  });

  try {
    await applySubmissionModel(
      nativeSession.session,
      nativeSession.models.modelRegistry,
      turn.modelName ?? nativeSession.models.defaultModelName,
    );
    await nativeSession.session.prompt(turn.prompt);
  } finally {
    unsubscribe();
    nativeSession.streamState.runId = undefined;
    nativeSession.streamState.source = undefined;
    nativeSession.streamState.emitter = undefined;
  }

  return {
    runtimeSessionId: nativeSession.session.sessionId,
  };
}

export function mapPiAgentEvent(
  event: AgentSessionEvent,
  context: RuntimeEventMappingContext,
): RuntimeEventMappingResult {
  const events: RuntimeStreamEventInput[] = [];
  const delta = readAssistantTextDelta(event);
  const thinkingDelta = readAssistantThinkingDelta(event);
  const completedMessageText = readAssistantMessageText(event);
  const progressEvent = readProgressEvent(event);
  const toolEvent = readToolExecutionEvent(event);

  if (delta !== undefined) {
    events.push(context.events.messageDelta(delta));
  }

  if (thinkingDelta !== undefined) {
    events.push(context.events.thoughtDelta(thinkingDelta));
  }

  if (completedMessageText !== undefined) {
    events.push(context.events.messageCompleted(completedMessageText));
  }

  if (progressEvent !== undefined) {
    events.push(
      context.events.progress(progressEvent.stage, progressEvent.data, progressEvent.message),
    );
  }

  if (toolEvent !== undefined) {
    events.push(
      ...createToolStreamEvents({
        runId: context.runId,
        source: context.source,
        toolEvent,
      }),
    );
  }

  return {
    events,
    ...(delta === undefined ? {} : { outputDelta: delta }),
    ...(completedMessageText === undefined ? {} : { completedText: completedMessageText }),
  };
}

export function collectPiUsage(session: PiNativeSession): AgentMessageUsage | undefined {
  return aggregateAssistantUsage(session.session.messages.slice(session.messageCountBeforeRun));
}

async function applySubmissionModel(
  session: AgentSession,
  modelRegistry: ModelRegistry,
  modelName: string | undefined,
): Promise<void> {
  const model = resolveRequiredRuntimeModel(modelName, modelRegistry, "submission");

  if (
    model === undefined ||
    (session.model?.provider === model.provider && session.model.id === model.id)
  ) {
    return;
  }

  await session.setModel(model);
}

function aggregateAssistantUsage(messages: readonly unknown[]): AgentMessageUsage | undefined {
  const usages = messages
    .map((message) => readAssistantUsage(message))
    .filter((usage): usage is AgentMessageUsage => usage !== undefined);

  if (usages.length === 0) {
    return undefined;
  }

  return usages.reduce<AgentMessageUsage>(
    (total, usage) => ({
      input: total.input + usage.input,
      output: total.output + usage.output,
      cacheRead: total.cacheRead + usage.cacheRead,
      cacheWrite: total.cacheWrite + usage.cacheWrite,
      ...(total.cacheWrite1h === undefined && usage.cacheWrite1h === undefined
        ? {}
        : { cacheWrite1h: (total.cacheWrite1h ?? 0) + (usage.cacheWrite1h ?? 0) }),
      totalTokens: total.totalTokens + usage.totalTokens,
      cost: {
        input: total.cost.input + usage.cost.input,
        output: total.cost.output + usage.cost.output,
        cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
        cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
        total: total.cost.total + usage.cost.total,
      },
    }),
    createEmptyUsage(),
  );
}

function readAssistantUsage(message: unknown): AgentMessageUsage | undefined {
  if (!isRecord(message) || message["role"] !== "assistant") {
    return undefined;
  }

  const result = AgentMessageUsageSchema.safeParse(message["usage"]);
  return result.success ? result.data : undefined;
}

function createEmptyUsage(): AgentMessageUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
