import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { flushSync } from "react-dom";

import type {
  MissionChatSnapshot,
  MissionChatUpdate,
  PragmaDesktopAPI,
} from "../../../../shared/contracts/index.ts";
import {
  applyMissionChatPatches,
  firstVisiblePatchExecutionId,
  mergeLatestChatPage,
  missionChatPatchesRequireRender,
  prependChatPage,
} from "./mission-conversation-model.ts";
import { MissionLiveEntryStore } from "./mission-live-entry-store.ts";
import {
  MISSION_CHAT_PAGE_SIZE,
  MISSION_CHAT_STREAM_FLUSH_INTERVAL_MS,
} from "./mission-view-constants.ts";

export function useMissionConversation(input: {
  readonly missionId: string;
  readonly api: PragmaDesktopAPI | undefined;
  readonly cache?: Map<string, MissionChatSnapshot> | undefined;
  readonly refreshRevision: number;
  readonly syncUnavailableMessage: string;
  readonly formatError: (error: unknown) => string;
}) {
  const [chat, setChat] = useState<MissionChatSnapshot | null>(
    () => input.cache?.get(input.missionId) ?? null,
  );
  const [initialLoading, setInitialLoading] = useState(
    () => input.cache?.has(input.missionId) !== true,
  );
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const liveEntryStore = useMemo(() => new MissionLiveEntryStore(), [input.missionId]);
  const chatRef = useRef<MissionChatSnapshot | null>(null);
  const receivedFirstTokensRef = useRef(new Set<string>());
  const paintedFirstTokensRef = useRef(new Set<string>());
  const pendingFirstTokenPaintsRef = useRef(new Map<string, { readonly receivedAt: number }>());
  const firstTokenPaintFramesRef = useRef(new Map<string, number[]>());

  const update = useCallback(
    (value: SetStateAction<MissionChatSnapshot | null>) => {
      const next = typeof value === "function" ? value(chatRef.current) : value;
      chatRef.current = next;
      if (next === null) liveEntryStore.clear();
      else liveEntryStore.reset(next.entries);
      if (next !== null && next.missionId === input.missionId) {
        input.cache?.set(input.missionId, next);
      }
      setChat(next);
    },
    [input.cache, input.missionId, liveEntryStore],
  );

  const advanceLive = useCallback(
    (next: MissionChatSnapshot, changedEntryIds: ReadonlySet<string>) => {
      chatRef.current = next;
      input.cache?.set(input.missionId, next);
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
    update(cached);
    setInitialLoading(cached === null);
    setHistoryError(null);
    setSyncError(null);
    const api = input.api;
    if (api === undefined) {
      setInitialLoading(false);
      return;
    }
    let cancelled = false;
    let refreshing = false;
    let refreshQueued = false;
    let frame: number | undefined;
    let visibleTimer: ReturnType<typeof setTimeout> | undefined;
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    let lastVisibleFlushAt = 0;
    let lastPerformanceLogAt = 0;
    let pending: MissionChatUpdate[] = [];
    receivedFirstTokensRef.current.clear();
    paintedFirstTokensRef.current.clear();
    pendingFirstTokenPaintsRef.current.clear();
    for (const frames of firstTokenPaintFramesRef.current.values()) {
      for (const paintFrame of frames) cancelAnimationFrame(paintFrame);
    }
    firstTokenPaintFramesRef.current.clear();

    const drainPending = (base: MissionChatSnapshot) => {
      const updates = pending.toSorted((left, right) => left.revision - right.revision);
      pending = [];
      let snapshot = base;
      let requiresRender = false;
      const changedEntryIds = new Set<string>();
      for (let index = 0; index < updates.length; index += 1) {
        const candidate = updates[index]!;
        if (candidate.revision <= snapshot.revision) continue;
        if (candidate.revision !== snapshot.revision + 1 || candidate.kind === "invalidate") {
          pending.push(...updates.slice(index));
          return { snapshot, needsRefresh: true, requiresRender, changedEntryIds };
        }
        const next = applyMissionChatPatches(snapshot, candidate.patches, candidate.revision);
        if (next === null) {
          pending.push(...updates.slice(index));
          return { snapshot, needsRefresh: true, requiresRender, changedEntryIds };
        }
        for (const patch of candidate.patches) {
          if (patch.type === "entry.append") changedEntryIds.add(patch.entryId);
          else if (patch.type === "entry.upsert") changedEntryIds.add(patch.entry.id);
          if (missionChatPatchesRequireRender([patch])) requiresRender = true;
        }
        snapshot = next;
      }
      return { snapshot, needsRefresh: false, requiresRender, changedEntryIds };
    };

    const refresh = async (): Promise<void> => {
      if (refreshing) {
        refreshQueued = true;
        return;
      }
      refreshing = true;
      try {
        const snapshot = await api.getMissionChat({
          id: input.missionId,
          limit: MISSION_CHAT_PAGE_SIZE,
        });
        if (!cancelled) {
          pending = pending.filter((candidate) => candidate.revision > snapshot.revision);
          const drained = drainPending(mergeLatestChatPage(chatRef.current, snapshot));
          update(drained.snapshot);
          setSyncError(snapshot.syncIssues === undefined ? null : input.syncUnavailableMessage);
          if (drained.needsRefresh) refreshQueued = true;
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

    const flush = (): void => {
      frame = undefined;
      if (visibleTimer !== undefined) clearTimeout(visibleTimer);
      if (hiddenTimer !== undefined) clearTimeout(hiddenTimer);
      visibleTimer = undefined;
      hiddenTimer = undefined;
      if (cancelled || chatRef.current === null || pending.length === 0) return;
      if (document.visibilityState !== "hidden") lastVisibleFlushAt = performance.now();
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
      if (
        frame !== undefined ||
        visibleTimer !== undefined ||
        hiddenTimer !== undefined ||
        cancelled
      )
        return;
      if (document.visibilityState === "hidden") {
        hiddenTimer = setTimeout(flush, 100);
        return;
      }
      const remaining = Math.max(
        0,
        MISSION_CHAT_STREAM_FLUSH_INTERVAL_MS - (performance.now() - lastVisibleFlushAt),
      );
      if (remaining === 0) frame = requestAnimationFrame(flush);
      else {
        visibleTimer = setTimeout(() => {
          visibleTimer = undefined;
          frame = requestAnimationFrame(flush);
        }, remaining);
      }
    };

    const flushVisibleFirstPatch = (): void => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (visibleTimer !== undefined) clearTimeout(visibleTimer);
      if (hiddenTimer !== undefined) clearTimeout(hiddenTimer);
      frame = undefined;
      visibleTimer = undefined;
      hiddenTimer = undefined;
      flushSync(flush);
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
        });
        if (document.visibilityState !== "hidden" && chatRef.current !== null) {
          flushVisibleFirstPatch();
          return;
        }
      }
      scheduleFlush();
    });
    void refresh();
    return () => {
      cancelled = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (visibleTimer !== undefined) clearTimeout(visibleTimer);
      if (hiddenTimer !== undefined) clearTimeout(hiddenTimer);
      pendingFirstTokenPaintsRef.current.clear();
      for (const frames of firstTokenPaintFramesRef.current.values()) {
        for (const paintFrame of frames) cancelAnimationFrame(paintFrame);
      }
      firstTokenPaintFramesRef.current.clear();
      unsubscribe();
    };
  }, [
    advanceLive,
    input.api,
    input.cache,
    input.formatError,
    input.missionId,
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
        const earlier = await input.api.getMissionChat({
          id: input.missionId,
          beforeCursor,
          limit: MISSION_CHAT_PAGE_SIZE,
        });
        update((current) => (current === null ? earlier : prependChatPage(current, earlier)));
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
