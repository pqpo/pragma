import {
  isRuntimeContextCompactionStage,
  readRuntimeContextCompactionProgressData,
  RUNTIME_CONTEXT_COMPACTION_STAGES,
  type ExecutionOutputItem,
  type MutableExecution,
  type SubscribeOutputOptions,
} from "@pragma/core";
import type { ExecutionEvent } from "@pragma/shared";
import { type MissionChatEntry, type MissionChatPatch } from "../../../shared/contracts/index.ts";
import {
  createMissionOutputCoalescer,
  type MissionOutputCoalescer,
} from "./mission-output-coalescer.ts";
import {
  MISSION_CHAT_ERROR_MAX_LENGTH,
  asRecord,
  formatValue,
  isRootMissionRuntimeSource,
  nextMessageEntryId,
  preview,
  readString,
  truncate,
  type ExecutorAvatarIdResolver,
  type ExecutorNameResolver,
} from "./mission-chat-projection-common.ts";

export interface LiveMissionChat {
  readonly executionId: string;
  readonly entries: MissionChatEntry[];
  readonly messageOrdinals: Map<string, number>;
  completedAnswerRuns?: Set<string>;
  finalAnswerBoundary?: {
    readonly entryId: string;
    readonly runKey: string;
    readonly occurredAt: string;
  };
  close: () => Promise<void>;
}

export function observeMissionChat(
  execution: MutableExecution & { readonly result: Promise<unknown> },
  onOutput: (patches: readonly MissionChatPatch[]) => void,
  onInvalidate: () => void,
  onWorkInvalidate: () => void,
  onEvent: (event: ExecutionEvent) => Promise<void>,
  onEventResync: () => Promise<void>,
  onSubscriptionError: (channel: "output" | "events", error: unknown) => void,
  onItem: (item: ExecutionOutputItem) => void,
  resolveExecutorName: ExecutorNameResolver,
  resolveExecutorAvatarId: ExecutorAvatarIdResolver,
  options: {
    readonly outputSubscription: SubscribeOutputOptions;
    readonly onOutputStats?:
      ((stats: ReturnType<MissionOutputCoalescer["stats"]>) => void) | undefined;
  },
): LiveMissionChat {
  const chat: LiveMissionChat = {
    executionId: execution.executionId,
    entries: [],
    messageOrdinals: new Map(),
    close: async () => undefined,
  };
  let closed = false;
  // Output subscriptions replay the in-memory history when they reconnect. Keep the
  // source event ids seen by this live projection so a replay cannot append the same
  // assistant message a second time.
  const seenOutputEventIds = new Set<string>();
  let outputSubscription: Awaited<ReturnType<MutableExecution["subscribeOutput"]>> | undefined;
  let eventSubscription: Awaited<ReturnType<MutableExecution["subscribeEvents"]>> | undefined;
  const consumeOutput = (item: ExecutionOutputItem): void => {
    onItem(item);
    const patches = consumeLiveChatOutput(chat, item, {
      resolveExecutorName,
      resolveExecutorAvatarId,
    });
    if (patches.length > 0) onOutput(patches);
    if (isTerminalContextCompactionOutput(item)) onInvalidate();
  };
  const outputCoalescer = createMissionOutputCoalescer({ emit: consumeOutput });
  const outputTask = (async () => {
    while (!closed) {
      try {
        const subscription = await execution.subscribeOutput(options.outputSubscription);
        outputSubscription = subscription;
        for await (const item of subscription) {
          if (closed) break;
          if (seenOutputEventIds.has(item.sourceEventId)) continue;
          seenOutputEventIds.add(item.sourceEventId);
          outputCoalescer.push(item);
        }
        outputCoalescer.flush();
        return;
      } catch (error) {
        outputCoalescer.flush();
        if (isExecutionUnavailable(error, execution.executionId)) return;
        if (!closed) {
          onSubscriptionError("output", error);
          await missionSubscriptionRetryDelay();
        }
      } finally {
        await outputSubscription?.close();
        outputSubscription = undefined;
      }
    }
  })();
  const eventTask = (async () => {
    while (!closed) {
      try {
        const subscription = await execution.subscribeEvents({ scope: { kind: "all" } });
        eventSubscription = subscription;
        let resyncFailed = false;
        while (!closed) {
          try {
            await onEventResync();
            // A failed seed can miss an interaction event because the event bus is live-only.
            // Once its durable projection recovers, tell both the chat and rail to reload it.
            if (resyncFailed) onInvalidate();
            break;
          } catch (error) {
            if (closed) break;
            resyncFailed = true;
            onSubscriptionError("events", error);
            // Preserve the user-visible interaction update while the durable Mission projection
            // retries. The established subscription keeps subsequent live events queued.
            onInvalidate();
            await missionSubscriptionRetryDelay();
          }
        }
        if (closed) return;
        for await (const event of subscription) {
          if (closed) break;
          await onEvent(event);
          if (isInvocationLifecycleEvent(event)) onWorkInvalidate();
          if (event.type.startsWith("human.") || event.type.startsWith("execution.")) {
            onInvalidate();
          }
        }
        return;
      } catch (error) {
        if (isExecutionUnavailable(error, execution.executionId)) return;
        if (!closed) {
          onSubscriptionError("events", error);
          await missionSubscriptionRetryDelay();
        }
      } finally {
        await eventSubscription?.close();
        eventSubscription = undefined;
      }
    }
  })();
  chat.close = async () => {
    if (closed) return;
    closed = true;
    outputCoalescer.close();
    await Promise.allSettled([outputSubscription?.close(), eventSubscription?.close()]);
    await Promise.allSettled([outputTask, eventTask]);
    options.onOutputStats?.(outputCoalescer.stats());
  };
  return chat;
}

