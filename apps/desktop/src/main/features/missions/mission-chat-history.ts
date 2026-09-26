import { createHash } from "node:crypto";
import {
  createFileExecutionStore,
  StoredExecutionView,
  isRuntimeContextCompactionStage,
  readRuntimeContextCompactionProgressData,
  RUNTIME_CONTEXT_COMPACTION_STAGES,
  type AgentMessageRecord,
  type ExecutionView,
  type ExecutionWorkRecord,
} from "@pragma/core";
import type { ExpertAgentStreamEvent } from "@pragma/shared";
import { ExpertAgentStreamEventSchema } from "@pragma/shared";
import {
  type Mission,
  type MissionChatEntry,
  type MissionChatPageQuery,
  type MissionConversationSnapshot,
} from "../../../shared/contracts/index.ts";
import type { MissionStore, MissionTimelineTurn } from "./mission-store.ts";
import { MISSION_EXECUTION_PROJECTION_ORDERING_VERSION } from "./mission-execution-projection.ts";
import type { LiveMissionChat } from "./mission-chat-live.ts";
import {
  MISSION_CHAT_ERROR_MAX_LENGTH,
  formatValue,
  isMissionTerminalExecutionStatus,
  isRootMissionRuntimeSource,
  missionWorkOutputSummary,
  nextMessageEntryId,
  preview,
  truncate,
  type ExecutorAvatarIdResolver,
  type ExecutorNameResolver,
} from "./mission-chat-projection-common.ts";

type MissionChatPageCursor =
  | { readonly version: 1; readonly kind: "timeline"; readonly beforeSequence: number }
  | {
      readonly version: 1;
      readonly kind: "projection";
      readonly sequence: number;
      readonly beforeOffset: number;
    }
  | {
      readonly version: 1;
      readonly kind: "entries";
      readonly sequence: number;
      readonly beforeEntryId: string;
    }
  | {
      readonly version: 2;
      readonly kind: "entries";
      readonly sequence: number;
      readonly beforeEntryHash: string;
    }
  | { readonly version: 1; readonly kind: "turn-start"; readonly sequence: number };

export async function readMissionChatHistoryPage(input: {
  readonly missionId: string;
  readonly query: MissionChatPageQuery;
  readonly executionStore: ReturnType<typeof createFileExecutionStore>;
  readonly missions: MissionStore;
  readonly rootOnly: boolean;
  readonly activeChat?: LiveMissionChat | undefined;
  readonly loadInheritedEntries?: (() => Promise<readonly MissionChatEntry[]>) | undefined;
}): Promise<{
  readonly entries: readonly MissionChatEntry[];
  readonly syncIssues: readonly MissionChatSyncIssue[];
  readonly oldestSequence?: number | undefined;
  readonly newestSequence?: number | undefined;
  readonly nextBeforeCursor?: string | undefined;
  readonly truncation?:
    { readonly omittedEntries: number; readonly truncatedFields: number } | undefined;
}> {
  const cursor = decodeMissionChatPageCursor(input.query.beforeCursor);
  let beforeSequence = cursor?.kind === "timeline" ? cursor.beforeSequence : undefined;
  const continuationSequence =
    cursor === undefined || cursor.kind === "timeline" ? undefined : cursor.sequence;
  if (continuationSequence !== undefined) beforeSequence = continuationSequence + 1;

  let inheritedBySequence: Map<number, MissionChatEntry[]> | undefined;
  const inheritedEntriesFor = async (sequence: number): Promise<readonly MissionChatEntry[]> => {
    if (input.loadInheritedEntries === undefined) return [];
    if (inheritedBySequence === undefined) {
      inheritedBySequence = new Map();
      for (const entry of await input.loadInheritedEntries()) {
        if (entry.kind === "user" || entry.timelineSequence === undefined) continue;
        inheritedBySequence.set(entry.timelineSequence, [
          ...(inheritedBySequence.get(entry.timelineSequence) ?? []),
          entry,
        ]);
      }
    }
    return inheritedBySequence.get(sequence) ?? [];
  };

  let remaining = input.query.limit;
  let collected: MissionChatEntry[] = [];
  const syncIssues: MissionChatSyncIssue[] = [];
  let nextBeforeCursor: string | undefined;
  let omittedEntries = 0;
  let truncatedFields = 0;
  let firstTimelineRead = true;

  while (remaining > 0) {
    const timeline = await input.missions.readTimelinePage(input.missionId, {
      ...(beforeSequence === undefined ? {} : { beforeSequence }),
      limit: Math.min(100, Math.max(1, remaining)),
    });
    if (timeline.turns.length === 0) break;

    for (let index = timeline.turns.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const turn = timeline.turns[index]!;
      const turnCursor =
        firstTimelineRead && continuationSequence === turn.sequence ? cursor : undefined;
      const page = await readMissionChatTurnPage({
        missionId: input.missionId,
        turn,
        limit: remaining,
        executionStore: input.executionStore,
        missions: input.missions,
        rootOnly: input.rootOnly,
        ...(turnCursor === undefined || turnCursor.kind === "timeline"
          ? {}
          : { cursor: turnCursor }),
        ...(input.activeChat === undefined ? {} : { activeChat: input.activeChat }),
        inheritedEntries:
          turn.executionId === undefined ? await inheritedEntriesFor(turn.sequence) : [],
      });
      collected = [...page.entries, ...collected];
      syncIssues.push(...page.syncIssues);
      omittedEntries += page.truncation?.omittedEntries ?? 0;
      truncatedFields += page.truncation?.truncatedFields ?? 0;
      remaining -= page.entries.length;
      if (page.nextCursor !== undefined) {
        nextBeforeCursor = encodeMissionChatPageCursor(page.nextCursor);
        remaining = 0;
        break;
      }
      if (remaining === 0) {
        const hasEarlierTimeline = index > 0 || timeline.nextBeforeSequence !== undefined;
        if (hasEarlierTimeline) {
          nextBeforeCursor = encodeMissionChatPageCursor({
            version: 1,
            kind: "timeline",
            beforeSequence: turn.sequence,
          });
        }
        break;
      }
    }

    firstTimelineRead = false;
    if (remaining === 0 || timeline.nextBeforeSequence === undefined) break;
    beforeSequence = timeline.nextBeforeSequence;
  }

  const sequences = collected.flatMap((entry) =>
    entry.timelineSequence === undefined ? [] : [entry.timelineSequence],
  );
  return {
    entries: collected,
    syncIssues,
    ...(sequences.length === 0 ? {} : { oldestSequence: Math.min(...sequences) }),
    ...(sequences.length === 0 ? {} : { newestSequence: Math.max(...sequences) }),
    ...(nextBeforeCursor === undefined ? {} : { nextBeforeCursor }),
    ...(omittedEntries === 0 && truncatedFields === 0
      ? {}
      : { truncation: { omittedEntries, truncatedFields } }),
  };
}

