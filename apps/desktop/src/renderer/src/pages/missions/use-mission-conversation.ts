import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";

import type {
  MissionChatEntry,
  MissionChatPage,
  MissionChatUpdate,
  MissionContextWindowSnapshot,
  MissionConversationSnapshot,
  MissionConversationState,
  PragmaDesktopAPI,
} from "../../../../shared/contracts/index.ts";
import {
  applyMissionChatUpdateBatch,
  createMissionConversationBase,
  includedPendingFirstTokenExecutionIds,
  materializeMissionChatSnapshot,
  MissionFirstTokenUpdateBuffer,
  prependChatPage,
  reconcileMissionChatRefresh,
} from "./mission-conversation-model.ts";
import {
  MissionStreamIdleStore,
  missionEntryOutputChanged,
  missionRefreshOutputCandidates,
} from "./mission-stream-idle-store.ts";
import { createMissionBackgroundReads, createMissionRefresh } from "./mission-background-reads.ts";
import { MissionLiveEntryStore } from "./mission-live-entry-store.ts";
import {
  enqueueMissionChatUpdate,
  estimateMissionChatUpdatesBytes,
} from "./mission-update-backlog.ts";
import { MISSION_CHAT_PAGE_SIZE } from "./mission-view-constants.ts";

export function useMissionConversation(input: {
  readonly missionId: string;
  readonly navigationId?: string | undefined;
  readonly api: PragmaDesktopAPI | undefined;
  readonly cache?: Map<string, MissionConversationSnapshot> | undefined;
  readonly prefetchedConversation?: Promise<MissionConversationPrefetch | undefined> | undefined;
  readonly isOutputVisible?: ((entry: MissionChatEntry) => boolean) | undefined;
  readonly refreshRevision: number;
  readonly syncUnavailableMessage: string;
  readonly formatError: (error: unknown) => string;
}) {
  const [chat, setChat] = useState<MissionConversationSnapshot | null>(() =>
    readyCachedConversation(input.cache, input.missionId, input.api === undefined),
  );
  const [initialLoading, setInitialLoading] = useState(
    () => readyCachedConversation(input.cache, input.missionId, input.api === undefined) === null,
  );
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const liveEntryStore = useMemo(() => new MissionLiveEntryStore(), [input.missionId]);
  const streamIdleStore = useMemo(() => new MissionStreamIdleStore(), [input.missionId]);
  useEffect(() => () => streamIdleStore.stop(), [streamIdleStore]);
  // Team identity can resolve after subscription setup; do not reopen the stream for it.
  const outputVisibleRef = useRef(input.isOutputVisible);
  outputVisibleRef.current = input.isOutputVisible;
  const chatRef = useRef<MissionConversationSnapshot | null>(null);
  const backgroundReadsRef = useRef<ReturnType<typeof createMissionBackgroundReads> | null>(null);
  const historyRefreshRef = useRef<(() => Promise<MissionConversationSnapshot | undefined>) | null>(
    null,
  );
  const receivedFirstTokensRef = useRef(new Set<string>());
  const paintedFirstTokensRef = useRef(new Set<string>());
  const pendingFirstTokenPaintsRef = useRef(new Map<string, { readonly receivedAt: number }>());
  const firstTokenPaintFramesRef = useRef(new Map<string, number[]>());
  const navigationIdRef = useRef(input.navigationId ?? crypto.randomUUID());

  const update = useCallback(
    (value: SetStateAction<MissionConversationSnapshot | null>, observeOutput = false) => {
      const current =
        chatRef.current === null
          ? null
          : materializeMissionChatSnapshot(chatRef.current, (entryId) =>
              liveEntryStore.get(entryId),
            );
      const next = typeof value === "function" ? value(current) : value;
      const outputEntries =
        observeOutput && next !== null
          ? missionRefreshOutputCandidates(current, next).filter(
              (entry) =>
                (outputVisibleRef.current?.(entry) ?? true) &&
                missionEntryOutputChanged(liveEntryStore.get(entry.id), entry),
            )
          : [];
      chatRef.current = next;
      if (next === null) liveEntryStore.clear();
      else liveEntryStore.reset(next.entries);
      if (next !== null && next.missionId === input.missionId) {
        cacheMissionConversationSnapshot(input.cache, input.missionId, next);
      }
      setChat(next);
      for (const entry of outputEntries)
        streamIdleStore.output(entry.executionId, next?.execution?.id);
    },
    [input.cache, input.missionId, liveEntryStore, streamIdleStore],
  );

  // Host operation refreshes can paint output before the corresponding IPC patch arrives.
  // Internal initialization and historical paging use update() without observing output.
  const updateLatest = useCallback(
    (value: SetStateAction<MissionConversationSnapshot | null>) => update(value, true),
    [update],
  );

  const advanceLive = useCallback(
    (
      next: MissionConversationSnapshot,
      changedEntries: ReadonlyMap<string, MissionConversationSnapshot["entries"][number]>,
    ) => {
      chatRef.current = next;
      for (const entry of changedEntries.values()) liveEntryStore.publish(entry);
      // The ordered snapshot intentionally defers these entry bodies. Keep that partial
      // representation hook-private; shared cache writes always materialize from the live store.
    },
    [liveEntryStore],
  );

  const commitStream = useCallback(
    (
      next: MissionConversationSnapshot,
      changedEntries: ReadonlyMap<string, MissionConversationSnapshot["entries"][number]>,
      requiresRender: boolean,
    ) => {
      const outputEntries = [...changedEntries.values()].filter(
        (entry) =>
          (outputVisibleRef.current?.(entry) ?? true) &&
          missionEntryOutputChanged(liveEntryStore.get(entry.id), entry),
      );
      if (requiresRender) update(next);
      else advanceLive(next, changedEntries);
      for (const entry of outputEntries)
        streamIdleStore.output(entry.executionId ?? next.execution?.id, next.execution?.id);
    },
    [advanceLive, liveEntryStore, streamIdleStore, update],
  );

  useEffect(() => {
    const cached = readyCachedConversation(input.cache, input.missionId, input.api === undefined);
    const cacheHit = cached !== null;
    const navigationStartedAt = performance.now();
    const navigationId = input.navigationId ?? navigationIdRef.current;
    let longTaskMs = 0;
    const longTaskObserver =
      typeof PerformanceObserver === "undefined" ||
      !PerformanceObserver.supportedEntryTypes.includes("longtask")
        ? undefined
        : new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) longTaskMs += entry.duration;
          });
    longTaskObserver?.observe({ type: "longtask", buffered: true });
    update(
      cached ?? (input.api === undefined ? null : createMissionConversationBase(input.missionId)),
    );
    setInitialLoading(cached === null);
    setHistoryError(null);
    setSyncError(null);
    const api = input.api;
    if (api === undefined) {
      setInitialLoading(false);
      longTaskObserver?.disconnect();
      return;
    }
    let cancelled = false;
    let prefetchedConversation = input.prefetchedConversation;
    let latestControl: MissionConversationState | undefined;
    let controlUnavailable = false;
    let latestContext: MissionContextWindowSnapshot | undefined;
    let frame: number | undefined;
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    let lastPerformanceLogAt = 0;
    let pending: MissionChatUpdate[] = [];
    let pendingBytes = 0;
    let pendingHighWater = 0;
    let overflowCount = 0;
    let rawUpdateCount = 0;
    let flushCount = 0;
    const firstTokenUpdates = new MissionFirstTokenUpdateBuffer(chatRef.current?.revision ?? 0);
    receivedFirstTokensRef.current.clear();
    paintedFirstTokensRef.current.clear();
    pendingFirstTokenPaintsRef.current.clear();
    for (const frames of firstTokenPaintFramesRef.current.values()) {
      for (const paintFrame of frames) cancelAnimationFrame(paintFrame);
    }
    firstTokenPaintFramesRef.current.clear();

    const recordFirstTokens = (executionIds: ReadonlySet<string>): void => {
      for (const executionId of executionIds) {
        if (receivedFirstTokensRef.current.has(executionId)) continue;
        receivedFirstTokensRef.current.add(executionId);
        pendingFirstTokenPaintsRef.current.set(executionId, { receivedAt: performance.now() });
        api.reportRendererLog({
          level: "info",
          event: "mission.first_ui_token_received",
          monotonicAtMs: performance.now(),
          timeOriginMs: performance.timeOrigin,
          message: "Renderer received the first UI-visible Mission token",
          missionId: input.missionId,
          executionId,
          navigationId,
        });
      }
    };

    const resetFirstTokenUpdates = (
      base: MissionConversationSnapshot,
      updates: readonly MissionChatUpdate[],
    ): void => {
      const baseEntryExecutions = new Map(
        base.entries.map((entry) => [entry.id, entry.executionId] as const),
      );
      firstTokenUpdates.reset(base.revision);
      for (const updateValue of updates.toSorted((left, right) => left.revision - right.revision)) {
        recordFirstTokens(
          firstTokenUpdates.push(
            updateValue,
            (entryId) =>
              baseEntryExecutions.has(entryId)
                ? baseEntryExecutions.get(entryId)
                : liveEntryStore.get(entryId)?.executionId,
            base.execution?.id,
          ),
        );
      }
    };

    const drainPending = (base: MissionConversationSnapshot) => {
      const drained = applyMissionChatUpdateBatch(base, pending, {
        deferContentEntries: true,
        readEntry: (entryId) => liveEntryStore.get(entryId),
      });
      pending = [...drained.remaining];
      pendingBytes = estimateMissionChatUpdatesBytes(pending);
      return drained;
    };

    const refreshOnce = async (): Promise<void> => {
      try {
        const prefetched = await prefetchedConversation;
        const { page, state, stateUnavailable } =
          prefetched ?? (await loadMissionConversationProjection(api, input.missionId));
        prefetchedConversation = undefined;
        if (!cancelled) {
          const current =
            chatRef.current === null
              ? null
              : materializeMissionChatSnapshot(chatRef.current, (entryId) =>
                  liveEntryStore.get(entryId),
                );
          const pageSnapshot = stateUnavailable
            ? markConversationStateUnavailable(conversationFromPage(page, current))
            : conversationFromPage(page, current);
          const snapshot =
            state === undefined
              ? pageSnapshot
              : (mergeConversationState(pageSnapshot, state) ?? pageSnapshot);
          // Subscription starts before the page read. Establish the fetched revision as the
          // watermark and attribute any contiguous updates before reconciliation consumes them.
          const firstPendingRevision = pending.reduce(
            (minimum, updateValue) => Math.min(minimum, updateValue.revision),
            Number.POSITIVE_INFINITY,
          );
          const firstTokenBase = [current, snapshot]
            .filter(
              (candidate): candidate is MissionConversationSnapshot =>
                candidate !== null &&
                candidate.missionId === snapshot.missionId &&
                candidate.revision < firstPendingRevision,
            )
            .toSorted((left, right) => right.revision - left.revision)[0];
          // The fetched page may already include some pending updates even when a cached base
          // exists but has a revision gap. Recover every safely attributable included token;
          // recordFirstTokens de-duplicates executions also found by the contiguous replay.
          recordFirstTokens(includedPendingFirstTokenExecutionIds(snapshot, pending));
          resetFirstTokenUpdates(firstTokenBase ?? snapshot, pending);
          // Retain pending entry updates, including those covered by the fetched revision.
          const pendingEntryIds = new Set(
            pending.flatMap((value) =>
              value.kind === "patch"
                ? value.patches.flatMap((patch) =>
                    patch.type === "entry.upsert"
                      ? [patch.entry.id]
                      : patch.type === "entry.append"
                        ? [patch.entryId]
                        : [],
                  )
                : [],
            ),
          );
          const drained = reconcileMissionChatRefresh(current, snapshot, pending);
          pending = [...drained.remaining];
          pendingBytes = estimateMissionChatUpdatesBytes(pending);
          const committedEntries = new Map(
            [
              ...missionRefreshOutputCandidates(current, drained.snapshot),
              ...drained.snapshot.entries.filter((entry) => pendingEntryIds.has(entry.id)),
            ].map((entry) => [entry.id, entry]),
          );
          const withControl =
            latestControl === undefined
              ? drained.snapshot
              : (mergeConversationState(drained.snapshot, latestControl) ?? drained.snapshot);
          const withContext =
            latestContext === undefined
              ? withControl
              : (mergeContextWindow(withControl, latestContext) ?? withControl);
          commitStream(
            controlUnavailable ? markConversationStateUnavailable(withContext) : withContext,
            committedEntries,
            true,
          );
          resetFirstTokenUpdates(drained.snapshot, pending);
          setSyncError(
            controlUnavailable || withContext.syncIssues !== undefined
              ? input.syncUnavailableMessage
              : null,
          );
          if (drained.needsRefresh) void refresh();
          if (stateUnavailable) {
            // The page is useful on its own, but pending questions and controls
            // are safety-relevant. Retry that independent read without throwing
            // away or re-fetching the message history.
            setTimeout(() => {
              if (!cancelled) void refreshControl();
            }, 500);
          }
          const pageReceivedAt = performance.now();
          const characterCount = page.entries.reduce(
            (total, entry) =>
              total +
              ("content" in entry ? entry.content.length : 0) +
              (entry.kind === "tool" ? (entry.outputPreview?.length ?? 0) : 0),
            0,
          );
          api.reportRendererLog({
            level: "info",
            event: "mission.chat_page_received",
            message: `Mission chat page received (${page.entries.length} entries)`,
            missionId: input.missionId,
            navigationId,
            elapsedMs: Math.round((pageReceivedAt - navigationStartedAt) * 100) / 100,
            entryCount: page.entries.length,
            characterCount,
            cacheHit,
          });
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (cancelled) return;
              api.reportRendererLog({
                level: "info",
                event: "mission.chat_page_painted",
                message: `Mission chat page painted (${page.entries.length} entries)`,
                missionId: input.missionId,
                navigationId,
                elapsedMs: Math.round((performance.now() - pageReceivedAt) * 100) / 100,
                entryCount: page.entries.length,
                characterCount,
                cacheHit,
                longTaskMs: Math.round(longTaskMs * 100) / 100,
              });
            });
          });
        }
      } catch (error) {
        if (!cancelled) setSyncError(input.formatError(error));
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    };

    const refresh = createMissionRefresh(refreshOnce, () => cancelled);
    const refreshLatestHistory = async (): Promise<MissionConversationSnapshot | undefined> => {
      await refresh();
      return cancelled || chatRef.current === null
        ? undefined
        : materializeMissionChatSnapshot(chatRef.current, (entryId) => liveEntryStore.get(entryId));
    };
    historyRefreshRef.current = refreshLatestHistory;

    const backgroundReads = createMissionBackgroundReads({
      api,
      missionId: input.missionId,
      onControl: (value) => {
        controlUnavailable = false;
        latestControl = value;
        update((current) => {
          const next = mergeConversationState(current, value);
          setSyncError(next?.syncIssues === undefined ? null : input.syncUnavailableMessage);
          return next;
        });
      },
      onContext: (value) => {
        latestContext = value;
        update((current) => {
          const next = mergeContextWindow(current, value);
          setSyncError(
            controlUnavailable || next?.syncIssues !== undefined
              ? input.syncUnavailableMessage
              : null,
          );
          return next;
        });
      },
      onControlError: (error) => {
        controlUnavailable = true;
        setSyncError(input.formatError(error));
        update((current) => (current === null ? null : markConversationStateUnavailable(current)));
      },
      onContextError: () => {
        setSyncError(input.syncUnavailableMessage);
        update((current) =>
          current === null
            ? null
            : {
                ...current,
                syncIssues: mergeSyncIssues(
                  current.syncIssues,
                  [
                    {
                      code: "execution_state_unavailable",
                      section: "context_window",
                      retryable: true,
                    },
                  ],
                  "context_window",
                ),
              },
        );
      },
    });
    backgroundReadsRef.current = backgroundReads;
    const { refreshControl, refreshContext } = backgroundReads;

    const flush = (): void => {
      frame = undefined;
      if (hiddenTimer !== undefined) clearTimeout(hiddenTimer);
      hiddenTimer = undefined;
      if (cancelled || chatRef.current === null || pending.length === 0) return;
      flushCount += 1;
      const startedAt = performance.now();
      const previousContextRevision = chatRef.current.contextRevision;
      const drained = drainPending(chatRef.current);
      commitStream(drained.snapshot, drained.changedEntries, drained.requiresRender);
      if (
        drained.snapshot.contextWindow === undefined &&
        drained.snapshot.contextRevision !== previousContextRevision
      )
        void refreshContext();
      if (drained.changedEntries.size > 0) setInitialLoading(false);
      const finishedAt = performance.now();
      if (finishedAt - lastPerformanceLogAt >= 5_000) {
        lastPerformanceLogAt = finishedAt;
        let activeContentLength = 0;
        for (const entry of drained.changedEntries.values()) {
          if (entry.kind === "assistant" || entry.kind === "thinking") {
            activeContentLength = Math.max(activeContentLength, entry.content.length);
          }
        }
        api.reportRendererLog({
          level: "info",
          event: "mission.stream_flush",
          message: `Mission stream flush ${flushCount} processed ${rawUpdateCount} IPC updates, updated ${drained.changedEntryIds.size} entries (${drained.snapshot.entries.length} loaded, ${activeContentLength} active characters, backlog high-water ${pendingHighWater}, resyncs ${overflowCount})`,
          missionId: input.missionId,
          executionId: drained.snapshot.execution?.id,
          elapsedMs: Math.round((finishedAt - startedAt) * 100) / 100,
        });
      }
      if (drained.needsRefresh) {
        void refresh();
        void refreshControl();
        void refreshContext();
      }
    };

    const scheduleFlush = (): void => {
      if (frame !== undefined || hiddenTimer !== undefined || cancelled) return;
      if (document.visibilityState === "hidden") {
        hiddenTimer = setTimeout(flush, 100);
        return;
      }
      frame = requestAnimationFrame(flush);
    };

    const unsubscribe = api.subscribeMissionChat(input.missionId, (updateValue) => {
      rawUpdateCount += 1;
      if (updateValue.kind === "invalidate") {
        void refreshControl();
        void refreshContext();
      }

      const enqueued = enqueueMissionChatUpdate(pending, pendingBytes, updateValue);
      if (enqueued.overflowed) {
        overflowCount += 1;
        pendingHighWater = Math.max(pendingHighWater, pending.length + 1);
        pending = [...enqueued.pending];
        pendingBytes = enqueued.pendingBytes;
        if (chatRef.current !== null) resetFirstTokenUpdates(chatRef.current, pending);
        api.reportRendererLog({
          level: "warn",
          event: "mission.stream_backpressure",
          message: `Mission stream backlog exceeded its bound ${overflowCount} time(s); reloading the authoritative snapshot`,
          missionId: input.missionId,
          entryCount: pendingHighWater,
        });
        void refresh();
      } else {
        pending = [...enqueued.pending];
        pendingBytes = enqueued.pendingBytes;
        pendingHighWater = Math.max(pendingHighWater, pending.length);
      }
      const executionIds = firstTokenUpdates.push(
        updateValue,
        (entryId) => liveEntryStore.get(entryId)?.executionId,
        chatRef.current?.execution?.id,
      );
      recordFirstTokens(executionIds);
      scheduleFlush();
    });
    const flushWhenVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      if (hiddenTimer !== undefined) clearTimeout(hiddenTimer);
      hiddenTimer = undefined;
      scheduleFlush();
    };
    document.addEventListener("visibilitychange", flushWhenVisible);
    void refresh();
    void refreshControl();
    void refreshContext();
    return () => {
      cancelled = true;
      if (historyRefreshRef.current === refreshLatestHistory) historyRefreshRef.current = null;
      backgroundReads.close();
      if (backgroundReadsRef.current === backgroundReads) backgroundReadsRef.current = null;
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (hiddenTimer !== undefined) clearTimeout(hiddenTimer);
      pendingFirstTokenPaintsRef.current.clear();
      for (const frames of firstTokenPaintFramesRef.current.values()) {
        for (const paintFrame of frames) cancelAnimationFrame(paintFrame);
      }
      firstTokenPaintFramesRef.current.clear();
      const latest =
        chatRef.current === null
          ? null
          : materializeMissionChatSnapshot(chatRef.current, (entryId) =>
              liveEntryStore.get(entryId),
            );
      if (latest !== null && latest.missionId === input.missionId) {
        cacheMissionConversationSnapshot(input.cache, input.missionId, latest);
      }
      unsubscribe();
      document.removeEventListener("visibilitychange", flushWhenVisible);
      longTaskObserver?.disconnect();
    };
  }, [
    commitStream,
    input.api,
    input.cache,
    input.formatError,
    input.missionId,
    input.navigationId,
    input.prefetchedConversation,
    input.refreshRevision,
    input.syncUnavailableMessage,
    update,
  ]);

  const observeFirstTokenPaint = useCallback(
    (executionId: string | undefined, element: HTMLElement | null): void => {
      if (executionId === undefined || element === null) return;
      const pendingPaint = pendingFirstTokenPaintsRef.current.get(executionId);
      if (
        pendingPaint === undefined ||
        paintedFirstTokensRef.current.has(executionId) ||
        firstTokenPaintFramesRef.current.has(executionId) ||
        document.visibilityState === "hidden"
      ) {
        return;
      }
      const frames: number[] = [];
      const paintFrame = requestAnimationFrame(() => {
        const confirmationFrame = requestAnimationFrame(() => {
          if (document.visibilityState === "hidden" || !element.isConnected) {
            firstTokenPaintFramesRef.current.delete(executionId);
            return;
          }
          paintedFirstTokensRef.current.add(executionId);
          pendingFirstTokenPaintsRef.current.delete(executionId);
          firstTokenPaintFramesRef.current.delete(executionId);
          input.api?.reportRendererLog({
            level: "info",
            event: "mission.first_ui_token_painted",
            monotonicAtMs: performance.now(),
            timeOriginMs: performance.timeOrigin,
            message: "Renderer painted the first UI-visible Mission token",
            missionId: input.missionId,
            executionId,
            navigationId: navigationIdRef.current,
            elapsedMs: Math.round((performance.now() - pendingPaint.receivedAt) * 100) / 100,
          });
        });
        frames.push(confirmationFrame);
      });
      frames.push(paintFrame);
      firstTokenPaintFramesRef.current.set(executionId, frames);
    },
    [input.api, input.missionId],
  );

  const loadEarlier = useCallback(
    async (beforeLoad: () => void): Promise<void> => {
      const beforeCursor = chatRef.current?.page.nextBeforeCursor;
      if (input.api === undefined || beforeCursor === undefined || loadingEarlier) return;
      setLoadingEarlier(true);
      setHistoryError(null);
      beforeLoad();
      try {
        const earlier = await input.api.getMissionChatPage({
          id: input.missionId,
          beforeCursor,
          limit: MISSION_CHAT_PAGE_SIZE,
        });
        update((current) => {
          const snapshot = conversationFromPage(earlier, current);
          return current === null ? snapshot : prependChatPage(current, snapshot);
        });
      } catch (error) {
        setHistoryError(input.formatError(error));
      } finally {
        setLoadingEarlier(false);
      }
    },
    [input.api, input.formatError, input.missionId, loadingEarlier, update],
  );

  return {
    chat,
    initialLoading,
    loadingEarlier,
    historyError,
    syncError,
    liveEntryStore,
    streamIdleStore,
    update: updateLatest,
    loadEarlier,
    observeFirstTokenPaint,
    refreshLatestChat: async () => {
      void backgroundReadsRef.current?.refreshControl();
      void backgroundReadsRef.current?.refreshContext();
      return await historyRefreshRef.current?.();
    },
    refreshControls: () => {
      void backgroundReadsRef.current?.refreshControl();
      void backgroundReadsRef.current?.refreshContext();
    },
  };
}