function isInvocationLifecycleEvent(event: ExecutionEvent): boolean {
  return event.type.startsWith("invocation.") && event.type !== "invocation.message.appended";
}

function isExecutionUnavailable(error: unknown, executionId: string): boolean {
  return error instanceof Error && error.message === `Execution not found: ${executionId}`;
}

async function missionSubscriptionRetryDelay(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
}

export function isVisibleTextProjectionPatch(patch: MissionChatPatch): boolean {
  if (patch.type === "entry.append") {
    return patch.field === "content" && patch.delta.length > 0;
  }
  return (
    patch.type === "entry.upsert" &&
    (patch.entry.kind === "assistant" || patch.entry.kind === "thinking") &&
    patch.entry.content.length > 0
  );
}

export function isRootMissionRuntimeOutput(
  item: Pick<ExecutionOutputItem, "parentInvocationId" | "source">,
): boolean {
  return item.parentInvocationId === undefined && isRootMissionRuntimeSource(item.source);
}

function isTerminalContextCompactionOutput(item: ExecutionOutputItem): boolean {
  if (item.channel !== "progress" || !isRootMissionRuntimeOutput(item)) {
    return false;
  }
  const stage = asRecord(item.value)["stage"];
  return (
    stage === RUNTIME_CONTEXT_COMPACTION_STAGES.completed ||
    stage === RUNTIME_CONTEXT_COMPACTION_STAGES.failed
  );
}