async function readMissionChatTurnPage(input: {
  readonly missionId: string;
  readonly turn: MissionTimelineTurn;
  readonly limit: number;
  readonly executionStore: ReturnType<typeof createFileExecutionStore>;
  readonly missions: MissionStore;
  readonly rootOnly: boolean;
  readonly cursor?: Exclude<MissionChatPageCursor, { readonly kind: "timeline" }> | undefined;
  readonly activeChat?: LiveMissionChat | undefined;
  readonly inheritedEntries: readonly MissionChatEntry[];
}): Promise<{
  readonly entries: readonly MissionChatEntry[];
  readonly syncIssues: readonly MissionChatSyncIssue[];
  readonly nextCursor?: MissionChatPageCursor | undefined;
  readonly truncation?:
    { readonly omittedEntries: number; readonly truncatedFields: number } | undefined;
}> {
  const userEntry: MissionChatEntry = {
    id: input.turn.message.id,
    timelineSequence: input.turn.sequence,
    kind: "user",
    content: input.turn.message.content,
    ...(input.turn.message.attachments === undefined
      ? {}
      : { attachments: input.turn.message.attachments }),
    createdAt: input.turn.message.createdAt,
    ...(input.turn.executionId === undefined ? {} : { executionId: input.turn.executionId }),
  };
  if (
    input.cursor?.kind === "turn-start" ||
    (input.turn.executionId === undefined && input.inheritedEntries.length === 0)
  ) {
    return { entries: [userEntry], syncIssues: [] };
  }

  if (
    input.turn.executionId !== undefined &&
    input.inheritedEntries.length === 0 &&
    input.turn.executionId !== input.activeChat?.executionId &&
    (input.cursor === undefined ||
      input.cursor.kind === "projection" ||
      input.cursor.kind === "entries")
  ) {
    const projectionPage = await input.missions.readExecutionProjectionPage(
      input.missionId,
      input.turn.executionId,
      { limit: 1_000 },
    );
    const projection = projectionPage?.entries;
    // Legacy and interrupted versions can have a complete Execution without a
    // terminal Mission projection. The Execution state is the authority that
    // decides whether durable history can still be reconstructed; treating a
    // missing projection as a missing Execution makes retries deterministically
    // fail even though all source records remain readable.
    const executionState = await input.executionStore
      .get(input.turn.executionId)
      .catch(() => undefined);
    // A terminal projection is immutable and already bounded for UI reads.
    // Retaining the canonical state file after archival must not force every
    // history page to inflate and decode the complete archived event stream.
    if (
      projectionPage !== undefined &&
      (executionState === undefined ||
        (isMissionTerminalExecutionStatus(executionState.status) &&
          projectionPage.orderingVersion === MISSION_EXECUTION_PROJECTION_ORDERING_VERSION &&
          projectionPage.sourceUpdatedAt !== undefined &&
          projectionPage.sourceUpdatedAt >= executionState.updatedAt))
    ) {
      const completeProjection =
        executionState === undefined
          ? projectionPage.entries
          : ensureTerminalExecutionResultEntry(projectionPage.entries, executionState);
      const projectedEntries = finalizeHistoricalChatEntries(
        orderMissionExecutionEntries(completeProjection),
        true,
        executionState?.rootInvocationId,
      )
        .filter(
          (entry) =>
            !input.rootOnly ||
            entry.invocationId === undefined ||
            entry.invocationId === executionState?.rootInvocationId,
        )
        .map((entry) => ({
          ...entry,
          timelineSequence: entry.timelineSequence ?? input.turn.sequence,
        }));
      const combined = [userEntry, ...projectedEntries];
      const entryCursor = input.cursor?.kind === "entries" ? input.cursor : undefined;
      const requestedEnd =
        entryCursor === undefined
          ? combined.length
          : combined.findIndex((entry) =>
              entryCursor.version === 1
                ? entry.id === entryCursor.beforeEntryId
                : missionChatEntryHash(entry.id) === entryCursor.beforeEntryHash,
            );
      // Legacy byte cursors cannot be mapped safely after an atomic file
      // replacement. Reset them to the latest stable keyset page; entry IDs
      // keep renderer de-duplication deterministic.
      const safeEnd = input.cursor?.kind === "projection" ? combined.length : requestedEnd;
      if (safeEnd < 0) throw new Error("Mission chat page cursor is no longer available.");
      const start = Math.max(0, safeEnd - input.limit);
      return {
        entries: combined.slice(start, safeEnd),
        syncIssues: [],
        ...(projectionPage.omittedEntries === 0 && projectionPage.truncatedFields === 0
          ? {}
          : {
              truncation: {
                omittedEntries: projectionPage.omittedEntries,
                truncatedFields: projectionPage.truncatedFields,
              },
            }),
        ...(start === 0
          ? {}
          : {
              nextCursor: {
                version: 2 as const,
                kind: "entries" as const,
                sequence: input.turn.sequence,
                beforeEntryHash: missionChatEntryHash(combined[start]!.id),
              },
            }),
      };
    }
    if (projection === undefined && executionState === undefined) {
      return { entries: [userEntry], syncIssues: [missionChatSyncIssue("history")] };
    }
  }

  const history = await readMissionChatHistory(
    [input.turn],
    input.executionStore,
    input.missions,
    input.missionId,
    input.activeChat,
    input.rootOnly,
  );
  const activeEntries =
    input.activeChat !== undefined && input.turn.executionId === input.activeChat.executionId
      ? input.activeChat.entries
      : [];
  const combined = mergeMissionChatEntriesWithLive(
    [
      ...history.entries,
      ...input.inheritedEntries.map((entry) => ({
        ...entry,
        timelineSequence: entry.timelineSequence ?? input.turn.sequence,
      })),
    ],
    activeEntries.map((entry) => ({
      ...entry,
      timelineSequence: entry.timelineSequence ?? input.turn.sequence,
    })),
  );
  const entryCursor = input.cursor?.kind === "entries" ? input.cursor : undefined;
  const requestedEnd =
    entryCursor === undefined
      ? combined.length
      : combined.findIndex((entry) =>
          entryCursor.version === 1
            ? entry.id === entryCursor.beforeEntryId
            : missionChatEntryHash(entry.id) === entryCursor.beforeEntryHash,
        );
  if (requestedEnd < 0) throw new Error("Mission chat page cursor is no longer available.");
  const start = Math.max(0, requestedEnd - input.limit);
  return {
    entries: combined.slice(start, requestedEnd),
    syncIssues: history.syncIssues,
    ...(start === 0
      ? {}
      : {
          nextCursor: {
            version: 2 as const,
            kind: "entries" as const,
            sequence: input.turn.sequence,
            beforeEntryHash: missionChatEntryHash(combined[start]!.id),
          },
        }),
  };
}

