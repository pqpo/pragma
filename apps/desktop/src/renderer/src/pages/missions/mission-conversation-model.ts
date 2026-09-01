import type {
  MissionChatEntry,
  MissionChatPatch,
  MissionChatSnapshot,
  MissionChatUpdate,
} from "../../../../shared/contracts/index.ts";

import type {
  LocalMissionUserMessage,
  PendingMissionQueuedMessage,
} from "./mission-command-delivery.ts";

export interface LocalMissionContextOperation {
  readonly id: string;
  readonly createdAt: string;
  readonly status: "running" | "succeeded" | "skipped" | "failed";
  readonly error?: string | undefined;
}

export type MissionConversationEntry =
  | { readonly type: "durable"; readonly entry: MissionChatEntry }
  | { readonly type: "local"; readonly entry: LocalMissionUserMessage }
  | { readonly type: "context-operation"; readonly entry: LocalMissionContextOperation };

export type MissionConversationBlock =
  | { readonly type: "entry"; readonly item: MissionConversationEntry }
  | {
      readonly type: "tools";
      readonly entries: readonly Extract<MissionChatEntry, { kind: "tool" }>[];
      readonly collapsed: boolean;
    };

export function hidePreparingQueuedChatEntries(
  entries: readonly MissionChatEntry[],
  pendingRequestIds: ReadonlySet<string>,
): MissionChatEntry[] {
  return entries.filter((entry) => {
    if (!pendingRequestIds.has(entry.id)) return true;
    return entry.kind === "user" && entry.delivery?.status !== undefined
      ? entry.delivery.status !== "queued"
      : false;
  });
}

export function readyPendingQueuedRequestIds(
  pendingMessages: readonly PendingMissionQueuedMessage[],
  persistedQueuedRequestIds: ReadonlySet<string>,
  entries: readonly MissionChatEntry[],
): ReadonlySet<string> {
  const ready = new Set(
    pendingMessages
      .filter((message) => persistedQueuedRequestIds.has(message.requestId))
      .map((message) => message.requestId),
  );
  for (const entry of entries) {
    if (
      entry.kind === "user" &&
      entry.delivery?.status !== undefined &&
      entry.delivery.status !== "queued"
    ) {
      ready.add(entry.id);
    }
  }
  return ready;
}

export function hideInterruptedExecutionFallbackEntries(
  entries: readonly MissionChatEntry[],
): MissionChatEntry[] {
  return entries.filter(
    (entry) =>
      !(
        entry.kind === "assistant" &&
        entry.executionId !== undefined &&
        entry.id === `result:${entry.executionId}` &&
        entry.content === "Execution interrupted."
      ),
  );
}

export function missionTurnFinalReplyIds(
  entries: readonly MissionChatEntry[],
): ReadonlySet<string> {
  const finalByTurn = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== "assistant" || entry.streaming) continue;
    const turnKey =
      entry.timelineSequence === undefined
        ? entry.executionId === undefined
          ? undefined
          : `execution:${entry.executionId}`
        : `turn:${entry.timelineSequence}`;
    if (turnKey !== undefined) finalByTurn.set(turnKey, entry.id);
  }
  return new Set(finalByTurn.values());
}

export function startMissionContextOperation(
  current: readonly LocalMissionContextOperation[],
  input: { readonly id: string; readonly createdAt: string; readonly retry: boolean },
): LocalMissionContextOperation[] {
  if (!input.retry) {
    return [...current, { id: input.id, createdAt: input.createdAt, status: "running" }];
  }
  return current.map((operation) =>
    operation.id === input.id ? { ...operation, status: "running", error: undefined } : operation,
  );
}