export function consumeLiveChatOutput(
  chat: LiveMissionChat,
  item: ExecutionOutputItem,
  options: {
    readonly includeNestedSource?: boolean;
    readonly resolveExecutorName?: ExecutorNameResolver;
    readonly resolveExecutorAvatarId?: ExecutorAvatarIdResolver;
  } = {},
): MissionChatPatch[] {
  clearSupersededFinalAnswerBoundary(chat, item);
  const executorName =
    item.executorId === undefined ? undefined : options.resolveExecutorName?.(item.executorId);
  const executorAvatarId =
    item.executorId === undefined ? undefined : options.resolveExecutorAvatarId?.(item.executorId);
  const base = {
    executionId: item.executionId,
    invocationId: item.invocationId,
    ...(item.executorId === undefined ? {} : { executorId: item.executorId }),
    ...(executorName === undefined ? {} : { executorName }),
    ...(executorAvatarId === undefined ? {} : { executorAvatarId }),
    createdAt: item.occurredAt,
  };
  if (item.channel === "agent") {
    const payload = asRecord(item.value);
    const eventType = readString(payload, "type");
    const action = eventType.startsWith("run.")
      ? "run"
      : readAgentActivityAction(readString(payload, "action"));
    if (action === undefined) return [];
    const commandId =
      readString(payload, "commandId") ||
      `${item.source.sessionId ?? item.runId}:${item.runId}:${action}`;
    const phase =
      eventType === "run.failed" || eventType === "run.cancelled"
        ? "failed"
        : eventType === "run.completed"
          ? "completed"
          : eventType === "run.started"
            ? "started"
            : readAgentActivityPhase(readString(payload, "phase"));
    if (phase === undefined) return [];
    const id = `agent:${item.executionId}:${commandId}`;
    const targets = payload["targetSessionIds"];
    const targetSessionIds = Array.isArray(targets)
      ? targets.filter((value): value is string => typeof value === "string" && value !== "")
      : item.source.sessionId === undefined
        ? []
        : [item.source.sessionId];
    const entry: MissionChatEntry = {
      ...base,
      id,
      kind: "agent_activity",
      commandId,
      action,
      phase,
      ...(readString(payload, "senderSessionId") === ""
        ? {}
        : { senderSessionId: readString(payload, "senderSessionId") }),
      targetSessionIds,
      ...(item.source.displayName === undefined ? {} : { label: item.source.displayName }),
      ...(readString(payload, "error") === ""
        ? eventType !== "run.failed"
          ? {}
          : {
              error: truncate(
                readString(payload, "message") || "Subagent failed.",
                MISSION_CHAT_ERROR_MAX_LENGTH,
              ),
            }
        : {
            error: truncate(readString(payload, "error"), MISSION_CHAT_ERROR_MAX_LENGTH),
          }),
    };
    return [upsertLiveMissionChatEntry(chat, entry)];
  }
  if (item.channel === "progress") {
    if (!isRootMissionRuntimeOutput(item)) return [];
    const payload = asRecord(item.value);
    const stage = payload["stage"];
    if (!isRuntimeContextCompactionStage(stage)) return [];
    const data = readRuntimeContextCompactionProgressData(payload["data"]);
    if (data === undefined) return [];
    const id = `context:${item.executionId}:${data.operationId}`;
    const existing = chat.entries.find((entry) => entry.id === id);
    const entry: MissionChatEntry = {
      ...base,
      id,
      kind: "context_operation",
      operationId: data.operationId,
      operation: "compaction",
      trigger: data.trigger,
      runtimeId: data.runtimeId,
      status:
        stage === RUNTIME_CONTEXT_COMPACTION_STAGES.started
          ? "running"
          : stage === RUNTIME_CONTEXT_COMPACTION_STAGES.completed
            ? "succeeded"
            : "failed",
      ...(data.errorMessage === undefined
        ? {}
        : { error: truncate(data.errorMessage, MISSION_CHAT_ERROR_MAX_LENGTH) }),
      createdAt: existing?.createdAt ?? item.occurredAt,
    };
    return [upsertLiveMissionChatEntry(chat, entry)];
  }
  if (item.source.parentSessionId !== undefined && options.includeNestedSource !== true) return [];
  if (item.channel === "thought") {
    if (chat.completedAnswerRuns?.has(missionAnswerRunKey(item))) return [];
    const content = item.delta ?? formatValue(item.value, 200_000);
    if (content === "") return [];
    const current = findStreamingMessageEntryForRun(chat.entries, item, "thinking");
    if (current !== undefined) {
      const canAppend = current.content.length + content.length <= 200_000;
      const nextContent = truncate(current.content + content, 200_000);
      if (nextContent === current.content) return [];
      current.content = nextContent;
      const patches: MissionChatPatch[] = canAppend
        ? [{ type: "entry.append", entryId: current.id, field: "content", delta: content }]
        : [{ type: "entry.upsert", entry: { ...current } }];
      return patches;
    } else {
      const entry = {
        ...base,
        id: nextMessageEntryId(
          item.executionId,
          item.invocationId,
          item.runId,
          "thinking",
          chat.messageOrdinals,
        ),
        kind: "thinking" as const,
        content: truncate(content, 200_000),
        streaming: true,
      };
      return [upsertLiveMissionChatEntry(chat, entry)];
    }
  }
  if (item.channel === "message") {
    const content = item.delta ?? completedMessageText(item.value);
    const finalAnswer = item.delta === undefined && isFinalMissionAnswer(item.value);
    const patches = markRunThinkingComplete(chat.entries, item);
    if (finalAnswer) {
      (chat.completedAnswerRuns ??= new Set()).add(missionAnswerRunKey(item));
    }
    const current = findStreamingMessageEntryForRun(chat.entries, item, "assistant");
    const existingForRun = findAssistantEntryForRun(chat.entries, item);
    const startsNewSegment =
      current === undefined &&
      existingForRun !== undefined &&
      assistantMessageStartsNewSegment(chat.entries, existingForRun, item, content);
    // Codex can deliver an item/completed notification before a queued delta is
    // drained. The completed item already owns the final text; treating that late
    // delta as a new stream would create a second assistant row for the same run.
    // A Runtime run may legitimately contain several assistant messages separated
    // by tool calls, though. In that case the post-tool delta starts a new segment
    // even though an earlier assistant message for the run is already complete.
    if (
      item.delta !== undefined &&
      current === undefined &&
      hasCompletedMessageForRun(chat.entries, item) &&
      !startsNewSegment
    ) {
      return patches;
    }
    if (item.delta !== undefined && current !== undefined) {
      const canAppend = current.content.length + content.length <= 200_000;
      const nextContent = truncate(current.content + content, 200_000);
      const contentChanged = nextContent !== current.content;
      current.content = nextContent;
      if (content !== "" && contentChanged) {
        patches.push(
          canAppend
            ? { type: "entry.append", entryId: current.id, field: "content", delta: content }
            : { type: "entry.upsert", entry: { ...current } },
        );
      }
    } else if (item.delta === undefined && existingForRun !== undefined && !startsNewSegment) {
      if (current !== undefined) {
        current.streaming = false;
        if (finalAnswer) current.finalAnswer = true;
        patches.push(
          finalAnswer
            ? upsertLiveMissionChatEntry(chat, current)
            : { type: "entry.streaming", entryId: current.id, streaming: false },
        );
      } else if (finalAnswer && existingForRun.finalAnswer !== true) {
        existingForRun.finalAnswer = true;
        patches.push(upsertLiveMissionChatEntry(chat, existingForRun));
      }
    } else if (content !== "") {
      const entry = {
        ...base,
        id: nextMessageEntryId(
          item.executionId,
          item.invocationId,
          item.runId,
          "assistant",
          chat.messageOrdinals,
        ),
        kind: "assistant" as const,
        content: truncate(content, 200_000),
        streaming: item.delta !== undefined,
        ...(finalAnswer ? { finalAnswer: true } : {}),
      };
      patches.push(upsertLiveMissionChatEntry(chat, entry));
    }
    if (finalAnswer && isRootMissionRuntimeOutput(item)) {
      const finalEntry = findAssistantEntryForRun(chat.entries, item);
      if (finalEntry !== undefined) {
        chat.finalAnswerBoundary = {
          entryId: finalEntry.id,
          runKey: missionAnswerRunKey(item),
          occurredAt: item.occurredAt,
        };
      }
    }
    return patches;
  }
  if (item.channel === "tool") {
    const payload = asRecord(item.value);
    if (item.delta !== undefined) {
      const sourceToolCallId = item.source.toolCallId;
      const tool = [...chat.entries]
        .reverse()
        .find(
          (entry) =>
            entry.kind === "tool" &&
            entry.invocationId === item.invocationId &&
            entry.status === "running" &&
            (sourceToolCallId === undefined || entry.toolCallId === sourceToolCallId),
        );
      if (tool?.kind === "tool") {
        const delta = normalizeToolDelta(item.delta);
        const canAppend = (tool.outputPreview?.length ?? 0) + delta.length <= 801;
        tool.outputPreview = preview(`${tool.outputPreview ?? ""}${delta}`);
        return delta === ""
          ? []
          : canAppend
            ? [{ type: "entry.append", entryId: tool.id, field: "outputPreview", delta }]
            : [{ type: "entry.upsert", entry: { ...tool } }];
      }
      return [];
    }
    const toolCallId = readString(payload, "toolCallId") || item.sourceEventId;
    const existing = chat.entries.find(
      (entry) => entry.kind === "tool" && entry.toolCallId === toolCallId,
    );
    const toolName = readString(payload, "toolName") || "tool";
    if (existing?.kind === "tool") {
      if (payload["message"] !== undefined) {
        existing.status = "failed";
        existing.error = truncate(
          readString(payload, "message") || "Tool failed.",
          MISSION_CHAT_ERROR_MAX_LENGTH,
        );
      } else if (payload["approvalId"] !== undefined) {
        existing.status = "approval_required";
      } else if (payload["outputPreview"] !== undefined) {
        existing.status = "succeeded";
        existing.outputPreview = preview(payload["outputPreview"]);
      }
      return [upsertLiveMissionChatEntry(chat, existing)];
    }
    const patches = markRunThinkingComplete(chat.entries, item);
    const entry: MissionChatEntry = {
      ...base,
      id: `tool:${item.executionId}:${toolCallId}`,
      kind: "tool" as const,
      toolCallId,
      toolName,
      status:
        payload["message"] !== undefined
          ? "failed"
          : payload["approvalId"] !== undefined
            ? "approval_required"
            : payload["outputPreview"] !== undefined
              ? "succeeded"
              : "running",
      ...(payload["inputPreview"] === undefined
        ? {}
        : { inputPreview: preview(payload["inputPreview"]) }),
      ...(payload["outputPreview"] === undefined
        ? {}
        : { outputPreview: preview(payload["outputPreview"]) }),
      ...(payload["message"] === undefined
        ? {}
        : {
            error: truncate(
              readString(payload, "message") || "Tool failed.",
              MISSION_CHAT_ERROR_MAX_LENGTH,
            ),
          }),
    };
    patches.push(upsertLiveMissionChatEntry(chat, entry));
    return patches;
  }
  if (item.channel === "result") {
    (chat.completedAnswerRuns ??= new Set()).add(missionAnswerRunKey(item));
    const patches = markRunThinkingComplete(chat.entries, item);
    const content = formatValue(item.value, 200_000);
    let finalEntry = findAssistantEntryForRun(chat.entries, item);
    if (content !== "" && finalEntry === undefined) {
      const entry = {
        ...base,
        id: nextMessageEntryId(
          item.executionId,
          item.invocationId,
          item.runId,
          "assistant",
          chat.messageOrdinals,
        ),
        kind: "assistant" as const,
        content,
        streaming: false,
        finalAnswer: true,
      };
      const upsert = upsertLiveMissionChatEntry(chat, entry);
      patches.push(upsert);
      finalEntry = entry;
    } else if (finalEntry !== undefined && finalEntry.finalAnswer !== true) {
      finalEntry.streaming = false;
      finalEntry.finalAnswer = true;
      patches.push(upsertLiveMissionChatEntry(chat, finalEntry));
    }
    if (isRootMissionRuntimeOutput(item) && finalEntry !== undefined) {
      chat.finalAnswerBoundary = {
        entryId: finalEntry.id,
        runKey: missionAnswerRunKey(item),
        occurredAt: item.occurredAt,
      };
    }
    return patches;
  }
  return [];
}