function uniqueMissionChatEntriesById(entries: readonly MissionChatEntry[]): MissionChatEntry[] {
  const byId = new Map<string, MissionChatEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
}

export function mergeMissionChatEntriesWithLive(
  durable: readonly MissionChatEntry[],
  live: readonly MissionChatEntry[],
): MissionChatEntry[] {
  const durableEntries = uniqueMissionChatEntriesById(durable);
  const merged = uniqueMissionChatEntriesById(live);
  const liveIds = new Set(merged.map((entry) => entry.id));
  const firstSharedIndex = durableEntries.findIndex((entry) => liveIds.has(entry.id));
  let nextAnchor = merged.length;
  for (let index = durableEntries.length - 1; index >= 0; index -= 1) {
    const entry = durableEntries[index]!;
    if (liveIds.has(entry.id)) {
      nextAnchor = merged.findIndex((candidate) => candidate.id === entry.id);
      const current = merged[nextAnchor]!;
      merged[nextAnchor] = {
        ...current,
        ...(current.timelineSequence === undefined && entry.timelineSequence !== undefined
          ? { timelineSequence: entry.timelineSequence }
          : {}),
        ...(current.eventSequence === undefined && entry.eventSequence !== undefined
          ? { eventSequence: entry.eventSequence }
          : {}),
        ...(current.executorId === undefined && entry.executorId !== undefined
          ? { executorId: entry.executorId }
          : {}),
        ...(current.executorName === undefined && entry.executorName !== undefined
          ? { executorName: entry.executorName }
          : {}),
        ...(current.executorAvatarId === undefined && entry.executorAvatarId !== undefined
          ? { executorAvatarId: entry.executorAvatarId }
          : {}),
        ...(current.kind === "assistant" &&
        entry.kind === "assistant" &&
        current.finalAnswer === undefined &&
        entry.finalAnswer !== undefined
          ? { finalAnswer: entry.finalAnswer }
          : {}),
      } as MissionChatEntry;
    } else {
      merged.splice(firstSharedIndex < 0 || index < firstSharedIndex ? 0 : nextAnchor, 0, entry);
    }
  }
  return placeThinkingBeforeFinalAnswer(merged);
}