export function groupMissionConversationEntries(
  entries: readonly MissionConversationEntry[],
): MissionConversationBlock[] {
  const blocks: MissionConversationBlock[] = [];
  let pendingToolGroups: Array<Extract<MissionChatEntry, { kind: "tool" }>[]> = [];
  const flushTools = (collapsed: boolean): void => {
    for (const group of pendingToolGroups) {
      blocks.push({ type: "tools", entries: group, collapsed });
    }
    pendingToolGroups = [];
  };

  for (const item of entries) {
    if (item.type === "durable" && item.entry.kind === "tool") {
      const currentGroup = pendingToolGroups.at(-1);
      const currentExecutor = currentGroup?.[0]
        ? missionChatEntryExecutorKey(currentGroup[0])
        : undefined;
      const nextExecutor = missionChatEntryExecutorKey(item.entry);
      if (currentGroup === undefined || currentExecutor !== nextExecutor) {
        pendingToolGroups.push([item.entry]);
      } else {
        currentGroup.push(item.entry);
      }
      continue;
    }
    flushTools(
      item.type === "durable" &&
        (item.entry.kind === "assistant" || item.entry.kind === "thinking"),
    );
    blocks.push({ type: "entry", item });
  }
  flushTools(false);
  return blocks;
}

export function applyMissionChatPatches(
  snapshot: MissionChatSnapshot,
  patches: readonly MissionChatPatch[],
  revision: number,
): MissionChatSnapshot | null {
  const entries = [...snapshot.entries];
  const entryIndexById = new Map(entries.map((entry, index) => [entry.id, index] as const));
  for (const patch of patches) {
    if (patch.type === "context-window.update") {
      if (snapshot.contextWindow === undefined) return null;
      snapshot = {
        ...snapshot,
        contextWindow: { ...snapshot.contextWindow, usage: patch.usage },
      };
      continue;
    }
    if (patch.type === "entry.upsert") {
      const existingIndex = entryIndexById.get(patch.entry.id);
      if (existingIndex === undefined) {
        entryIndexById.set(patch.entry.id, entries.length);
        entries.push({ ...patch.entry });
      } else {
        const existing = entries[existingIndex]!;
        entries[existingIndex] = {
          ...patch.entry,
          ...(patch.entry.timelineSequence === undefined && existing.timelineSequence !== undefined
            ? { timelineSequence: existing.timelineSequence }
            : {}),
          ...(patch.entry.executorName === undefined && existing.executorName !== undefined
            ? { executorName: existing.executorName }
            : {}),
          ...(patch.entry.executorAvatarId === undefined && existing.executorAvatarId !== undefined
            ? { executorAvatarId: existing.executorAvatarId }
            : {}),
        };
      }
      continue;
    }
    const index = entryIndexById.get(patch.entryId);
    if (index === undefined) return null;
    const entry = entries[index]!;
    if (patch.type === "entry.streaming") {
      if (entry.kind !== "assistant" && entry.kind !== "thinking") return null;
      entries[index] = { ...entry, streaming: patch.streaming };
      continue;
    }
    if (patch.field === "content") {
      if (entry.kind !== "assistant" && entry.kind !== "thinking") return null;
      entries[index] = {
        ...entry,
        content: truncateChatStream(`${entry.content}${patch.delta}`, 200_000),
      };
      continue;
    }
    if (entry.kind !== "tool") return null;
    entries[index] = {
      ...entry,
      outputPreview: truncateChatStream(`${entry.outputPreview ?? ""}${patch.delta}`, 801),
    };
  }
  return { ...snapshot, revision, entries };
}

export function missionChatPatchesRequireRender(patches: readonly MissionChatPatch[]): boolean {
  return patches.some((patch) => patch.type !== "entry.append" || patch.field !== "content");
}

export function firstVisiblePatchExecutionId(
  update: MissionChatUpdate,
  snapshot: MissionChatSnapshot | null,
): string | undefined {
  if (update.kind !== "patch") return undefined;
  for (const patch of update.patches) {
    if (patch.type === "context-window.update") continue;
    if (patch.type === "entry.upsert") {
      if (
        (patch.entry.kind === "assistant" || patch.entry.kind === "thinking") &&
        patch.entry.content.length > 0
      ) {
        return patch.entry.executionId ?? snapshot?.execution?.id;
      }
      continue;
    }
    if (patch.type !== "entry.append" || patch.field !== "content" || patch.delta.length === 0) {
      continue;
    }
    return (
      snapshot?.entries.find((entry) => entry.id === patch.entryId)?.executionId ??
      snapshot?.execution?.id
    );
  }
  return undefined;
}