function missionAnswerRunKey(item: Pick<ExecutionOutputItem, "invocationId" | "runId">): string {
  return JSON.stringify([item.invocationId, item.runId]);
}

function clearSupersededFinalAnswerBoundary(
  chat: LiveMissionChat,
  item: Pick<
    ExecutionOutputItem,
    "channel" | "parentInvocationId" | "runId" | "invocationId" | "occurredAt" | "source"
  >,
): void {
  const boundary = chat.finalAnswerBoundary;
  if (
    boundary !== undefined &&
    isRootMissionRuntimeOutput(item) &&
    item.channel !== "telemetry" &&
    missionAnswerRunKey(item) !== boundary.runKey &&
    item.occurredAt > boundary.occurredAt
  ) {
    delete chat.finalAnswerBoundary;
  }
}

function upsertLiveMissionChatEntry(
  chat: LiveMissionChat,
  entry: MissionChatEntry,
): Extract<MissionChatPatch, { readonly type: "entry.upsert" }> {
  const existingIndex = chat.entries.findIndex((candidate) => candidate.id === entry.id);
  const boundaryId =
    chat.finalAnswerBoundary?.entryId === entry.id ? undefined : chat.finalAnswerBoundary?.entryId;
  const boundaryIndex =
    boundaryId === undefined
      ? -1
      : chat.entries.findIndex((candidate) => candidate.id === boundaryId);

  if (existingIndex === -1) {
    if (boundaryIndex === -1) chat.entries.push(entry);
    else chat.entries.splice(boundaryIndex, 0, entry);
  } else {
    chat.entries[existingIndex] = entry;
    if (boundaryIndex >= 0 && existingIndex > boundaryIndex) {
      chat.entries.splice(existingIndex, 1);
      const nextBoundaryIndex = chat.entries.findIndex((candidate) => candidate.id === boundaryId);
      chat.entries.splice(nextBoundaryIndex, 0, entry);
    }
  }

  return {
    type: "entry.upsert",
    entry: { ...entry },
    ...(boundaryIndex === -1 ? {} : { beforeEntryId: boundaryId }),
  };
}