function placeThinkingBeforeFinalAnswer(entries: readonly MissionChatEntry[]): MissionChatEntry[] {
  const ordered = [...entries];
  for (const entry of entries) {
    if (entry.kind !== "thinking") continue;
    const runKey = missionMessageRunKey(entry.id);
    if (runKey === undefined) continue;
    const finalIndex = ordered.findIndex(
      (candidate) =>
        candidate.kind === "assistant" &&
        candidate.finalAnswer === true &&
        missionMessageRunKey(candidate.id) === runKey,
    );
    const thinkingIndex = ordered.findIndex((candidate) => candidate.id === entry.id);
    if (finalIndex < 0 || thinkingIndex < finalIndex) continue;
    ordered.splice(thinkingIndex, 1);
    ordered.splice(finalIndex, 0, entry);
  }
  return ordered;
}

function missionMessageRunKey(entryId: string): string | undefined {
  return /^(message:.+):(assistant|thinking):\d+$/.exec(entryId)?.[1];
}

function missionChatEntryHash(entryId: string): string {
  return createHash("sha256").update(entryId, "utf8").digest("hex");
}

export function encodeMissionChatPageCursor(cursor: MissionChatPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeMissionChatPageCursor(
  value: string | undefined,
): MissionChatPageCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid cursor shape");
    }
    const cursor = parsed as Record<string, unknown>;
    if (
      (cursor["version"] !== 1 && cursor["version"] !== 2) ||
      typeof cursor["kind"] !== "string"
    ) {
      throw new Error("invalid cursor version");
    }
    if (
      cursor["version"] === 1 &&
      cursor["kind"] === "timeline" &&
      Number.isInteger(cursor["beforeSequence"]) &&
      (cursor["beforeSequence"] as number) > 0
    ) {
      return {
        version: 1,
        kind: "timeline",
        beforeSequence: cursor["beforeSequence"] as number,
      };
    }
    if (
      cursor["version"] === 1 &&
      cursor["kind"] === "projection" &&
      Number.isInteger(cursor["sequence"]) &&
      (cursor["sequence"] as number) > 0 &&
      Number.isInteger(cursor["beforeOffset"]) &&
      (cursor["beforeOffset"] as number) >= 0
    ) {
      return {
        version: 1,
        kind: "projection",
        sequence: cursor["sequence"] as number,
        beforeOffset: cursor["beforeOffset"] as number,
      };
    }
    if (
      cursor["version"] === 1 &&
      cursor["kind"] === "entries" &&
      Number.isInteger(cursor["sequence"]) &&
      (cursor["sequence"] as number) > 0 &&
      typeof cursor["beforeEntryId"] === "string" &&
      cursor["beforeEntryId"] !== ""
    ) {
      return {
        version: 1,
        kind: "entries",
        sequence: cursor["sequence"] as number,
        beforeEntryId: cursor["beforeEntryId"],
      };
    }
    if (
      cursor["version"] === 2 &&
      cursor["kind"] === "entries" &&
      Number.isSafeInteger(cursor["sequence"]) &&
      (cursor["sequence"] as number) > 0 &&
      typeof cursor["beforeEntryHash"] === "string" &&
      /^[0-9a-f]{64}$/u.test(cursor["beforeEntryHash"])
    ) {
      return {
        version: 2,
        kind: "entries",
        sequence: cursor["sequence"] as number,
        beforeEntryHash: cursor["beforeEntryHash"],
      };
    }
    if (
      cursor["version"] === 1 &&
      cursor["kind"] === "turn-start" &&
      Number.isInteger(cursor["sequence"]) &&
      (cursor["sequence"] as number) > 0
    ) {
      return {
        version: 1,
        kind: "turn-start",
        sequence: cursor["sequence"] as number,
      };
    }
    throw new Error("invalid cursor fields");
  } catch {
    throw new Error("Mission chat page cursor is invalid.");
  }
}