export function shouldClearMissionThinkingPlaceholder(
  chat: MissionChatSnapshot,
  requestId: string,
): boolean {
  const userIndex = chat.entries.findIndex((entry) => entry.id === requestId);
  if (userIndex < 0) return false;
  if (chat.entries.slice(userIndex + 1).some((entry) => entry.kind !== "user")) return true;

  const userEntry = chat.entries[userIndex];
  return (
    userEntry?.kind === "user" &&
    userEntry.executionId !== undefined &&
    userEntry.executionId === chat.execution?.id &&
    !["queued", "running", "waiting"].includes(chat.execution.status)
  );
}

export function shouldShowMissionThinkingPlaceholder(
  chat: MissionChatSnapshot | null,
  requestId: string | null,
): boolean {
  return (
    requestId !== null && (chat === null || !shouldClearMissionThinkingPlaceholder(chat, requestId))
  );
}

export function mergeLatestChatPage(
  current: MissionChatSnapshot | null,
  latest: MissionChatSnapshot,
): MissionChatSnapshot {
  if (current === null || current.missionId !== latest.missionId) return latest;
  const unavailableSections = new Set(latest.syncIssues?.map((issue) => issue.section) ?? []);
  const latestOldest = latest.page.oldestSequence;
  const latestEntryIds = new Set(latest.entries.map((entry) => entry.id));
  const currentEntriesById = new Map(current.entries.map((entry) => [entry.id, entry] as const));
  const latestEntries = latest.entries.map((entry) => {
    const existing = currentEntriesById.get(entry.id);
    if (
      (entry.kind === "assistant" || entry.kind === "thinking") &&
      existing?.kind === entry.kind &&
      existing.content.length > entry.content.length &&
      existing.content.startsWith(entry.content)
    ) {
      return { ...entry, content: existing.content };
    }
    return entry;
  });
  const retainedOlder =
    latestOldest === undefined
      ? []
      : current.entries.filter(
          (entry) =>
            entry.timelineSequence !== undefined &&
            (entry.timelineSequence < latestOldest ||
              (entry.timelineSequence === latestOldest && !latestEntryIds.has(entry.id))),
        );
  const retainedUnavailableHistory = unavailableSections.has("history") ? current.entries : [];
  const latestPageWithoutCursor = { ...latest.page };
  delete latestPageWithoutCursor.nextBeforeCursor;
  return {
    ...latest,
    entries: uniqueChatEntries([...retainedOlder, ...retainedUnavailableHistory, ...latestEntries]),
    page:
      retainedOlder.length === 0
        ? latest.page
        : {
            ...latestPageWithoutCursor,
            ...(current.page.nextBeforeCursor === undefined
              ? {}
              : { nextBeforeCursor: current.page.nextBeforeCursor }),
          },
    pendingInteractions: unavailableSections.has("pending_interactions")
      ? current.pendingInteractions
      : latest.pendingInteractions,
    ...(unavailableSections.has("context_window") && current.contextWindow !== undefined
      ? { contextWindow: current.contextWindow }
      : {}),
  };
}

export function prependChatPage(
  current: MissionChatSnapshot,
  earlier: MissionChatSnapshot,
): MissionChatSnapshot {
  return {
    ...current,
    revision: Math.max(current.revision, earlier.revision),
    entries: uniqueChatEntries([...earlier.entries, ...current.entries]),
    page: {
      ...(earlier.page.oldestSequence === undefined
        ? {}
        : { oldestSequence: earlier.page.oldestSequence }),
      ...(current.page.newestSequence === undefined
        ? {}
        : { newestSequence: current.page.newestSequence }),
      ...(earlier.page.nextBeforeCursor === undefined
        ? {}
        : { nextBeforeCursor: earlier.page.nextBeforeCursor }),
    },
  };
}

export function uniqueChatEntries(entries: readonly MissionChatEntry[]): MissionChatEntry[] {
  const byId = new Map<string, MissionChatEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
}

function missionChatEntryExecutorKey(entry: MissionChatEntry): string {
  if (entry.executorId !== undefined) return `id:${entry.executorId}`;
  if (entry.executorName !== undefined) return `name:${entry.executorName}`;
  return "unknown";
}

function truncateChatStream(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`;
}