function isFinalMissionAnswer(value: unknown): boolean {
  const stopReason = asRecord(value)["stopReason"];
  return stopReason === "stop" || stopReason === "length";
}

function hasCompletedMessageForRun(
  entries: readonly MissionChatEntry[],
  item: Pick<ExecutionOutputItem, "executionId" | "invocationId" | "runId">,
): boolean {
  const prefix = `message:${item.executionId}:${item.invocationId}:${item.runId}:assistant:`;
  return entries.some(
    (entry) =>
      entry.kind === "assistant" &&
      entry.executionId === item.executionId &&
      entry.invocationId === item.invocationId &&
      entry.streaming === false &&
      entry.content.length > 0 &&
      entry.id.startsWith(prefix),
  );
}

function assistantMessageStartsNewSegment(
  entries: readonly MissionChatEntry[],
  previous: Extract<MissionChatEntry, { readonly kind: "assistant" }>,
  item: Pick<ExecutionOutputItem, "executionId" | "invocationId" | "runId" | "occurredAt">,
  content: string,
): boolean {
  if (content !== "" && content !== previous.content) return true;
  const previousIndex = entries.findIndex((entry) => entry.id === previous.id);
  if (previousIndex < 0) return false;
  return entries
    .slice(previousIndex + 1)
    .some(
      (entry) =>
        entry.kind === "tool" &&
        entry.executionId === item.executionId &&
        entry.invocationId === item.invocationId &&
        entry.createdAt <= item.occurredAt,
    );
}

