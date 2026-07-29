import type {
  AgentSession,
  AgentSessionEvent,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { findCutPoint, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { AgentMessageUsageSchema, type AgentMessage, type AgentMessageUsage } from "@pragma/shared";
import type {
  Expert,
  RuntimeContextWindowUsage,
  RuntimeEventMappingContext,
  RuntimeEventMappingResult,
  RuntimeModelRef,
  RuntimeTurnContext,
  RuntimeTurnResult,
  RuntimeContextCompactionTrigger,
} from "@pragma/core";
import {
  createRuntimeContextWindowUsage,
  RUNTIME_CONTEXT_COMPACTION_STAGES,
  type RuntimeStreamEventInput,
} from "@pragma/core";

import {
  assertAssistantTurnCompleted,
  readAssistantMessage,
  readAssistantMessageText,
  readAssistantTextDelta,
  readAssistantThinkingDelta,
  readProgressEvent,
  readToolExecutionEvent,
} from "./session-events.ts";
import { convertPiAgentMessage, convertPiAgentMessages } from "./session-messages.ts";
import { createToolStreamEvents } from "./stream.ts";
import { resolvePiThinkingLevel, resolveRequiredRuntimeModel } from "./models.ts";
import type { PiRuntimeStreamState } from "./types.ts";

export interface PiNativeSession {
  readonly agent: Expert;
  readonly session: AgentSession;
  readonly streamState: PiRuntimeStreamState;
  readonly models: {
    readonly defaultModel?: RuntimeModelRef | undefined;
    readonly modelRegistry: ModelRegistry;
    readonly modelRuntime: ModelRuntime;
  };
  messageCountBeforeRun: number;
  pendingCompactionOperationId?: string | undefined;
  compactionTriggerOverride?: RuntimeContextCompactionTrigger | undefined;
}

export interface PiNativeEvent {
  readonly event: AgentSessionEvent;
  readonly operationId?: string | undefined;
  readonly trigger?: RuntimeContextCompactionTrigger | undefined;
}

export function createPiNativeSession(options: {
  readonly agent: Expert;
  readonly session: AgentSession;
  readonly streamState: PiRuntimeStreamState;
  readonly models: {
    readonly defaultModel?: RuntimeModelRef | undefined;
    readonly modelRegistry: ModelRegistry;
    readonly modelRuntime: ModelRuntime;
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
  turn: RuntimeTurnContext<PiNativeEvent>,
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
    if (event.type === "compaction_start") {
      nativeSession.pendingCompactionOperationId = randomUUID();
    }
    const operationId =
      event.type === "compaction_start" || event.type === "compaction_end"
        ? (nativeSession.pendingCompactionOperationId ?? randomUUID())
        : undefined;
    turn.stream.writeNative({
      event,
      ...(operationId === undefined ? {} : { operationId }),
      ...(event.type !== "compaction_start" && event.type !== "compaction_end"
        ? {}
        : {
            trigger:
              nativeSession.compactionTriggerOverride ?? mapPiCompactionTrigger(event.reason),
          }),
    });
    if (event.type === "compaction_end") {
      nativeSession.pendingCompactionOperationId = undefined;
    }
  });

  try {
    const submissionModel = turn.modelSelection?.model ?? nativeSession.models.defaultModel;
    await applySubmissionModel(
      nativeSession.session,
      nativeSession.models.modelRegistry,
      submissionModel,
    );
    const thinkingLevel = resolvePiThinkingLevel(turn.modelSelection?.thinkingLevel);
    if (thinkingLevel !== undefined) {
      nativeSession.session.setThinkingLevel(thinkingLevel);
    }
    await compactPiContextBeforePrompt(nativeSession);
    await nativeSession.session.prompt(turn.prompt);
    assertAssistantTurnCompleted(
      nativeSession.session.messages.slice(nativeSession.messageCountBeforeRun),
    );
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
  input: PiNativeEvent,
  context: RuntimeEventMappingContext,
): RuntimeEventMappingResult {
  const { event } = input;
  const events: RuntimeStreamEventInput[] = [];
  const delta = readAssistantTextDelta(event);
  const thinkingDelta = readAssistantThinkingDelta(event);
  const completedMessageText = readAssistantMessageText(event);
  const completedMessage = readAssistantMessage(event);
  const progressEvent = readProgressEvent(event);
  const toolEvent = readToolExecutionEvent(event);

  if (delta !== undefined) {
    events.push(context.events.messageDelta(delta));
  }

  if (thinkingDelta !== undefined) {
    events.push(context.events.thoughtDelta(thinkingDelta));
  }

  if (completedMessage !== undefined) {
    events.push(context.events.messageCompleted(convertPiAgentMessage(completedMessage)));
  }

  if (progressEvent !== undefined) {
    events.push(
      context.events.progress(progressEvent.stage, progressEvent.data, progressEvent.message),
    );
  }

  if (
    (event.type === "compaction_start" || event.type === "compaction_end") &&
    input.operationId !== undefined
  ) {
    const failed =
      event.type === "compaction_end" &&
      (event.aborted || (event.errorMessage !== undefined && event.errorMessage !== ""));
    events.push(
      context.events.progress(
        event.type === "compaction_start"
          ? RUNTIME_CONTEXT_COMPACTION_STAGES.started
          : failed
            ? RUNTIME_CONTEXT_COMPACTION_STAGES.failed
            : RUNTIME_CONTEXT_COMPACTION_STAGES.completed,
        {
          operationId: input.operationId,
          trigger: input.trigger ?? "unknown",
          runtimeId: "cloud-pi-agent",
          ...(event.type === "compaction_end" && event.errorMessage !== undefined
            ? { errorMessage: event.errorMessage }
            : {}),
        },
      ),
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

export async function compactPiContextBeforePrompt(session: PiNativeSession): Promise<boolean> {
  const usage = session.session.getContextUsage();
  if (
    usage === undefined ||
    usage.tokens === null ||
    usage.contextWindow <= 0 ||
    usage.tokens / usage.contextWindow < 0.75
  ) {
    return false;
  }

  session.compactionTriggerOverride = "auto";
  try {
    await session.session.compact();
    return true;
  } catch (error) {
    throw new Error(
      `PI Runtime automatic context compaction failed before the prompt: ${readErrorMessage(error)}`,
      { cause: error },
    );
  } finally {
    session.compactionTriggerOverride = undefined;
  }
}

function mapPiCompactionTrigger(reason: unknown): RuntimeContextCompactionTrigger {
  if (reason === "manual") return "manual";
  if (reason === "overflow") return "overflow";
  if (reason === "threshold") return "auto";
  return "unknown";
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function collectPiUsage(session: PiNativeSession): AgentMessageUsage | undefined {
  return aggregateAssistantUsage(session.session.messages.slice(session.messageCountBeforeRun));
}

export function readPiContextWindow(
  session: PiNativeSession,
): RuntimeContextWindowUsage | undefined {
  const usage = session.session.getContextUsage();
  if (usage === undefined) return undefined;
  return createRuntimeContextWindowUsage({
    usedTokens: usage.tokens,
    contextWindowTokens: usage.contextWindow,
    measurement: "estimated",
  });
}

export function canCompactPiContextWindow(session: PiNativeSession): boolean {
  const pathEntries = session.session.sessionManager.getBranch();
  if (pathEntries.at(-1)?.type === "compaction") return false;

  let boundaryStart = 0;
  for (let index = pathEntries.length - 1; index >= 0; index -= 1) {
    const entry = pathEntries[index];
    if (entry?.type !== "compaction") continue;
    const firstKeptEntryIndex = pathEntries.findIndex(
      (candidate) => candidate.id === entry.firstKeptEntryId,
    );
    boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : index + 1;
    break;
  }

  const cutPoint = findCutPoint(
    pathEntries,
    boundaryStart,
    pathEntries.length,
    session.session.settingsManager.getCompactionKeepRecentTokens(),
  );
  if (pathEntries[cutPoint.firstKeptEntryIndex]?.id === undefined) return false;

  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  const hasContextMessage = (start: number, end: number): boolean =>
    pathEntries
      .slice(start, end)
      .some(
        (entry) => entry.type !== "compaction" && sessionEntryToContextMessages(entry).length > 0,
      );

  return (
    hasContextMessage(boundaryStart, historyEnd) ||
    (cutPoint.isSplitTurn &&
      hasContextMessage(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex))
  );
}

export async function compactPiContextWindow(
  session: PiNativeSession,
): Promise<RuntimeContextWindowUsage | undefined> {
  const before = session.session.getContextUsage();
  const result = await session.session.compact();
  const after = session.session.getContextUsage();
  const contextWindowTokens = after?.contextWindow ?? before?.contextWindow;
  if (contextWindowTokens === undefined) return undefined;
  return createRuntimeContextWindowUsage({
    usedTokens: result.estimatedTokensAfter ?? after?.tokens ?? null,
    contextWindowTokens,
    measurement: "estimated",
  });
}

async function applySubmissionModel(
  session: AgentSession,
  modelRegistry: ModelRegistry,
  modelRef: RuntimeModelRef | undefined,
): Promise<void> {
  const model = resolveRequiredRuntimeModel(modelRef, modelRegistry, "submission");

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
      measurement: "reported",
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

  const result = AgentMessageUsageSchema.safeParse({
    measurement: "reported",
    ...(isRecord(message["usage"]) ? message["usage"] : {}),
  });
  return result.success ? result.data : undefined;
}

function createEmptyUsage(): AgentMessageUsage {
  return {
    measurement: "reported",
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