export async function readMissionChatHistory(
  turns: readonly MissionTimelineTurn[],
  executionStore: ReturnType<typeof createFileExecutionStore>,
  missions: MissionStore,
  missionId: string,
  activeChat?: LiveMissionChat,
  rootOnly = false,
): Promise<{
  readonly entries: MissionChatEntry[];
  readonly syncIssues: MissionChatSyncIssue[];
}> {
  const entries: MissionChatEntry[] = [];
  const syncIssues: MissionChatSyncIssue[] = [];
  for (const turn of turns) {
    entries.push({
      id: turn.message.id,
      timelineSequence: turn.sequence,
      kind: "user",
      content: turn.message.content,
      ...(turn.message.attachments === undefined ? {} : { attachments: turn.message.attachments }),
      createdAt: turn.message.createdAt,
      ...(turn.executionId === undefined ? {} : { executionId: turn.executionId }),
    });
    if (turn.executionId === undefined) continue;

    const activeEntries =
      turn.executionId === activeChat?.executionId ? activeChat.entries : undefined;
    // Once the live projection has visible output it is the cheapest and freshest source for an
    // active Execution. Before its replayable subscription catches up, read the durable history so
    // a cold navigation cannot briefly show only the user prompt. Completion-only and oversized
    // results have no live entry, so they still take the durable path and receive finalization.
    if (activeEntries !== undefined && activeEntries.length > 0) continue;

    const view = new StoredExecutionView(turn.executionId, executionStore);
    const state = await view.getState().catch(() => undefined);
    if (activeEntries !== undefined && state === undefined) continue;
    if (state === undefined) {
      const projection = await missions.readExecutionProjection(missionId, turn.executionId);
      if (projection !== undefined) {
        entries.push(...finalizeHistoricalChatEntries(projection, true));
        continue;
      }
      syncIssues.push(missionChatSyncIssue("history"));
      entries.push({
        id: `missing:${turn.executionId}`,
        timelineSequence: turn.sequence,
        executionId: turn.executionId,
        kind: "assistant",
        content: "Execution history unavailable.",
        streaming: false,
        createdAt: turn.message.createdAt,
      });
      continue;
    }
    let histories;
    let activityEntries;
    try {
      histories = await view.getMessageHistory({
        scope: rootOnly ? { kind: "root" } : { kind: "all" },
      });
      const executorIdsByInvocation = new Map(
        histories.flatMap((history) =>
          history.executorId === undefined
            ? []
            : ([[history.invocationId, history.executorId]] as const),
        ),
      );
      activityEntries = await readHistoricalRuntimeActivityEntries(
        view,
        turn.sequence,
        state.rootInvocationId,
        (invocationId) => executorIdsByInvocation.get(invocationId),
        rootOnly,
      );
    } catch {
      const projection = await missions.readExecutionProjection(missionId, turn.executionId);
      if (projection !== undefined) {
        entries.push(...finalizeHistoricalChatEntries(projection, true, state.rootInvocationId));
        continue;
      }
      syncIssues.push(missionChatSyncIssue("history"));
      entries.push({
        id: `missing:${turn.executionId}`,
        timelineSequence: turn.sequence,
        executionId: turn.executionId,
        kind: "assistant",
        content: "Execution history unavailable.",
        streaming: false,
        createdAt: state.updatedAt,
      });
      continue;
    }
    const richEntries = finalizeHistoricalChatEntries(
      orderMissionExecutionEntries([
        ...messageRecordsToChatEntries(
          histories
            .flatMap((history) => history.messages)
            .filter((record) => record.source?.parentSessionId === undefined),
        ).map((entry) => ({
          ...entry,
          timelineSequence: turn.sequence,
        })),
        ...activityEntries,
      ]),
      isMissionTerminalExecutionStatus(state.status),
      state.rootInvocationId,
    );
    entries.push(...richEntries);
    if (
      isMissionTerminalExecutionStatus(state.status) &&
      !richEntries.some((entry) => entry.kind === "assistant")
    ) {
      entries.push({
        id: `result:${turn.executionId}`,
        timelineSequence: turn.sequence,
        executionId: turn.executionId,
        kind: "assistant",
        content: executionFallback(state.status, state.output, state.error),
        streaming: false,
        createdAt: state.updatedAt,
      });
    }
  }
  return { entries, syncIssues };
}