function findAssistantEntryForRun(
  entries: readonly MissionChatEntry[],
  item: Pick<ExecutionOutputItem, "executionId" | "invocationId" | "runId">,
): Extract<MissionChatEntry, { readonly kind: "assistant" }> | undefined {
  const prefix = `message:${item.executionId}:${item.invocationId}:${item.runId}:assistant:`;
  return entries.findLast(
    (entry): entry is Extract<MissionChatEntry, { readonly kind: "assistant" }> =>
      entry.kind === "assistant" && entry.id.startsWith(prefix),
  );
}

function findStreamingMessageEntryForRun<K extends "assistant" | "thinking">(
  entries: readonly MissionChatEntry[],
  item: Pick<ExecutionOutputItem, "executionId" | "invocationId" | "runId">,
  kind: K,
): Extract<MissionChatEntry, { kind: K }> | undefined {
  const prefix = `message:${item.executionId}:${item.invocationId}:${item.runId}:${kind}:`;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.kind === kind &&
      entry.invocationId === item.invocationId &&
      entry.streaming &&
      entry.id.startsWith(prefix)
    ) {
      return entry as Extract<MissionChatEntry, { kind: K }>;
    }
  }
  return undefined;
}

function readAgentActivityAction(
  value: string,
): Extract<MissionChatEntry, { kind: "agent_activity" }>["action"] | undefined {
  switch (value) {
    case "spawn":
    case "wait":
    case "list":
    case "send":
    case "resume":
    case "interrupt":
      return value;
    default:
      return undefined;
  }
}

function readAgentActivityPhase(
  value: string,
): Extract<MissionChatEntry, { kind: "agent_activity" }>["phase"] | undefined {
  switch (value) {
    case "started":
    case "completed":
    case "failed":
      return value;
    default:
      return undefined;
  }
}

function completedMessageText(value: unknown): string {
  if (typeof value === "string") return value;
  const content = asRecord(value)["content"];
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      const record = asRecord(item);
      return record["type"] === "text" ? [readString(record, "text")] : [];
    })
    .join("");
}

function normalizeToolDelta(delta: string): string {
  try {
    const parsed = JSON.parse(delta) as unknown;
    const content = asRecord(parsed)["content"];
    if (!Array.isArray(content)) return formatValue(parsed, 800);
    return content.map((item) => readString(asRecord(item), "text")).join("\n");
  } catch {
    return delta;
  }
}

function markRunThinkingComplete(
  entries: MissionChatEntry[],
  item: Pick<ExecutionOutputItem, "executionId" | "invocationId" | "runId">,
): MissionChatPatch[] {
  const patches: MissionChatPatch[] = [];
  const prefix = `message:${item.executionId}:${item.invocationId}:${item.runId}:thinking:`;
  for (const entry of entries) {
    if (
      entry.kind === "thinking" &&
      entry.invocationId === item.invocationId &&
      entry.streaming &&
      entry.id.startsWith(prefix)
    ) {
      entry.streaming = false;
      patches.push({ type: "entry.streaming", entryId: entry.id, streaming: false });
    }
  }
  return patches;
}