export interface MissionConversationPrefetch {
  readonly page: MissionChatPage;
  readonly state?: MissionConversationState | undefined;
  readonly stateUnavailable?: true | undefined;
}

export async function loadMissionConversationProjection(
  api: PragmaDesktopAPI,
  missionId: string,
): Promise<MissionConversationPrefetch> {
  const page = await api.getMissionChatPage({ id: missionId, limit: MISSION_CHAT_PAGE_SIZE });
  return { page };
}

export function markConversationStateUnavailable(
  snapshot: MissionConversationSnapshot,
): MissionConversationSnapshot {
  const issue = {
    code: "execution_state_unavailable" as const,
    section: "pending_interactions" as const,
    retryable: true as const,
  };
  return {
    ...snapshot,
    syncIssues: [
      ...(snapshot.syncIssues?.filter((candidate) => candidate.section !== issue.section) ?? []),
      issue,
    ],
  };
}

export function conversationFromPage(
  page: MissionChatPage,
  current: MissionConversationSnapshot | null,
): MissionConversationSnapshot {
  if (current === null || current.missionId !== page.missionId) {
    return {
      missionId: page.missionId,
      revision: page.revision,
      entries: page.entries,
      page: page.page,
      pendingInteractions: [],
      ...(page.syncIssues === undefined ? {} : { syncIssues: page.syncIssues }),
    };
  }
  const currentEntries = new Map(current.entries.map((entry) => [entry.id, entry] as const));
  return {
    ...current,
    revision: page.revision,
    entries: page.entries.map((entry) => {
      if (entry.kind !== "user" || entry.delivery !== undefined) return entry;
      const existing = currentEntries.get(entry.id);
      return existing?.kind === "user" && existing.delivery !== undefined
        ? { ...entry, delivery: existing.delivery }
        : entry;
    }),
    page: page.page,
    syncIssues: mergeSyncIssues(current.syncIssues, page.syncIssues, "history"),
  };
}