export type MissionChatSyncIssue = NonNullable<MissionConversationSnapshot["syncIssues"]>[number];

export function missionChatSyncIssue(
  section: MissionChatSyncIssue["section"],
): MissionChatSyncIssue {
  return { code: "execution_state_unavailable", section, retryable: true };
}

async function readHistoricalRuntimeActivityEntries(
  view: Pick<ExecutionView, "executionId" | "listEvents">,
  timelineSequence: number,
  rootInvocationId: string,
  resolveExecutorId: (invocationId: string) => string | undefined,
  rootOnly = false,
): Promise<MissionChatEntry[]> {
  const events: Array<{
    readonly event: ExpertAgentStreamEvent;
    readonly invocationId: string;
    readonly sequence: number;
  }> = [];
  let after: { executionId: string; sequence: number } | undefined;
  do {
    const page = await view.listEvents({
      scope: rootOnly ? { kind: "root" } : { kind: "all" },
      limit: 1_000,
      after,
    });
    for (const event of page.items) {
      if (event.type !== "runtime.event") continue;
      const parsed = ExpertAgentStreamEventSchema.safeParse(event.data);
      if (
        parsed.success &&
        (parsed.data.type === "agent.command" ||
          parsed.data.type.startsWith("run.") ||
          (parsed.data.type === "progress" &&
            isRuntimeContextCompactionStage(parsed.data.payload.stage)))
      ) {
        events.push({
          event: parsed.data,
          invocationId: event.invocationId,
          sequence: event.cursor.sequence,
        });
      }
    }
    after = page.nextCursor;
  } while (after !== undefined);
  const byId = new Map<string, MissionChatEntry>();
  for (const record of events) {
    const { event } = record;
    const executorId = resolveExecutorId(record.invocationId);
    if (event.type === "progress") {
      if (record.invocationId !== rootInvocationId || !isRootMissionRuntimeSource(event.source)) {
        continue;
      }
      const data = readRuntimeContextCompactionProgressData(event.payload.data);
      if (data === undefined || !isRuntimeContextCompactionStage(event.payload.stage)) continue;
      const id = `context:${view.executionId}:${data.operationId}`;
      const existing = byId.get(id);
      byId.set(id, {
        id,
        timelineSequence,
        eventSequence: existing?.eventSequence ?? record.sequence,
        executionId: view.executionId,
        invocationId: record.invocationId,
        ...(executorId === undefined ? {} : { executorId }),
        kind: "context_operation",
        operationId: data.operationId,
        operation: "compaction",
        trigger: data.trigger,
        runtimeId: data.runtimeId,
        status:
          event.payload.stage === RUNTIME_CONTEXT_COMPACTION_STAGES.started
            ? "running"
            : event.payload.stage === RUNTIME_CONTEXT_COMPACTION_STAGES.completed
              ? "succeeded"
              : "failed",
        ...(data.errorMessage === undefined ? {} : { error: data.errorMessage }),
        createdAt: existing?.createdAt ?? event.emittedAt,
      });
      continue;
    }
    const isCommand = event.type === "agent.command";
    if (!isCommand && event.source.parentSessionId === undefined) continue;
    const action = isCommand ? event.payload.action : "run";
    const commandId = isCommand
      ? event.payload.commandId
      : `${event.source.sessionId ?? event.runId}:${event.runId}:run`;
    const phase = isCommand
      ? event.payload.phase
      : event.type === "run.started"
        ? "started"
        : event.type === "run.completed"
          ? "completed"
          : "failed";
    byId.set(`agent:${view.executionId}:${commandId}`, {
      id: `agent:${view.executionId}:${commandId}`,
      timelineSequence,
      eventSequence:
        byId.get(`agent:${view.executionId}:${commandId}`)?.eventSequence ?? record.sequence,
      executionId: view.executionId,
      invocationId: record.invocationId,
      ...(executorId === undefined ? {} : { executorId }),
      kind: "agent_activity",
      commandId,
      action,
      phase,
      ...(isCommand && event.payload.senderSessionId !== undefined
        ? { senderSessionId: event.payload.senderSessionId }
        : {}),
      targetSessionIds: isCommand
        ? event.payload.targetSessionIds
        : event.source.sessionId === undefined
          ? []
          : [event.source.sessionId],
      ...(event.source.displayName === undefined ? {} : { label: event.source.displayName }),
      ...(isCommand && event.payload.error !== undefined
        ? { error: truncate(event.payload.error, MISSION_CHAT_ERROR_MAX_LENGTH) }
        : event.type === "run.failed"
          ? { error: truncate(event.payload.message, MISSION_CHAT_ERROR_MAX_LENGTH) }
          : {}),
      createdAt: event.emittedAt,
    });
  }
  return [...byId.values()];
}

