import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";

import type {
  MissionConversationSnapshot,
  MissionWorkConversationSnapshot,
  MissionWorkConversationStreamUpdate,
  MissionWorkRecord,
  PragmaDesktopAPI,
} from "../../../../shared/contracts/index.ts";
import { applyMissionChatPatches, uniqueChatEntries } from "./mission-conversation-model.ts";
import { MISSION_WORK_CONVERSATION_PAGE_SIZE } from "./mission-view-constants.ts";

export function useMissionWork(options: {
  readonly missionId: string;
  readonly executionId?: string | undefined;
  readonly active: boolean;
  readonly api?: PragmaDesktopAPI | undefined;
  readonly formatError: (error: unknown) => string;
}) {
  const [records, setRecords] = useState<readonly MissionWorkRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [conversation, setConversation] = useState<MissionWorkConversationSnapshot | null>(null);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const conversationRef = useRef<MissionWorkConversationSnapshot | null>(null);
  const updateConversation = useCallback(
    (value: SetStateAction<MissionWorkConversationSnapshot | null>): void => {
      const next = typeof value === "function" ? value(conversationRef.current) : value;
      conversationRef.current = next;
      setConversation(next);
    },
    [],
  );

  const selectedRecord = useMemo(
    () => records.find((record) => record.recordId === selectedRecordId),
    [records, selectedRecordId],
  );

  useEffect(() => {
    setRecords([]);
    updateConversation(null);
    setSelectedRecordId(null);
    setError(null);
  }, [options.missionId, updateConversation]);

  useEffect(() => {
    if (selectedRecordId !== null && selectedRecord === undefined) setSelectedRecordId(null);
  }, [selectedRecord, selectedRecordId]);

  useEffect(() => {
    if (selectedRecord === undefined) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedRecordId(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selectedRecord]);

  useEffect(() => {
    if (options.api === undefined || !options.active || options.executionId === undefined) {
      setRecords([]);
      return;
    }
    let cancelled = false;
    let refreshing = false;
    let dirty = false;

    const refresh = async () => {
      if (refreshing) {
        dirty = true;
        return;
      }
      refreshing = true;
      setLoading(true);
      try {
        do {
          dirty = false;
          const snapshot = await options.api!.getMissionWork(options.missionId);
          if (cancelled) return;
          setError(null);
          setRecords(snapshot.records);
        } while (dirty && !cancelled);
      } catch (loadError) {
        if (!cancelled) {
          console.error("Failed to refresh Mission work history.", loadError);
          setError(options.formatError(loadError));
        }
      } finally {
        if (!cancelled) setLoading(false);
        refreshing = false;
      }
    };

    const unsubscribe = options.api.subscribeMissionWork(options.missionId, () => void refresh());
    void refresh();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    options.active,
    options.api,
    options.executionId,
    options.formatError,
    options.missionId,
    refreshRevision,
  ]);

  useEffect(() => {
    if (
      options.api === undefined ||
      !options.active ||
      options.executionId === undefined ||
      selectedRecordId === null
    ) {
      updateConversation(null);
      return;
    }
    let cancelled = false;
    const subscriptionId = crypto.randomUUID();
    let streamId: string | undefined;
    let nextSequence = 1;
    const pendingUpdates: MissionWorkConversationStreamUpdate[] = [];
    setConversationLoading(true);
    const refreshConversation = async (): Promise<void> => {
      const next = await options.api!.getMissionWorkConversation({
        id: options.missionId,
        recordId: selectedRecordId,
        limit: MISSION_WORK_CONVERSATION_PAGE_SIZE,
      });
      if (cancelled) return;
      updateConversation((current) => mergeLatestMissionWorkConversation(current, next));
    };
    function drainPendingUpdates(): void {
      if (streamId === undefined) return;
      while (true) {
        const index = pendingUpdates.findIndex(
          (update) => update.streamId === streamId && update.sequence === nextSequence,
        );
        if (index < 0) return;
        applyUpdate(pendingUpdates.splice(index, 1)[0]!);
      }
    }
    function applyUpdate(update: MissionWorkConversationStreamUpdate): void {
      if (cancelled || update.subscriptionId !== subscriptionId) return;
      if (streamId === undefined) {
        pendingUpdates.push(update);
        return;
      }
      if (update.streamId !== streamId || update.sequence < nextSequence) return;
      if (update.sequence > nextSequence) {
        pendingUpdates.push(update);
        return;
      }
      nextSequence += 1;
      if (update.kind === "invalidate") {
        void refreshConversation().catch(() => undefined);
        drainPendingUpdates();
        return;
      }
      const current = conversationRef.current;
      if (current === null) {
        pendingUpdates.push(update);
        return;
      }
      const projected: MissionConversationSnapshot = {
        missionId: current.missionId,
        revision: update.sequence - 1,
        entries: current.entries,
        page: {},
        pendingInteractions: [],
      };
      const patched = applyMissionChatPatches(projected, update.patches, update.sequence);
      if (patched === null) {
        void refreshConversation().catch(() => undefined);
        return;
      }
      updateConversation({ ...current, entries: patched.entries });
      drainPendingUpdates();
    }
    const unsubscribe = options.api.subscribeMissionWorkConversationUpdates(applyUpdate);
    options.api
      .openMissionWorkConversationStream({
        subscriptionId,
        missionId: options.missionId,
        recordId: selectedRecordId,
        limit: MISSION_WORK_CONVERSATION_PAGE_SIZE,
      })
      .then((next) => {
        if (cancelled) return;
        streamId = next.streamId;
        updateConversation(next.snapshot);
        for (const update of pendingUpdates
          .splice(0)
          .toSorted((left, right) => left.sequence - right.sequence)) {
          applyUpdate(update);
        }
      })
      .catch((loadError) => {
        if (!cancelled) console.error("Failed to load Mission work conversation.", loadError);
      })
      .finally(() => {
        if (!cancelled) setConversationLoading(false);
      });
    return () => {
      cancelled = true;
      unsubscribe();
      void options
        .api!.closeMissionWorkConversationStream({ subscriptionId })
        .catch(() => undefined);
    };
  }, [
    options.active,
    options.api,
    options.executionId,
    options.missionId,
    refreshRevision,
    selectedRecordId,
    updateConversation,
  ]);

  const loadEarlier = useCallback(async (): Promise<void> => {
    if (
      options.api === undefined ||
      selectedRecord === undefined ||
      conversation?.nextBeforeCursor === undefined ||
      conversationLoading
    ) {
      return;
    }
    setConversationLoading(true);
    try {
      const earlier = await options.api.getMissionWorkConversation({
        id: options.missionId,
        recordId: selectedRecord.recordId,
        beforeCursor: conversation.nextBeforeCursor,
        limit: MISSION_WORK_CONVERSATION_PAGE_SIZE,
      });
      if (conversationRef.current?.recordId !== earlier.recordId) return;
      updateConversation((current) => prependMissionWorkConversation(current, earlier));
    } catch (loadError) {
      console.error("Failed to load earlier Mission work conversation.", loadError);
    } finally {
      setConversationLoading(false);
    }
  }, [
    conversation,
    conversationLoading,
    options.api,
    options.missionId,
    selectedRecord,
    updateConversation,
  ]);

  return {
    records,
    loading,
    error,
    retry: () => setRefreshRevision((current) => current + 1),
    selectedRecord,
    selectRecord: (recordId: string | null) => {
      updateConversation(null);
      setSelectedRecordId(recordId);
    },
    conversation,
    conversationLoading,
    loadEarlier,
  };
}

export function mergeLatestMissionWorkConversation(
  current: MissionWorkConversationSnapshot | null,
  latest: MissionWorkConversationSnapshot,
): MissionWorkConversationSnapshot {
  if (current === null || current.recordId !== latest.recordId) return latest;
  return {
    ...latest,
    revision: Math.max(current.revision, latest.revision),
    entries: uniqueChatEntries([...current.entries, ...latest.entries]),
    ...(current.nextBeforeCursor === undefined
      ? { nextBeforeCursor: undefined }
      : { nextBeforeCursor: current.nextBeforeCursor }),
  };
}

export function prependMissionWorkConversation(
  current: MissionWorkConversationSnapshot | null,
  earlier: MissionWorkConversationSnapshot,
): MissionWorkConversationSnapshot {
  if (current === null || current.recordId !== earlier.recordId) return earlier;
  return {
    ...current,
    revision: Math.max(current.revision, earlier.revision),
    entries: uniqueChatEntries([...earlier.entries, ...current.entries]),
    ...(earlier.nextBeforeCursor === undefined
      ? { nextBeforeCursor: undefined }
      : { nextBeforeCursor: earlier.nextBeforeCursor }),
  };
}