export function mergeConversationState(
  current: MissionConversationSnapshot | null,
  state: MissionConversationState,
): MissionConversationSnapshot | null {
  if (current === null || current.missionId !== state.missionId) return current;
  if (current.stateRevision !== undefined && state.revision < current.stateRevision) return current;
  const deliveries = new Map(
    state.deliveries.map((item) => [item.entryId, item.delivery] as const),
  );
  const hidden = new Set(state.hiddenEntryIds);
  return {
    ...current,
    stateRevision: state.revision,
    entries: current.entries
      .filter((entry) => !hidden.has(entry.id))
      .map((entry) => {
        if (entry.kind !== "user") return entry;
        const delivery = deliveries.get(entry.id);
        return delivery === undefined ? entry : { ...entry, delivery };
      }),
    pendingInteractions: state.pendingInteractions,
    queue:
      current.queueRevision !== undefined && current.queueRevision >= state.revision
        ? current.queue
        : state.queue,
    queueRevision: Math.max(current.queueRevision ?? 0, state.revision),
    execution: state.execution,
    controlHealth: state.controlHealth,
    syncIssues: mergeSyncIssues(current.syncIssues, state.syncIssues, "pending_interactions"),
  };
}

export function mergeContextWindow(
  current: MissionConversationSnapshot | null,
  value: MissionContextWindowSnapshot,
): MissionConversationSnapshot | null {
  if (current === null || current.missionId !== value.missionId) return current;
  if (current.contextRevision !== undefined && value.revision < current.contextRevision)
    return current;
  return {
    ...current,
    contextRevision: value.revision,
    contextWindow: value.contextWindow,
    syncIssues: mergeSyncIssues(current.syncIssues, value.syncIssues, "context_window"),
  };
}