export function orderMissionExecutionEntries(
  entries: readonly MissionChatEntry[],
): MissionChatEntry[] {
  return [...entries].toSorted((left, right) => {
    if (left.eventSequence === undefined || right.eventSequence === undefined) return 0;
    return left.eventSequence - right.eventSequence;
  });
}

function executionFallback(status: string, output: unknown, error: unknown): string {
  if (status === "succeeded") {
    const content = formatValue(output, 200_000).trim();
    return content === "" ? "Execution completed without a text result." : content;
  }
  if (status === "cancelled" || status === "interrupted") return "Execution interrupted.";
  const message = readErrorMessage(error);
  return message === "" ? "Execution failed." : `Execution failed: ${message}`;
}

export function ensureTerminalExecutionResultEntry(
  entries: readonly Exclude<MissionChatEntry, { readonly kind: "user" }>[],
  execution: TerminalExecutionResultSource,
): Exclude<MissionChatEntry, { readonly kind: "user" }>[];
export function ensureTerminalExecutionResultEntry(
  entries: readonly MissionChatEntry[],
  execution: TerminalExecutionResultSource,
): MissionChatEntry[];
export function ensureTerminalExecutionResultEntry(
  entries: readonly MissionChatEntry[],
  execution: TerminalExecutionResultSource,
): MissionChatEntry[] {
  if (execution.status !== "succeeded") return [...entries];
  const content = missionWorkOutputSummary(execution.output, 200_000);
  if (content === undefined || content === "") return [...entries];
  const matchingIndex = entries.findLastIndex(
    (entry) =>
      entry.kind === "assistant" &&
      entry.invocationId === execution.rootInvocationId &&
      entry.content === content,
  );
  if (matchingIndex >= 0) {
    return entries.map((entry, index) =>
      index === matchingIndex && entry.kind === "assistant"
        ? { ...entry, streaming: false, finalAnswer: true }
        : entry,
    );
  }
  const presentation = entries.findLast(
    (entry) =>
      entry.invocationId === execution.rootInvocationId &&
      (entry.executorId !== undefined ||
        entry.executorName !== undefined ||
        entry.executorAvatarId !== undefined),
  );
  return [
    ...entries,
    {
      id: `result:${execution.executionId}`,
      executionId: execution.executionId,
      invocationId: execution.rootInvocationId,
      ...(presentation?.executorId === undefined ? {} : { executorId: presentation.executorId }),
      ...(presentation?.executorName === undefined
        ? {}
        : { executorName: presentation.executorName }),
      ...(presentation?.executorAvatarId === undefined
        ? {}
        : { executorAvatarId: presentation.executorAvatarId }),
      kind: "assistant",
      content,
      streaming: false,
      finalAnswer: true,
      createdAt: execution.updatedAt,
    },
  ];
}

interface TerminalExecutionResultSource {
  readonly executionId: string;
  readonly rootInvocationId: string;
  readonly status: string;
  readonly output?: unknown;
  readonly updatedAt: string;
}

export function readErrorMessage(error: unknown): string {
  if (typeof error === "string") return error.trim();
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message).trim();
  }
  return error === undefined ? "" : String(error).trim();
}

export function finalizeHistoricalChatEntries(
  entries: readonly MissionChatEntry[],
  executionTerminal = true,
  rootInvocationId?: string,
): MissionChatEntry[] {
  if (!executionTerminal) return [...entries];
  const finalized = entries.map((entry): MissionChatEntry =>
    entry.kind === "tool" && entry.status === "running"
      ? {
          ...entry,
          status: "failed",
          error: entry.error ?? "Execution ended before this tool completed.",
        }
      : entry.kind === "context_operation" && entry.status === "running"
        ? {
            ...entry,
            status: "failed",
            error: entry.error ?? "Execution ended before context compaction completed.",
          }
        : entry,
  );
  const finalAnswerIndex = finalized.findLastIndex(
    (entry) =>
      entry.kind === "assistant" &&
      (rootInvocationId === undefined || entry.invocationId === rootInvocationId) &&
      entry.streaming === false &&
      entry.finalAnswer === true,
  );
  if (finalAnswerIndex < 0 || finalAnswerIndex === finalized.length - 1) return finalized;
  const finalAnswer = finalized[finalAnswerIndex]!;
  return [
    ...finalized.slice(0, finalAnswerIndex),
    ...finalized.slice(finalAnswerIndex + 1),
    finalAnswer,
  ];
}

export function workTaskInputEntries(record: ExecutionWorkRecord): MissionChatEntry[] {
  return record.tasks.flatMap((task) => {
    const content = workTaskInputContent(task.input);
    if (content === "") return [];
    return [
      {
        id: `work-input:${task.taskId}`,
        executionId: task.executionId,
        invocationId: task.invocationId,
        kind: "user" as const,
        content,
        createdAt: task.createdAt,
      },
    ];
  });
}

