import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";

import type {
  MissionChatPage,
  MissionChatUpdate,
  MissionContextWindowSnapshot,
  MissionConversationSnapshot,
  MissionConversationState,
  PragmaDesktopAPI,
} from "../../../../shared/contracts/index.ts";
import {
  applyMissionChatUpdateBatch,
  firstVisiblePatchExecutionId,
  prependChatPage,
  reconcileMissionChatRefresh,
} from "./mission-conversation-model.ts";
import { MissionLiveEntryStore } from "./mission-live-entry-store.ts";
import { MISSION_CHAT_PAGE_SIZE } from "./mission-view-constants.ts";

export function useMissionConversation(input: {
  readonly missionId: string;
  readonly navigationId?: string | undefined;
  readonly api: PragmaDesktopAPI | undefined;
  readonly cache?: Map<string, MissionConversationSnapshot> | undefined;
  readonly prefetchedPage?: Promise<MissionChatPage | undefined> | undefined;
  readonly refreshRevision: number;
  readonly syncUnavailableMessage: string;
  readonly formatError: (error: unknown) => string;
}) {
  const [chat, setChat] = useState<MissionConversationSnapshot | null>(
    () => input.cache?.get(input.missionId) ?? null,
  );
  const [initialLoading, setInitialLoading] = useState(
    () => input.cache?.has(input.missionId) !== true,
  );
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const liveEntryStore = useMemo(() => new MissionLiveEntryStore(), [input.missionId]);
  const chatRef = useRef<MissionConversationSnapshot | null>(null);
  const receivedFirstTokensRef = useRef(new Set<string>());
  const paintedFirstTokensRef = useRef(new Set<string>());
  const pendingFirstTokenPaintsRef = useRef(new Map<string, { readonly receivedAt: number }>());
  const firstTokenPaintFramesRef = useRef(new Map<string, number[]>());
  const navigationIdRef = useRef(input.navigationId ?? crypto.randomUUID());

  const update = useCallback(
    (value: SetStateAction<MissionConversationSnapshot | null>) => {
      const next = typeof value === "function" ? value(chatRef.current) : value;
      chatRef.current = next;
      if (next === null) liveEntryStore.clear();
      else liveEntryStore.reset(next.entries);
      if (next !== null && next.missionId === input.missionId) {
        setCachedConversation(input.cache, input.missionId, next);
      }
      setChat(next);
    },
    [input.cache, input.missionId, liveEntryStore],
  );

  const advanceLive = useCallback(
    (next: MissionConversationSnapshot, changedEntryIds: ReadonlySet<string>) => {
      chatRef.current = next;
      setCachedConversation(input.cache, input.missionId, next);
      if (changedEntryIds.size === 0) return;
      const changedEntries = new Map(
        next.entries
          .filter((entry) => changedEntryIds.has(entry.id))
          .map((entry) => [entry.id, entry] as const),
      );
      for (const entryId of changedEntryIds) {
        const entry = changedEntries.get(entryId);
        if (entry !== undefined) liveEntryStore.publish(entry);
      }
    },
    [input.cache, input.missionId, liveEntryStore],
  );

  useEffect(() => {
    const cached = input.cache?.get(input.missionId) ?? null;
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
    update(cached);
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
    let refreshing = false;
    let refreshQueued = false;
    let prefetchedPage = input.prefetchedPage;
    let stateRequestGeneration = 0;
    let frame: number | undefined;
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    let lastPerformanceLogAt = 0;
    let pending: MissionChatUpdate[] = [];
    receivedFirstTokensRef.current.clear();
    paintedFirstTokensRef.current.clear();
    pendingFirstTokenPaintsRef.current.clear();
    for (const frames of firstTokenPaintFramesRef.current.values()) {
      for (const paintFrame of frames) cancelAnimationFrame(paintFrame);
    }
    firstTokenPaintFramesRef.current.clear();

    const drainPending = (base: MissionConversationSnapshot) => {
      const drained = applyMissionChatUpdateBatch(base, pending);
      pending = [...drained.remaining];
      return drained;
    };

    const refresh = async (): Promise<void> => {
      if (refreshing) {
        refreshQueued = true;
        return;
      }
      refreshing = true;
      try {
        const page =
          (await prefetchedPage) ??
          (await api.getMissionChatPage({
            id: input.missionId,
            limit: MISSION_CHAT_PAGE_SIZE,
          }));
        prefetchedPage = undefined;
        if (!cancelled) {
          const snapshot = conversationFromPage(page, chatRef.current);
          const drained = reconcileMissionChatRefresh(chatRef.current, snapshot, pending);
          pending = [...drained.remaining];
          update(drained.snapshot);
          setSyncError(
            drained.snapshot.syncIssues === undefined ? null : input.syncUnavailableMessage,
          );
          if (drained.needsRefresh) refreshQueued = true;
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
              void refreshConversationState(api);
            });
          });
        }
      } catch (error) {
        if (!cancelled) setSyncError(input.formatError(error));
      } finally {
        if (!cancelled) setInitialLoading(false);
        refreshing = false;
        if (refreshQueued && !cancelled) {
          refreshQueued = false;
          void refresh();
        }
      }
    };

    const refreshConversationState = async (desktopApi: PragmaDesktopAPI): Promise<void> => {
      const requestGeneration = ++stateRequestGeneration;
      const startedAt = performance.now();
      const [stateResult, contextResult] = await Promise.allSettled([
        desktopApi.getMissionConversationState(input.missionId),
        desktopApi.getMissionContextWindow(input.missionId),
      ]);
      if (cancelled || requestGeneration !== stateRequestGeneration) return;
      if (stateResult.status === "fulfilled") {
        update((current) => mergeConversationState(current, stateResult.value));
      } else {
        setSyncError(input.formatError(stateResult.reason));
      }
      if (contextResult.status === "fulfilled") {
        update((current) => mergeContextWindow(current, contextResult.value));
      }
      desktopApi.reportRendererLog({
        level: "info",
        event: "mission.conversation_state_ready",
        message: "Mission conversation background state resolved",
        missionId: input.missionId,
        navigationId,
        elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
    };

    const flush = (): void => {
      frame = undefined;
      if (hiddenTimer !== undefined) clearTimeout(hiddenTimer);
      hiddenTimer = undefined;
      if (cancelled || chatRef.current === null || pending.length === 0) return;
      const startedAt = performance.now();
      const drained = drainPending(chatRef.current);
      if (drained.requiresRender) update(drained.snapshot);
      else advanceLive(drained.snapshot, drained.changedEntryIds);
      const finishedAt = performance.now();
      if (finishedAt - lastPerformanceLogAt >= 5_000) {
        lastPerformanceLogAt = finishedAt;
        const activeContentLength = drained.snapshot.entries.reduce(
          (longest, entry) =>
            drained.changedEntryIds.has(entry.id) &&
            (entry.kind === "assistant" || entry.kind === "thinking")
              ? Math.max(longest, entry.content.length)
              : longest,
          0,
        );
        api.reportRendererLog({
          level: "info",
          event: "mission.stream_flush",
          message: `Mission stream flush updated ${drained.changedEntryIds.size} entries (${drained.snapshot.entries.length} loaded, ${activeContentLength} active characters)`,
          missionId: input.missionId,
          executionId: drained.snapshot.execution?.id,
          elapsedMs: Math.round((finishedAt - startedAt) * 100) / 100,
        });
      }
      if (drained.needsRefresh) void refresh();
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
      pending.push(updateValue);
      const executionId = firstVisiblePatchExecutionId(updateValue, chatRef.current);
      if (executionId !== undefined && !receivedFirstTokensRef.current.has(executionId)) {
        receivedFirstTokensRef.current.add(executionId);
        pendingFirstTokenPaintsRef.current.set(executionId, { receivedAt: performance.now() });
        api.reportRendererLog({
          level: "info",
          event: "mission.first_ui_token_received",
          message: "Renderer received the first UI-visible Mission token",
          missionId: input.missionId,
          executionId,
          navigationId,
        });
      }
      scheduleFlush();
    });
    void refresh();
    return () => {
      cancelled = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (hiddenTimer !== undefined) clearTimeout(hiddenTimer);
      pendingFirstTokenPaintsRef.current.clear();
      for (const frames of firstTokenPaintFramesRef.current.values()) {
        for (const paintFrame of frames) cancelAnimationFrame(paintFrame);
      }
      firstTokenPaintFramesRef.current.clear();
      unsubscribe();
      longTaskObserver?.disconnect();
    };
  }, [
    advanceLive,
    input.api,
    input.cache,
    input.formatError,
    input.missionId,
    input.navigationId,
    input.prefetchedPage,
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
    update,
    loadEarlier,
    observeFirstTokenPaint,
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
  return {
    ...current,
    revision: page.revision,
    entries: page.entries,
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
    queue: state.queue,
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

function setCachedConversation(
  cache: Map<string, MissionConversationSnapshot> | undefined,
  missionId: string,
  snapshot: MissionConversationSnapshot,
): void {
  if (cache === undefined) return;
  cache.delete(missionId);
  cache.set(missionId, snapshot);
  while (cache.size > 8) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
