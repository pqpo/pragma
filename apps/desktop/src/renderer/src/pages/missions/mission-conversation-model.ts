import type {
  MissionChatEntry,
  MissionChatPatch,
  MissionConversationSnapshot,
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

export function hideQueuedChatEntries(
  entries: readonly MissionChatEntry[],
  queuedRequestIds: ReadonlySet<string>,
): MissionChatEntry[] {
  return entries.filter(
    (entry) =>
      entry.kind !== "user" ||
      (!queuedRequestIds.has(entry.id) && entry.delivery?.status !== "queued"),
  );
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

export function teamCoordinatorChatEntries(
  entries: readonly MissionChatEntry[],
  coordinatorId: string | undefined,
): MissionChatEntry[] {
  return entries.filter(
    (entry) =>
      entry.kind === "user" || entry.executorId === undefined || entry.executorId === coordinatorId,
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

export function orderMissionConversationEntries(
  entries: readonly MissionConversationEntry[],
): MissionConversationEntry[] {
  const durable = entries.filter((entry) => entry.type === "durable");
  const activated = durable
    .filter(
      (
        item,
      ): item is Extract<MissionConversationEntry, { readonly type: "durable" }> & {
        readonly entry: Extract<MissionChatEntry, { readonly kind: "user" }>;
      } => item.entry.kind === "user" && item.entry.delivery?.activatedAt !== undefined,
    )
    .toSorted((left, right) =>
      left.entry.delivery!.activatedAt!.localeCompare(right.entry.delivery!.activatedAt!),
    );
  const activatedIds = new Set(activated.map((item) => item.entry.id));
  const ordered: MissionConversationEntry[] = durable.filter(
    (item) => !activatedIds.has(item.entry.id),
  );
  for (const item of activated) {
    const activatedAt = item.entry.delivery!.activatedAt!;
    const index = ordered.findIndex(
      (candidate) => missionConversationEntryDisplayTime(candidate) > activatedAt,
    );
    ordered.splice(index < 0 ? ordered.length : index, 0, item);
  }
  const local = entries
    .filter((entry) => entry.type !== "durable")
    .toSorted((left, right) => left.entry.createdAt.localeCompare(right.entry.createdAt));
  for (const entry of local) {
    const index = ordered.findIndex(
      (candidate) => missionConversationEntryDisplayTime(candidate) > entry.entry.createdAt,
    );
    ordered.splice(index < 0 ? ordered.length : index, 0, entry);
  }
  return ordered;
}

function missionConversationEntryDisplayTime(entry: MissionConversationEntry): string {
  return entry.type === "durable" && entry.entry.kind === "user"
    ? (entry.entry.delivery?.activatedAt ?? entry.entry.createdAt)
    : entry.entry.createdAt;
}

export function applyMissionChatPatches(
  snapshot: MissionConversationSnapshot,
  patches: readonly MissionChatPatch[],
  revision: number,
): MissionConversationSnapshot | null {
  return applyMissionChatPatchesWithChanges(snapshot, patches, revision)?.snapshot ?? null;
}

interface MissionChatPatchApplyResult {
  readonly snapshot: MissionConversationSnapshot;
  readonly changedEntries: ReadonlyMap<string, MissionChatEntry>;
}

export interface MissionChatUpdateBatchOptions {
  /**
   * Reads the latest live value for an entry without scanning the ordered snapshot.
   * The ordered snapshot remains the authority for membership and order.
   */
  readonly readEntry?: ((entryId: string) => MissionChatEntry | undefined) | undefined;
  /**
   * Keeps pure content appends out of the ordered snapshot until the next structural boundary.
   * The caller must publish changedEntries through the same live entry store used by readEntry.
   */
  readonly deferContentEntries?: boolean | undefined;
}

function applyMissionChatPatchesWithChanges(
  snapshot: MissionConversationSnapshot,
  patches: readonly MissionChatPatch[],
  revision: number,
  options: MissionChatUpdateBatchOptions = {},
): MissionChatPatchApplyResult | null {
  if (patches.length === 0) {
    return {
      snapshot: revision === snapshot.revision ? snapshot : { ...snapshot, revision },
      changedEntries: new Map(),
    };
  }
  if (options.deferContentEntries && patches.every(isMissionContentAppendPatch)) {
    const changedEntries = new Map<string, MissionChatEntry>();
    for (const patch of patches) {
      const entry =
        changedEntries.get(patch.entryId) ??
        (options.readEntry === undefined
          ? snapshot.entries.find((candidate) => candidate.id === patch.entryId)
          : options.readEntry(patch.entryId));
      if (entry?.kind !== "assistant" && entry?.kind !== "thinking") return null;
      changedEntries.set(patch.entryId, {
        ...entry,
        content: truncateChatStream(`${entry.content}${patch.delta}`, 200_000),
      });
    }
    return {
      snapshot: { ...snapshot, revision },
      changedEntries,
    };
  }

  snapshot = materializeMissionChatSnapshot(snapshot, options.readEntry);
  const entries = [...snapshot.entries];
  const entryIndexById = new Map(entries.map((entry, index) => [entry.id, index] as const));
  const changedEntries = new Map<string, MissionChatEntry>();
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
        const beforeIndex =
          patch.beforeEntryId === undefined
            ? entries.length
            : entryIndexById.get(patch.beforeEntryId);
        if (beforeIndex === undefined) return null;
        entries.splice(beforeIndex, 0, { ...patch.entry });
        refreshMissionChatEntryIndexes(entryIndexById, entries, beforeIndex);
      } else {
        const existing = entries[existingIndex]!;
        const incoming = {
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
        // Patch revisions are the ordering authority. Content length and prefix
        // are not versions: a valid rewrite may be shorter or replace a prefix.
        entries[existingIndex] = incoming;
        if (patch.beforeEntryId !== undefined) {
          const beforeIndex = entryIndexById.get(patch.beforeEntryId);
          if (beforeIndex === undefined) return null;
          if (existingIndex > beforeIndex) {
            const [moved] = entries.splice(existingIndex, 1);
            if (moved === undefined) return null;
            const nextBeforeIndex = entries.findIndex((entry) => entry.id === patch.beforeEntryId);
            if (nextBeforeIndex < 0) return null;
            entries.splice(nextBeforeIndex, 0, moved);
            refreshMissionChatEntryIndexes(entryIndexById, entries, nextBeforeIndex);
          }
        }
      }
      const changedIndex = entryIndexById.get(patch.entry.id);
      if (changedIndex === undefined) return null;
      changedEntries.set(patch.entry.id, entries[changedIndex]!);
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
      changedEntries.set(patch.entryId, entries[index]!);
      continue;
    }
    if (entry.kind !== "tool") return null;
    entries[index] = {
      ...entry,
      outputPreview: truncateChatStream(`${entry.outputPreview ?? ""}${patch.delta}`, 801),
    };
    changedEntries.set(patch.entryId, entries[index]!);
  }
  return { snapshot: { ...snapshot, revision, entries }, changedEntries };
}

function isMissionContentAppendPatch(patch: MissionChatPatch): patch is Extract<
  MissionChatPatch,
  { readonly type: "entry.append" }
> & {
  readonly field: "content";
} {
  return patch.type === "entry.append" && patch.field === "content";
}

export function materializeMissionChatSnapshot(
  snapshot: MissionConversationSnapshot,
  readEntry: ((entryId: string) => MissionChatEntry | undefined) | undefined,
): MissionConversationSnapshot {
  if (readEntry === undefined) return snapshot;
  let changed = false;
  const entries = snapshot.entries.map((entry) => {
    const liveEntry = readEntry(entry.id) ?? entry;
    if (liveEntry !== entry) changed = true;
    return liveEntry;
  });
  return changed ? { ...snapshot, entries } : snapshot;
}

function refreshMissionChatEntryIndexes(
  indexes: Map<string, number>,
  entries: readonly MissionChatEntry[],
  fromIndex: number,
): void {
  for (let index = fromIndex; index < entries.length; index += 1) {
    indexes.set(entries[index]!.id, index);
  }
}

export interface MissionChatUpdateBatchResult {
  readonly snapshot: MissionConversationSnapshot;
  readonly remaining: readonly MissionChatUpdate[];
  readonly needsRefresh: boolean;
  readonly requiresRender: boolean;
  readonly changedEntryIds: ReadonlySet<string>;
  readonly changedEntries: ReadonlyMap<string, MissionChatEntry>;
  readonly requiredRefreshRevision?: number | undefined;
}

/**
 * Applies every contiguous update in one batch. IPC updates remain revisioned, while
 * high-frequency content appends can stay in the indexed live store until a structural boundary.
 */
export function applyMissionChatUpdateBatch(
  base: MissionConversationSnapshot,
  pending: readonly MissionChatUpdate[],
  options: MissionChatUpdateBatchOptions = {},
): MissionChatUpdateBatchResult {
  const updates = pending.toSorted((left, right) => left.revision - right.revision);
  const contiguous: Extract<MissionChatUpdate, { readonly kind: "patch" }>[] = [];
  let remaining: MissionChatUpdate[] = [];
  let expectedRevision = base.revision + 1;
  let consumedRevision = base.revision;
  let requiredRefreshRevision: number | undefined;

  for (let index = 0; index < updates.length; index += 1) {
    const candidate = updates[index]!;
    if (candidate.revision <= base.revision) continue;
    if (candidate.revision !== expectedRevision) {
      remaining = updates.slice(index);
      break;
    }
    consumedRevision = candidate.revision;
    expectedRevision += 1;
    if (candidate.kind === "invalidate") {
      requiredRefreshRevision = candidate.revision;
      continue;
    }
    contiguous.push(candidate);
  }

  if (contiguous.length === 0) {
    return {
      snapshot: consumedRevision === base.revision ? base : { ...base, revision: consumedRevision },
      remaining,
      needsRefresh: requiredRefreshRevision !== undefined || remaining.length > 0,
      requiresRender: false,
      changedEntryIds: new Set(),
      changedEntries: new Map(),
      ...(requiredRefreshRevision === undefined ? {} : { requiredRefreshRevision }),
    };
  }

  const patches = compactMissionChatPatches(contiguous.flatMap((update) => update.patches));
  const applied = applyMissionChatPatchesWithChanges(base, patches, consumedRevision, options);
  if (applied === null) {
    return {
      snapshot: base,
      remaining: updates.filter((update) => update.revision > base.revision),
      needsRefresh: true,
      requiresRender: false,
      changedEntryIds: new Set(),
      changedEntries: new Map(),
      ...(requiredRefreshRevision === undefined ? {} : { requiredRefreshRevision }),
    };
  }
  const changedEntryIds = new Set(applied.changedEntries.keys());
  return {
    snapshot: applied.snapshot,
    remaining,
    needsRefresh: requiredRefreshRevision !== undefined || remaining.length > 0,
    requiresRender: missionChatPatchesRequireRender(patches),
    changedEntryIds,
    changedEntries: applied.changedEntries,
    ...(requiredRefreshRevision === undefined ? {} : { requiredRefreshRevision }),
  };
}

function compactMissionChatPatches(patches: readonly MissionChatPatch[]): MissionChatPatch[] {
  const compacted: MissionChatPatch[] = [];
  for (const patch of patches) {
    const previous = compacted.at(-1);
    if (
      patch.type === "entry.append" &&
      previous?.type === "entry.append" &&
      previous.entryId === patch.entryId &&
      previous.field === patch.field
    ) {
      compacted[compacted.length - 1] = { ...previous, delta: previous.delta + patch.delta };
    } else {
      compacted.push(patch);
    }
  }
  return compacted;
}

export function missionChatPatchesRequireRender(patches: readonly MissionChatPatch[]): boolean {
  return patches.some((patch) => patch.type !== "entry.append" || patch.field !== "content");
}

export function visiblePatchExecutionIds(
  update: MissionChatUpdate,
  snapshot: MissionConversationSnapshot | null,
  readEntryExecutionId?: ((entryId: string) => string | undefined) | undefined,
  activeExecutionId: string | undefined = snapshot?.execution?.id,
): ReadonlySet<string> {
  const executionIds = new Set<string>();
  const updateEntryExecutionIds = new Map<string, string | undefined>();
  if (update.kind !== "patch") return executionIds;
  for (const patch of update.patches) {
    if (patch.type === "context-window.update") continue;
    if (patch.type === "entry.upsert") {
      updateEntryExecutionIds.set(patch.entry.id, patch.entry.executionId);
      if (
        (patch.entry.kind === "assistant" || patch.entry.kind === "thinking") &&
        patch.entry.content.length > 0
      ) {
        const executionId = patch.entry.executionId ?? activeExecutionId;
        if (executionId !== undefined) executionIds.add(executionId);
      }
      continue;
    }
    if (patch.type !== "entry.append" || patch.field !== "content" || patch.delta.length === 0) {
      continue;
    }
    const executionId = updateEntryExecutionIds.has(patch.entryId)
      ? updateEntryExecutionIds.get(patch.entryId)
      : readEntryExecutionId === undefined
        ? snapshot?.entries.find((entry) => entry.id === patch.entryId)?.executionId
        : readEntryExecutionId(patch.entryId);
    if (executionId !== undefined) executionIds.add(executionId);
    else if (activeExecutionId !== undefined) executionIds.add(activeExecutionId);
  }
  return executionIds;
}

export function includedPendingFirstTokenExecutionIds(
  snapshot: MissionConversationSnapshot,
  updates: readonly MissionChatUpdate[],
): ReadonlySet<string> {
  const executionIds = new Set<string>();
  const snapshotEntryExecutions = new Map(
    snapshot.entries.map((entry) => [entry.id, entry.executionId] as const),
  );
  const pendingEntryExecutions = new Map<string, string | undefined>();
  const processedRevisions = new Set<number>();
  for (const update of updates.toSorted((left, right) => left.revision - right.revision)) {
    if (update.revision > snapshot.revision || processedRevisions.has(update.revision)) continue;
    processedRevisions.add(update.revision);
    const upsertedEntryIds = new Set(
      update.kind === "patch"
        ? update.patches.flatMap((patch) => (patch.type === "entry.upsert" ? [patch.entry.id] : []))
        : [],
    );
    // The snapshot proves ownership only at its own revision. Older content is recorded only
    // when its update carries an execution-bearing upsert, never from future snapshot metadata.
    const readEntryExecutionId =
      update.revision === snapshot.revision
        ? (entryId: string) => {
            if (pendingEntryExecutions.has(entryId)) {
              return pendingEntryExecutions.get(entryId);
            }
            return upsertedEntryIds.has(entryId) ? undefined : snapshotEntryExecutions.get(entryId);
          }
        : (entryId: string) =>
            pendingEntryExecutions.has(entryId) ? pendingEntryExecutions.get(entryId) : undefined;
    for (const executionId of visiblePatchExecutionIds(
      update,
      null,
      readEntryExecutionId,
      update.revision === snapshot.revision ? snapshot.execution?.id : undefined,
    )) {
      executionIds.add(executionId);
    }
    if (update.kind === "patch") {
      for (const patch of update.patches) {
        if (patch.type === "entry.upsert") {
          pendingEntryExecutions.set(patch.entry.id, patch.entry.executionId);
        }
      }
    }
  }
  return executionIds;
}

export class MissionFirstTokenUpdateBuffer {
  readonly #pending = new Map<
    number,
    { readonly update: MissionChatUpdate; readonly activeExecutionId: string | undefined }
  >();
  readonly #entryExecutionIds = new Map<string, string | undefined>();
  #revision: number;

  constructor(revision: number) {
    this.#revision = revision;
  }

  reset(revision: number): void {
    this.#revision = revision;
    this.#pending.clear();
    this.#entryExecutionIds.clear();
  }

  push(
    update: MissionChatUpdate,
    readEntryExecutionId: (entryId: string) => string | undefined,
    activeExecutionId?: string | undefined,
  ): ReadonlySet<string> {
    if (update.revision <= this.#revision || this.#pending.has(update.revision)) return new Set();
    this.#pending.set(update.revision, { update, activeExecutionId });
    const executionIds = new Set<string>();
    for (;;) {
      const nextRevision = this.#revision + 1;
      const next = this.#pending.get(nextRevision);
      if (next === undefined) break;
      this.#pending.delete(nextRevision);
      for (const executionId of visiblePatchExecutionIds(
        next.update,
        null,
        (entryId) =>
          this.#entryExecutionIds.has(entryId)
            ? this.#entryExecutionIds.get(entryId)
            : readEntryExecutionId(entryId),
        next.activeExecutionId,
      )) {
        executionIds.add(executionId);
      }
      if (next.update.kind === "patch") {
        for (const patch of next.update.patches) {
          if (patch.type === "entry.upsert") {
            this.#entryExecutionIds.set(patch.entry.id, patch.entry.executionId);
          }
        }
      }
      this.#revision = nextRevision;
    }
    return executionIds;
  }
}

export function shouldClearMissionThinkingPlaceholder(
  chat: MissionConversationSnapshot,
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
  chat: MissionConversationSnapshot | null,
  requestId: string | null,
): boolean {
  return (
    requestId !== null && (chat === null || !shouldClearMissionThinkingPlaceholder(chat, requestId))
  );
}

export function mergeLatestChatPage(
  current: MissionConversationSnapshot | null,
  latest: MissionConversationSnapshot,
): MissionConversationSnapshot {
  if (current === null || current.missionId !== latest.missionId) return latest;
  // A refresh can finish after newer IPC patches were already painted. Never let that older
  // request move the renderer revision or its append-only entries backwards.
  if (latest.revision < current.revision) return current;
  const unavailableSections = new Set(latest.syncIssues?.map((issue) => issue.section) ?? []);
  const preserveCurrentHistory = unavailableSections.has("history");
  const latestOldest = latest.page.oldestSequence;
  const latestEntryIds = new Set(latest.entries.map((entry) => entry.id));
  const currentEntriesById = new Map(current.entries.map((entry) => [entry.id, entry] as const));
  const latestEntries = latest.entries;
  const retainedOlder =
    latestOldest === undefined
      ? []
      : current.entries.filter(
          (entry) =>
            entry.timelineSequence !== undefined &&
            (entry.timelineSequence < latestOldest ||
              (entry.timelineSequence === latestOldest && !latestEntryIds.has(entry.id))),
        );
  const retainedUnavailableHistory = preserveCurrentHistory ? current.entries : [];
  const availableLatestEntries = preserveCurrentHistory
    ? latestEntries.filter((entry) => !currentEntriesById.has(entry.id))
    : latestEntries;
  const latestPageWithoutCursor = { ...latest.page };
  delete latestPageWithoutCursor.nextBeforeCursor;
  return {
    ...latest,
    entries: uniqueChatEntries([
      ...retainedOlder,
      ...retainedUnavailableHistory,
      ...availableLatestEntries,
    ]),
    page: preserveCurrentHistory
      ? {
          ...latestPageWithoutCursor,
          ...(current.page.nextBeforeCursor === undefined
            ? {}
            : { nextBeforeCursor: current.page.nextBeforeCursor }),
        }
      : retainedOlder.length === 0
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

export function touchMissionConversationCache(
  cache: Map<string, MissionConversationSnapshot>,
  missionId: string,
): void {
  const conversation = cache.get(missionId);
  if (conversation === undefined) return;
  // Loaded entries and nextBeforeCursor describe one pagination state. Trimming only the entries
  // makes an exhausted cursor look complete after A -> B -> A navigation, hiding older messages.
  cache.delete(missionId);
  cache.set(missionId, conversation);
}

/**
 * Materializes already-received deltas before accepting an asynchronous refresh. A snapshot may
 * advertise their revision while still carrying an older projection, so filtering the queue first
 * would permanently discard visible text.
 */
export function reconcileMissionChatRefresh(
  current: MissionConversationSnapshot | null,
  latest: MissionConversationSnapshot,
  pending: readonly MissionChatUpdate[],
): MissionChatUpdateBatchResult {
  let base = current;
  let remaining = [...pending];
  let requiredRefreshRevision: number | undefined;
  if (base !== null && base.missionId === latest.missionId) {
    const live = applyMissionChatUpdateBatch(base, remaining);
    base = live.snapshot;
    remaining = [...live.remaining];
    requiredRefreshRevision = live.requiredRefreshRevision;
  }
  const merged =
    base !== null && latest.revision <= base.revision
      ? mergeStaleRefreshMetadata(base, latest)
      : mergeLatestChatPage(base, latest);
  remaining = remaining.filter((candidate) => candidate.revision > merged.revision);
  const applied = applyMissionChatUpdateBatch(merged, remaining);
  const refreshStillRequired =
    requiredRefreshRevision !== undefined && latest.revision < requiredRefreshRevision;
  return {
    ...applied,
    needsRefresh: applied.needsRefresh || refreshStillRequired,
    ...(refreshStillRequired ? { requiredRefreshRevision } : {}),
  };
}

function mergeStaleRefreshMetadata(
  current: MissionConversationSnapshot,
  latest: MissionConversationSnapshot,
): MissionConversationSnapshot {
  const latestEntriesById = new Map(latest.entries.map((entry) => [entry.id, entry] as const));
  const currentEntryIds = new Set(current.entries.map((entry) => entry.id));
  const entries = current.entries.map((entry) => {
    const incoming = latestEntriesById.get(entry.id);
    return incoming === undefined ? entry : mergeStaleEntryMetadata(entry, incoming);
  });
  // Keep the painted order, but recover missing history beside the shared entries in
  // the older snapshot. Appending it would put earlier expert thinking after a live
  // final answer. A stale suffix belongs before the newer live tail. Without a
  // shared anchor, the turn sequence still keeps already-loaded older turns first.
  const lastShared = latest.entries.findLast((entry) => currentEntryIds.has(entry.id));
  let insertionIndex =
    lastShared === undefined ? 0 : entries.findIndex((entry) => entry.id === lastShared.id) + 1;
  for (let index = latest.entries.length - 1; index >= 0; index -= 1) {
    const entry = latest.entries[index]!;
    if (currentEntryIds.has(entry.id)) {
      insertionIndex = entries.findIndex((candidate) => candidate.id === entry.id);
    } else {
      if (lastShared === undefined && entry.timelineSequence !== undefined) {
        const sequence = entry.timelineSequence;
        insertionIndex =
          entries.findLastIndex(
            (candidate) =>
              candidate.timelineSequence !== undefined && candidate.timelineSequence < sequence,
          ) + 1;
      }
      entries.splice(insertionIndex, 0, entry);
    }
  }
  const merged = mergeLatestChatPage(current, {
    ...latest,
    revision: current.revision,
    entries,
  });
  return {
    ...merged,
    // This list already retains all current entries. The degraded-history fallback
    // must not prepend the old list again and undo the recovered ordering.
    entries,
    // A stale latest-page response cannot replace the cursor for history that the
    // user has already loaded. Use its page only when it actually extends the front.
    page: entries[0]?.id === current.entries[0]?.id ? current.page : merged.page,
  };
}

function mergeStaleEntryMetadata(
  existing: MissionChatEntry,
  incoming: MissionChatEntry,
): MissionChatEntry {
  if (
    (incoming.kind !== "assistant" && incoming.kind !== "thinking") ||
    existing.kind !== incoming.kind
  ) {
    return incoming;
  }
  // The caller has already established that this is stale metadata. Preserve
  // the content from the newer revision unconditionally; do not infer recency
  // from string length or prefix shape.
  return { ...incoming, content: existing.content };
}

export function prependChatPage(
  current: MissionConversationSnapshot,
  earlier: MissionConversationSnapshot,
): MissionConversationSnapshot {
  return {
    ...current,
    // A history page reports the backend snapshot observed while it was read;
    // it does not prove that this renderer consumed live changes up to that
    // revision. Preserve the contiguous live watermark.
    revision: current.revision,
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
      ...(current.page.truncation === undefined && earlier.page.truncation === undefined
        ? {}
        : {
            // Both pages may report the same bounded terminal projection. Use
            // monotonic totals so pagination cannot erase the warning or count
            // the same projection twice.
            truncation: {
              omittedEntries: Math.max(
                current.page.truncation?.omittedEntries ?? 0,
                earlier.page.truncation?.omittedEntries ?? 0,
              ),
              truncatedFields: Math.max(
                current.page.truncation?.truncatedFields ?? 0,
                earlier.page.truncation?.truncatedFields ?? 0,
              ),
            },
          }),
    },
  };
}

export function uniqueChatEntries(entries: readonly MissionChatEntry[]): MissionChatEntry[] {
  const byId = new Map<string, MissionChatEntry>();
  for (const entry of entries) {
    // The last source is authoritative for both value and order. Updating an
    // existing Map value keeps its first insertion position and can place a
    // recovered process entry after the final answer.
    byId.delete(entry.id);
    byId.set(entry.id, entry);
  }
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