function workTaskInputContent(input: unknown): string {
  if (typeof input === "string") return truncate(input.trim(), 200_000);
  if (
    typeof input === "object" &&
    input !== null &&
    "prompt" in input &&
    typeof input.prompt === "string"
  ) {
    return truncate(input.prompt.trim(), 200_000);
  }
  return formatValue(input, 200_000).trim();
}

export function uniqueMissionChatEntries(entries: readonly MissionChatEntry[]): MissionChatEntry[] {
  const byId = new Map<string, MissionChatEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
}

export function messageRecordsToChatEntries(
  records: readonly AgentMessageRecord[],
): MissionChatEntry[] {
  const entries: MissionChatEntry[] = [];
  const messageOrdinals = new Map<string, number>();
  for (const record of [...records].sort((left, right) => left.sequence - right.sequence)) {
    const base = {
      executionId: record.executionId,
      invocationId: record.invocationId,
      eventSequence: record.sequence,
      ...(record.executorId === undefined ? {} : { executorId: record.executorId }),
      createdAt: new Date(record.message.timestamp).toISOString(),
    };
    if (record.message.role === "assistant") {
      const assistantMessage = record.message;
      assistantMessage.content.forEach((content, index) => {
        if (content.type === "thinking" && content.thinking !== "") {
          entries.push({
            ...base,
            id: durableMessageEntryId(record, "thinking", index, messageOrdinals),
            kind: "thinking",
            content: truncate(content.thinking, 200_000),
            streaming: false,
          });
        } else if (content.type === "text" && content.text !== "") {
          entries.push({
            ...base,
            id: durableMessageEntryId(record, "assistant", index, messageOrdinals),
            kind: "assistant",
            content: truncate(content.text, 200_000),
            streaming: false,
            ...(assistantMessage.stopReason === "stop" || assistantMessage.stopReason === "length"
              ? { finalAnswer: true }
              : {}),
          });
        } else if (content.type === "toolCall") {
          entries.push({
            ...base,
            id: `tool:${record.executionId}:${content.id}`,
            kind: "tool",
            toolCallId: content.id,
            toolName: content.name,
            status: "running",
            inputPreview: preview(content.arguments),
          });
        }
      });
      continue;
    }
    if (record.message.role !== "toolResult") continue;
    const message = record.message;
    const existingIndex = entries.findIndex(
      (entry) =>
        entry.kind === "tool" &&
        entry.executionId === record.executionId &&
        entry.toolCallId === message.toolCallId,
    );
    const outputPreview = preview(
      message.content
        .flatMap((content) => (content.type === "text" ? [content.text] : []))
        .join("\n"),
    );
    const tool: MissionChatEntry = {
      ...base,
      id: `tool:${record.executionId}:${message.toolCallId}`,
      kind: "tool",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      status: message.isError ? "failed" : "succeeded",
      ...(message.isError
        ? { error: outputPreview ?? "Tool failed." }
        : outputPreview === undefined
          ? {}
          : { outputPreview }),
    };
    const existing = entries[existingIndex];
    if (existingIndex === -1 || existing?.kind !== "tool") entries.push(tool);
    else
      entries[existingIndex] = {
        ...existing,
        ...tool,
        eventSequence: existing.eventSequence,
        createdAt: existing.createdAt,
      };
  }
  return entries;
}

function durableMessageEntryId(
  record: AgentMessageRecord,
  kind: "assistant" | "thinking",
  contentIndex: number,
  ordinals: Map<string, number>,
): string {
  if (record.runId === undefined) {
    return `${record.executionId}:${record.invocationId}:${record.sequence}:${contentIndex}`;
  }
  return nextMessageEntryId(record.executionId, record.invocationId, record.runId, kind, ordinals);
}

export function createMissionExecutorNameResolver(
  mission: Pick<Mission, "executor">,
  names: ReadonlyMap<string, string>,
): ExecutorNameResolver {
  // A Team or Flow name identifies the invocable resource, not the concrete Expert producing an
  // entry. Their Experts resolve through the pinned Project Revision; an unresolved identity is
  // left empty for the renderer's localized unavailable label rather than exposing its raw id.
  const rootExpertId =
    mission.executor.kind === "expert" && mission.executor.ref.startsWith("expert:")
      ? mission.executor.ref.slice("expert:".length)
      : undefined;
  return (executorId) =>
    names.get(executorId) ?? (executorId === rootExpertId ? mission.executor.name : undefined);
}

export function createMissionExecutorAvatarIdResolver(
  avatarIds: ReadonlyMap<string, string>,
): ExecutorAvatarIdResolver {
  return (executorId) => avatarIds.get(executorId);
}