function mergeSyncIssues(
  current: MissionConversationSnapshot["syncIssues"],
  incoming: MissionConversationSnapshot["syncIssues"],
  section: "history" | "pending_interactions" | "context_window",
): MissionConversationSnapshot["syncIssues"] {
  const merged = [
    ...(current ?? []).filter((issue) => issue.section !== section),
    ...(incoming ?? []).filter((issue) => issue.section === section),
  ];
  return merged.length === 0 ? undefined : merged;
}

export function cacheMissionConversationSnapshot(
  cache: Map<string, MissionConversationSnapshot> | undefined,
  missionId: string,
  snapshot: MissionConversationSnapshot,
  readEntry?:
    ((entryId: string) => MissionConversationSnapshot["entries"][number] | undefined) | undefined,
): void {
  if (cache === undefined) return;
  const completeSnapshot = materializeMissionChatSnapshot(snapshot, readEntry);
  cache.delete(missionId);
  cache.set(missionId, completeSnapshot);
  while (cache.size > 8) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function isMissionConversationCacheReady(
  snapshot: MissionConversationSnapshot | null | undefined,
): snapshot is MissionConversationSnapshot & { readonly stateRevision: number } {
  return snapshot?.stateRevision !== undefined;
}

function readyCachedConversation(
  cache: Map<string, MissionConversationSnapshot> | undefined,
  missionId: string,
  allowUnversioned: boolean,
): MissionConversationSnapshot | null {
  const snapshot = cache?.get(missionId);
  return snapshot !== undefined && (allowUnversioned || isMissionConversationCacheReady(snapshot))
    ? snapshot
    : null;
}
