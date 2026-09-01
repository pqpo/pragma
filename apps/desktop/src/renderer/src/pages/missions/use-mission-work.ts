import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  MissionWorkConversationSnapshot,
  MissionWorkRecord,
  PragmaDesktopAPI,
} from "../../../../shared/contracts/index.ts";
import { uniqueChatEntries } from "./mission-conversation-model.ts";
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

  const selectedRecord = useMemo(
    () => records.find((record) => record.recordId === selectedRecordId),
    [records, selectedRecordId],
  );

  useEffect(() => {
    setRecords([]);
    setConversation(null);
    setSelectedRecordId(null);
    setError(null);
  }, [options.missionId]);

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
      setConversation(null);
      return;
    }
    let cancelled = false;
    setConversationLoading(true);
    options.api
      .getMissionWorkConversation({
        id: options.missionId,
        recordId: selectedRecordId,
        limit: MISSION_WORK_CONVERSATION_PAGE_SIZE,
      })
      .then((next) => {
        if (cancelled) return;
        setConversation((current) =>
          current === null || current.recordId !== next.recordId
            ? next
            : {
                ...next,
                entries: uniqueChatEntries([...current.entries, ...next.entries]),
                nextBeforeCursor: current.nextBeforeCursor,
              },
        );
      })
      .catch((loadError) => {
        if (!cancelled) console.error("Failed to load Mission work conversation.", loadError);
      })
      .finally(() => {
        if (!cancelled) setConversationLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    options.active,
    options.api,
    options.executionId,
    options.missionId,
    refreshRevision,
    selectedRecordId,
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
      setConversation((current) =>
        current === null || current.recordId !== earlier.recordId
          ? earlier
          : {
              ...current,
              revision: Math.max(current.revision, earlier.revision),
              entries: uniqueChatEntries([...earlier.entries, ...current.entries]),
              ...(earlier.nextBeforeCursor === undefined
                ? { nextBeforeCursor: undefined }
                : { nextBeforeCursor: earlier.nextBeforeCursor }),
            },
      );
    } catch (loadError) {
      console.error("Failed to load earlier Mission work conversation.", loadError);
    } finally {
      setConversationLoading(false);
    }
  }, [conversation, conversationLoading, options.api, options.missionId, selectedRecord]);

  return {
    records,
    loading,
    error,
    retry: () => setRefreshRevision((current) => current + 1),
    selectedRecord,
    selectRecord: (recordId: string | null) => {
      setConversation(null);
      setSelectedRecordId(recordId);
    },
    conversation,
    conversationLoading,
    loadEarlier,
  };
}
