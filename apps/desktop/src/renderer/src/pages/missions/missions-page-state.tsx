import { resolveUnlistedMissionSelection } from "./mission-list-selection.ts";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmationDialog } from "../../components/Dialog.tsx";
import {
  type Mission,
  type MissionConversationSnapshot,
  type MissionStatusUpdate,
  type MissionSummary,
  type ExpertMentionCandidate,
  type MissionMentionCandidates,
} from "../../../../shared/contracts/index.ts";
import { localizedMissionError } from "../../lib/mission-errors.ts";
import {
  mergeLatestChatPage,
  touchMissionConversationCache,
} from "./mission-conversation-model.ts";
import {
  canStoreFailedMissionComposerRecovery,
  clearMissionComposerRecoveries,
  consumeMissionComposerRecovery,
  discardMissionComposerRecovery as releaseMissionComposerRecovery,
  discardMissionComposerRecoverySnapshot,
  releaseMissionComposerSnapshot,
  storeMissionComposerRecovery,
  type MissionComposerRecoveryWriteReason,
  type MissionComposerSnapshot,
} from "./mission-composer-recovery.ts";
import {
  conversationFromPage,
  isMissionConversationCacheReady,
  loadMissionConversationProjection,
  markConversationStateUnavailable,
  mergeConversationState,
  type MissionConversationPrefetch,
} from "./use-mission-conversation.ts";
import { SidebarResizeHandle } from "../../components/SidebarResizeHandle.tsx";
import {
  SIDEBAR_WIDTH_PREFERENCES,
  usePersistentSidebarWidth,
} from "../../lib/sidebar-width-preference.ts";
import { removeMissionDrafts, writeMissionDraft } from "../../lib/mission-draft.ts";
import {
  acceptMissionChatUpdate,
  markMissionOutputReadIds,
  readMissionOutputBoundaries,
  readUnreadMissionOutputIds,
  recordMissionChatUpdateIds,
  writeMissionOutputBoundaries,
  writeUnreadMissionOutputIds,
} from "../../lib/mission-unread-output.ts";
import {
  readPinnedMissionIds,
  readLastOpenedMissionId,
  selectPreferredMissionId,
  togglePinnedMissionId,
  writePinnedMissionIds,
  writeLastOpenedMissionId,
} from "../../lib/mission-preference.ts";
import {
  applyMissionStatusUpdateToMission,
  applyMissionStatusUpdateToSummary,
  desktopApi,
  formatMissionListTitle,
  missionListSourceForMission,
  missionListSourceForSummary,
  missionToSummary,
  teamMissionsForMentionCandidates,
  upsertMissionSummary,
} from "./mission-page-utils.ts";
import { MissionDetailSkeleton, MissionRail, MissionsPageSkeleton } from "./mission-rail.tsx";
import { MissionDetailFragment, withMissionUiWatchdog } from "./mission-detail.tsx";
import { MissionErrorBanner } from "./mission-memory-usage.tsx";

export interface MissionsPageMemoryState {
  readonly missions: readonly MissionSummary[];
  readonly selectedMission: Mission | null;
  readonly selectedMissionId: string | null;
  readonly activeSource?: MissionListSource | undefined;
  readonly selectedMissionIds?: Partial<Record<MissionListSource, string>> | undefined;
}

interface MissionsPageInitialState extends MissionsPageMemoryState {
  readonly hasResolvedInitialLoad: boolean;
  readonly activeSource: MissionListSource;
  readonly selectedMissionIds: Partial<Record<MissionListSource, string>>;
}

export type MissionListSource = "task" | "automation";

export function recordMissionRemoval(input: {
  readonly missionId: string;
  readonly removedMissionIds: Set<string>;
  readonly missionDetails: Map<string, Mission>;
  readonly missionUpdates: Map<
    string,
    { readonly mission: Mission; readonly source: MissionSummary["source"] } | null
  >;
}): void {
  input.removedMissionIds.add(input.missionId);
  input.missionDetails.delete(input.missionId);
  input.missionUpdates.set(input.missionId, null);
}

export function resolveMissionsPageInitialState(input: {
  readonly initialMission?: Mission | undefined;
  readonly memoryState?: MissionsPageMemoryState | undefined;
}): MissionsPageInitialState {
  const cachedMissions = input.memoryState?.missions ?? [];
  if (input.initialMission !== undefined) {
    const cached = cachedMissions.find((mission) => mission.id === input.initialMission!.id);
    const source =
      (cached === undefined ? undefined : missionListSourceForSummary(cached)) ??
      missionListSourceForMission(input.initialMission);
    return {
      missions: upsertMissionSummary(
        cachedMissions,
        missionToSummary(input.initialMission, cached?.source),
      ),
      selectedMission: input.initialMission,
      selectedMissionId: input.initialMission.id,
      activeSource: source,
      selectedMissionIds: {
        ...input.memoryState?.selectedMissionIds,
        [source]: input.initialMission.id,
      },
      hasResolvedInitialLoad: true,
    };
  }
  if (input.memoryState !== undefined) {
    const activeSource = input.memoryState.activeSource ?? "task";
    return {
      ...input.memoryState,
      activeSource,
      selectedMissionIds: input.memoryState.selectedMissionIds ?? {},
      hasResolvedInitialLoad: true,
    };
  }
  return {
    missions: [],
    selectedMission: null,
    selectedMissionId: null,
    activeSource: "task",
    selectedMissionIds: {},
    hasResolvedInitialLoad: false,
  };
}

export function MissionsPage(props: {
  readonly initialMission?: Mission | undefined;
  readonly initialComposerDraft?: string | undefined;
  readonly initialMemoryState?: MissionsPageMemoryState | undefined;
  readonly memoryEnabled?: boolean | undefined;
  readonly autoRunInitialMission?: boolean | undefined;
  readonly onCreate: () => void;
  readonly onMemoryStateChange?: ((state: MissionsPageMemoryState) => void) | undefined;
  readonly onConfigureModels?: (() => void) | undefined;
  readonly onOpenKnowledgeBases?: (() => void) | undefined;
  readonly onOpenKnowledgeRevision?: ((storeId: string) => void) | undefined;
  readonly onEditExpert?: ((expertRef?: string | undefined) => void) | undefined;
}) {
  const { t } = useTranslation(["missions", "common"]);
  const missionError = useCallback(
    (error: unknown) =>
      localizedMissionError(error, (key, options) =>
        options === undefined ? t(key) : t(key, options),
      ),
    [t],
  );
  const initialStateRef = useRef<MissionsPageInitialState>(
    resolveMissionsPageInitialState({
      initialMission: props.initialMission,
      memoryState: props.initialMemoryState,
    }),
  );
  const initialState = initialStateRef.current;
  const [railWidth, setRailWidth] = usePersistentSidebarWidth(SIDEBAR_WIDTH_PREFERENCES.missions);
  const [missions, setMissions] = useState<readonly MissionSummary[]>(initialState.missions);
  const [mentionCandidatesByMissionId, setMentionCandidatesByMissionId] = useState<
    Readonly<Record<string, readonly ExpertMentionCandidate[]>>
  >({});
  const [selectedMission, setSelectedMission] = useState<Mission | null>(
    initialState.selectedMission,
  );
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(
    initialState.selectedMissionId,
  );
  const [loadingMissionId, setLoadingMissionId] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<MissionListSource>(initialState.activeSource);
  const [hasResolvedInitialLoad, setHasResolvedInitialLoad] = useState(
    initialState.hasResolvedInitialLoad,
  );
  const [pinnedMissionIds, setPinnedMissionIds] = useState<readonly string[]>(() =>
    readPinnedMissionIds(typeof window === "undefined" ? undefined : window.localStorage),
  );
  const [unreadMissionOutputIds, setUnreadMissionOutputIds] = useState<readonly string[]>(() =>
    readUnreadMissionOutputIds(typeof window === "undefined" ? undefined : window.localStorage),
  );
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [, setComposerRecoveryRevision] = useState(0);
  const [deleteCandidate, setDeleteCandidate] = useState<MissionSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [initialRunRequest, setInitialRunRequest] = useState<{
    readonly missionId: string;
    readonly requestId: string;
  } | null>(() =>
    props.autoRunInitialMission && props.initialMission !== undefined
      ? {
          missionId: props.initialMission.id,
          requestId: props.initialMission.initialMessageId,
        }
      : null,
  );
  const selectedMissionIdRef = useRef<string | null>(initialState.selectedMissionId);
  const activeSourceRef = useRef<MissionListSource>(initialState.activeSource);
  const selectedMissionIdsRef = useRef<Partial<Record<MissionListSource, string>>>(
    initialState.selectedMissionIds,
  );
  const missionChatCacheRef = useRef(new Map<string, MissionConversationSnapshot>());
  const missionTeamIdentityCacheRef = useRef(new Map<string, MissionMentionCandidates>());
  const missionOutputBoundariesRef = useRef(
    readMissionOutputBoundaries(typeof window === "undefined" ? undefined : window.localStorage),
  );
  const missionDetailCacheRef = useRef(
    new Map<string, Mission>(
      props.initialMission === undefined ? [] : [[props.initialMission.id, props.initialMission]],
    ),
  );
  const missionConversationRequestsRef = useRef(
    new Map<string, Promise<MissionConversationPrefetch | undefined>>(),
  );
  const missionDetailRequestsRef = useRef(new Map<string, Promise<Mission>>());
  const missionNavigationIdsRef = useRef(new Map<string, string>());
  const initialRunStartedRef = useRef(false);
  const hadInitialMemoryStateRef = useRef(props.initialMemoryState !== undefined);
  const removedMissionIdsRef = useRef(new Set<string>());
  const missionUpdatesDuringRefreshRef = useRef(
    new Map<
      string,
      { readonly mission: Mission; readonly source: MissionSummary["source"] } | null
    >(),
  );
  const missionStatusUpdatesRef = useRef(new Map<string, MissionStatusUpdate>());
  const composerRecoveryByMissionIdRef = useRef(new Map<string, MissionComposerSnapshot>());
  const composerRevisionByMissionIdRef = useRef(new Map<string, string>());
  const missionsPageMountedRef = useRef(true);
  const discardComposerAttachments = useCallback((attachmentIds: readonly string[]): void => {
    const uniqueAttachmentIds = [...new Set(attachmentIds)];
    for (let offset = 0; offset < uniqueAttachmentIds.length; offset += 20) {
      void desktopApi()?.discardMissionAttachmentDrafts({
        attachmentIds: uniqueAttachmentIds.slice(offset, offset + 20),
      });
    }
  }, []);
  const preserveComposerRecovery = useCallback(
    (snapshot: MissionComposerSnapshot, reason: MissionComposerRecoveryWriteReason): void => {
      const latestRevisionId = composerRevisionByMissionIdRef.current.get(snapshot.missionId);
      if (
        reason === "send-failed" &&
        !canStoreFailedMissionComposerRecovery(
          composerRecoveryByMissionIdRef.current,
          latestRevisionId,
          snapshot,
        )
      ) {
        discardComposerAttachments(
          releaseMissionComposerSnapshot(composerRecoveryByMissionIdRef.current, snapshot),
        );
        return;
      }
      if (!missionsPageMountedRef.current) {
        composerRevisionByMissionIdRef.current.set(snapshot.missionId, snapshot.revisionId);
        writeMissionDraft(
          typeof window === "undefined" ? undefined : window.localStorage,
          snapshot.missionId,
          snapshot.draft,
        );
        discardComposerAttachments(snapshot.attachments.map((attachment) => attachment.id));
        return;
      }
      if (
        removedMissionIdsRef.current.has(snapshot.missionId) ||
        missionDetailCacheRef.current.get(snapshot.missionId)?.lifecycleStatus === "completed"
      ) {
        composerRevisionByMissionIdRef.current.delete(snapshot.missionId);
        discardComposerAttachments([
          ...releaseMissionComposerRecovery(
            composerRecoveryByMissionIdRef.current,
            snapshot.missionId,
          ),
          ...snapshot.attachments.map((attachment) => attachment.id),
        ]);
        return;
      }
      composerRevisionByMissionIdRef.current.set(snapshot.missionId, snapshot.revisionId);
      discardComposerAttachments(
        storeMissionComposerRecovery(composerRecoveryByMissionIdRef.current, snapshot),
      );
      writeMissionDraft(
        typeof window === "undefined" ? undefined : window.localStorage,
        snapshot.missionId,
        snapshot.draft,
      );
      if (selectedMissionIdRef.current === snapshot.missionId) {
        setComposerRecoveryRevision((current) => current + 1);
      }
    },
    [discardComposerAttachments],
  );
  const discardComposerSnapshot = useCallback(
    (snapshot: MissionComposerSnapshot): void => {
      discardComposerAttachments(
        releaseMissionComposerSnapshot(composerRecoveryByMissionIdRef.current, snapshot),
      );
    },
    [discardComposerAttachments],
  );
  const consumeComposerRecovery = useCallback((snapshot: MissionComposerSnapshot): void => {
    consumeMissionComposerRecovery(composerRecoveryByMissionIdRef.current, snapshot);
  }, []);
  const discardComposerRecovery = useCallback(
    (missionId: string): void => {
      discardComposerAttachments(
        releaseMissionComposerRecovery(composerRecoveryByMissionIdRef.current, missionId),
      );
    },
    [discardComposerAttachments],
  );
  const rejectComposerRecovery = useCallback(
    (recovery: MissionComposerSnapshot, current: MissionComposerSnapshot): void => {
      composerRevisionByMissionIdRef.current.set(current.missionId, current.revisionId);
      discardComposerAttachments(
        discardMissionComposerRecoverySnapshot(composerRecoveryByMissionIdRef.current, recovery),
      );
      writeMissionDraft(
        typeof window === "undefined" ? undefined : window.localStorage,
        current.missionId,
        current.draft,
      );
    },
    [discardComposerAttachments],
  );
  useEffect(() => {
    missionsPageMountedRef.current = true;
    return () => {
      missionsPageMountedRef.current = false;
      discardComposerAttachments(
        clearMissionComposerRecoveries(composerRecoveryByMissionIdRef.current),
      );
    };
  }, [discardComposerAttachments]);
  const cacheMissionDetail = useCallback((mission: Mission): void => {
    missionDetailCacheRef.current.delete(mission.id);
    missionDetailCacheRef.current.set(mission.id, mission);
    while (missionDetailCacheRef.current.size > 8) {
      const oldest = missionDetailCacheRef.current.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      missionDetailCacheRef.current.delete(oldest);
    }
  }, []);

  const replaceMission = useCallback(
    (updated: Mission, source?: MissionSummary["source"]) => {
      const currentStatus = missionStatusUpdatesRef.current.get(updated.id);
      const projected =
        currentStatus === undefined
          ? updated
          : applyMissionStatusUpdateToMission(updated, currentStatus);
      if (
        projected.execution !== undefined &&
        !["queued", "running", "waiting"].includes(projected.execution.status)
      ) {
        setInitialRunRequest((current) => (current?.missionId === projected.id ? null : current));
      }
      if (projected.lifecycleStatus === "completed") {
        composerRevisionByMissionIdRef.current.delete(projected.id);
        discardComposerRecovery(projected.id);
        removeMissionDrafts(
          typeof window === "undefined" ? undefined : window.localStorage,
          new Set([projected.id]),
        );
      }
      cacheMissionDetail(projected);
      setSelectedMission((current) =>
        current?.id === projected.id && projected.updatedAt >= current.updatedAt
          ? projected
          : current,
      );
      setMissions((current) => {
        const knownSource = current.find((mission) => mission.id === projected.id)?.source;
        return upsertMissionSummary(current, missionToSummary(projected, source ?? knownSource));
      });
    },
    [cacheMissionDetail, discardComposerRecovery],
  );

  const updatePinnedMissionIds = useCallback((update: (current: readonly string[]) => string[]) => {
    setPinnedMissionIds((current) => {
      const next = update(current);
      writePinnedMissionIds(typeof window === "undefined" ? undefined : window.localStorage, next);
      return next;
    });
  }, []);

  const updateUnreadMissionOutputIds = useCallback(
    (update: (current: readonly string[]) => readonly string[]) => {
      setUnreadMissionOutputIds((current) => {
        const next = update(current);
        if (next === current) return current;
        writeUnreadMissionOutputIds(
          typeof window === "undefined" ? undefined : window.localStorage,
          next,
        );
        return next;
      });
    },
    [],
  );

  const markMissionOutputRead = useCallback(
    (missionId: string) => {
      updateUnreadMissionOutputIds((current) => markMissionOutputReadIds(current, missionId));
    },
    [updateUnreadMissionOutputIds],
  );

  const openMission = useCallback(
    async (
      id: string,
      options?: { readonly silent?: boolean; readonly source?: MissionListSource },
    ) => {
      const source = options?.source ?? activeSourceRef.current;
      const cache = missionChatCacheRef.current;
      touchMissionConversationCache(cache, id);
      selectedMissionIdsRef.current = { ...selectedMissionIdsRef.current, [source]: id };
      selectedMissionIdRef.current = id;
      markMissionOutputRead(id);
      setSelectedMissionId(id);
      const cachedMission = missionDetailCacheRef.current.get(id);
      if (cachedMission !== undefined) {
        missionDetailCacheRef.current.delete(id);
        missionDetailCacheRef.current.set(id, cachedMission);
      }
      setSelectedMission((current) => (current?.id === id ? current : (cachedMission ?? null)));
      setLoadingMissionId(id);
      if (!options?.silent) setError(null);
      writeLastOpenedMissionId(typeof window === "undefined" ? undefined : window.localStorage, id);
      const api = desktopApi();
      if (api === undefined) {
        setLoadingMissionId((current) => (current === id ? null : current));
        return;
      }
      const navigationStartedAt = performance.now();
      const navigationId = crypto.randomUUID();
      missionNavigationIdsRef.current.set(id, navigationId);
      api.reportRendererLog({
        level: "info",
        event: "mission.navigation_started",
        message: "Mission navigation started",
        missionId: id,
        navigationId,
      });
      requestAnimationFrame(() => {
        api.reportRendererLog({
          level: "info",
          event: "mission.shell_painted",
          message: "Mission detail shell painted",
          missionId: id,
          navigationId,
          elapsedMs: Math.round((performance.now() - navigationStartedAt) * 100) / 100,
        });
      });
      const existingMissionRequest = missionDetailRequestsRef.current.get(id);
      const missionPromise = existingMissionRequest ?? api.getMission(id);
      if (existingMissionRequest === undefined) {
        missionDetailRequestsRef.current.set(id, missionPromise);
        const clearMissionRequest = () => {
          if (missionDetailRequestsRef.current.get(id) === missionPromise) {
            missionDetailRequestsRef.current.delete(id);
          }
        };
        void missionPromise.then(clearMissionRequest, clearMissionRequest);
      }
      const existingConversationRequest = missionConversationRequestsRef.current.get(id);
      const chatPromise =
        existingConversationRequest ??
        loadMissionConversationProjection(api, id)
          .then(({ page, state, stateUnavailable }) => {
            const cached = cache.get(id);
            const existing = isMissionConversationCacheReady(cached) ? cached : null;
            const loadedPage = conversationFromPage(page, existing);
            const pageSnapshot = mergeLatestChatPage(
              existing,
              stateUnavailable ? markConversationStateUnavailable(loadedPage) : loadedPage,
            );
            const snapshot =
              state === undefined
                ? pageSnapshot
                : (mergeConversationState(pageSnapshot, state) ?? pageSnapshot);
            cache.delete(id);
            cache.set(id, snapshot);
            while (cache.size > 8) {
              const oldest = cache.keys().next().value as string | undefined;
              if (oldest === undefined) break;
              cache.delete(oldest);
            }
            return {
              page,
              state,
              ...(stateUnavailable ? { stateUnavailable: true as const } : {}),
            };
          })
          .catch(() => undefined);
      if (existingConversationRequest === undefined) {
        missionConversationRequestsRef.current.set(id, chatPromise);
        void chatPromise.finally(() => {
          if (missionConversationRequestsRef.current.get(id) === chatPromise) {
            missionConversationRequestsRef.current.delete(id);
          }
        });
      }
      try {
        const loadedMission = await missionPromise;
        const statusUpdate = missionStatusUpdatesRef.current.get(id);
        const mission =
          statusUpdate === undefined
            ? loadedMission
            : applyMissionStatusUpdateToMission(loadedMission, statusUpdate);
        // The detail read can contain a newer terminal execution state than the
        // summary that populated the rail. Keep both projections in sync after
        // navigation so a completed Mission cannot remain visually running.
        replaceMission(mission);
        if (selectedMissionIdRef.current === id) {
          setSelectedMission((current) =>
            current === null || mission.updatedAt >= current.updatedAt ? mission : current,
          );
        }
      } catch (loadError) {
        if (selectedMissionIdRef.current === id && !options?.silent) {
          setError(missionError(loadError));
        }
      } finally {
        void chatPromise;
        setLoadingMissionId((current) => (current === id ? null : current));
      }
    },
    [markMissionOutputRead, missionError, replaceMission],
  );

  useEffect(() => {
    if (!hasResolvedInitialLoad) return;
    props.onMemoryStateChange?.({
      missions,
      selectedMission,
      selectedMissionId,
      activeSource,
      selectedMissionIds: selectedMissionIdsRef.current,
    });
  }, [
    activeSource,
    hasResolvedInitialLoad,
    missions,
    props.onMemoryStateChange,
    selectedMission,
    selectedMissionId,
  ]);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) return;
    return api.subscribeMissionChatUpdates((update) => {
      const accepted = acceptMissionChatUpdate(missionOutputBoundariesRef.current, update);
      if (!accepted.accepted) return;
      missionOutputBoundariesRef.current = accepted.boundaries;
      writeMissionOutputBoundaries(
        typeof window === "undefined" ? undefined : window.localStorage,
        accepted.boundaries,
      );
      const selectedMissionIdAtReceipt = selectedMissionIdRef.current;
      const currentEntries = missionChatCacheRef.current.get(update.missionId)?.entries ?? [];
      updateUnreadMissionOutputIds((current) =>
        recordMissionChatUpdateIds(current, update, selectedMissionIdAtReceipt, currentEntries),
      );
    });
  }, [updateUnreadMissionOutputIds]);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) return;
    return api.subscribeMissionStatusUpdates((update) => {
      const current = missionStatusUpdatesRef.current.get(update.missionId);
      if (current !== undefined && current.revision >= update.revision) return;
      missionStatusUpdatesRef.current.set(update.missionId, update);
      if (
        update.execution !== undefined &&
        !["queued", "running", "waiting"].includes(update.execution.status)
      ) {
        setInitialRunRequest((request) =>
          request?.missionId === update.missionId ? null : request,
        );
      }
      setMissions((missions) =>
        missions.map((mission) =>
          mission.id === update.missionId
            ? applyMissionStatusUpdateToSummary(mission, update)
            : mission,
        ),
      );
      const cachedMission = missionDetailCacheRef.current.get(update.missionId);
      if (cachedMission !== undefined) {
        cacheMissionDetail(applyMissionStatusUpdateToMission(cachedMission, update));
      }
      setSelectedMission((mission) =>
        mission?.id === update.missionId
          ? applyMissionStatusUpdateToMission(mission, update)
          : mission,
      );
    });
  }, [cacheMissionDetail]);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) return;
    return api.subscribeMissionUpdates((update) => {
      if (update.kind === "upsert") {
        if (removedMissionIdsRef.current.has(update.mission.id)) return;
        missionUpdatesDuringRefreshRef.current.set(update.mission.id, {
          mission: update.mission,
          source: update.source,
        });
        replaceMission(update.mission, update.source);
        return;
      }
      discardComposerRecovery(update.missionId);
      removeMissionDrafts(
        typeof window === "undefined" ? undefined : window.localStorage,
        new Set([update.missionId]),
      );
      recordMissionRemoval({
        missionId: update.missionId,
        removedMissionIds: removedMissionIdsRef.current,
        missionDetails: missionDetailCacheRef.current,
        missionUpdates: missionUpdatesDuringRefreshRef.current,
      });
      composerRevisionByMissionIdRef.current.delete(update.missionId);
      const remainingBoundaries = { ...missionOutputBoundariesRef.current };
      delete remainingBoundaries[update.missionId];
      missionOutputBoundariesRef.current = remainingBoundaries;
      writeMissionOutputBoundaries(
        typeof window === "undefined" ? undefined : window.localStorage,
        remainingBoundaries,
      );
      updateUnreadMissionOutputIds((current) =>
        current.includes(update.missionId)
          ? current.filter((missionId) => missionId !== update.missionId)
          : current,
      );
      setMissions((current) => current.filter((mission) => mission.id !== update.missionId));
      if (selectedMissionIdRef.current === update.missionId) {
        selectedMissionIdRef.current = null;
        setSelectedMissionId(null);
        setSelectedMission(null);
      }
    });
  }, [discardComposerRecovery, replaceMission, updateUnreadMissionOutputIds]);

  useEffect(() => {
    if (props.initialMission === undefined) return;
    writeLastOpenedMissionId(
      typeof window === "undefined" ? undefined : window.localStorage,
      props.initialMission.id,
    );
  }, [props.initialMission?.id]);

  useEffect(() => {
    if (
      !props.autoRunInitialMission ||
      props.initialMission === undefined ||
      initialRunStartedRef.current
    ) {
      return;
    }
    initialRunStartedRef.current = true;
    void window.pragmaDesktop
      .runMission(props.initialMission.id)
      .then(replaceMission)
      .catch((runError: unknown) => {
        setInitialRunRequest(null);
        setError(missionError(runError));
      });
  }, [missionError, props.autoRunInitialMission, props.initialMission?.id, replaceMission]);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) return;
    let cancelled = false;
    const refreshFromStore = async () => {
      try {
        missionUpdatesDuringRefreshRef.current.clear();
        const eagerMissionId = selectedMissionIdRef.current;
        const eagerMissionLoad =
          eagerMissionId === null
            ? undefined
            : openMission(eagerMissionId, {
                silent: true,
                source: activeSourceRef.current,
              });
        const storedMissions = await api.listMissions();
        if (cancelled) return;
        const refreshedFromStore = [...missionUpdatesDuringRefreshRef.current.values()].reduce(
          (current, updated) =>
            updated === null
              ? current
              : upsertMissionSummary(current, missionToSummary(updated.mission, updated.source)),
          storedMissions.filter(
            (mission) =>
              !removedMissionIdsRef.current.has(mission.id) &&
              missionUpdatesDuringRefreshRef.current.get(mission.id) !== null,
          ),
        );
        const refreshedMissions = refreshedFromStore.map((mission) => {
          const statusUpdate = missionStatusUpdatesRef.current.get(mission.id);
          return statusUpdate === undefined
            ? mission
            : applyMissionStatusUpdateToSummary(mission, statusUpdate);
        });
        setMissions(refreshedMissions);
        updateUnreadMissionOutputIds((current) => {
          const retained = current.filter((missionId) =>
            refreshedMissions.some((mission) => mission.id === missionId),
          );
          return retained.length === current.length ? current : retained;
        });
        removeMissionDrafts(
          typeof window === "undefined" ? undefined : window.localStorage,
          new Set(
            storedMissions
              .filter((mission) => mission.lifecycleStatus === "completed")
              .map((mission) => mission.id),
          ),
        );
        const selectedId = selectedMissionIdRef.current;
        if (
          selectedId !== null &&
          !refreshedMissions.some((mission) => mission.id === selectedId)
        ) {
          const selectedSource = activeSourceRef.current;
          const selection = await resolveUnlistedMissionSelection({
            id: selectedId,
            getSource: api.getMissionListSource,
            isCurrent: () =>
              !cancelled &&
              selectedMissionIdRef.current === selectedId &&
              activeSourceRef.current === selectedSource,
          });
          if (cancelled) return;
          if (selection === "stale") {
            setHasResolvedInitialLoad(true);
            return;
          }
          if (selection === "detail") {
            await openMission(selectedId, { silent: true });
            setHasResolvedInitialLoad(true);
            return;
          }
          if (selection === "deleted") {
            discardComposerRecovery(selectedId);
            removeMissionDrafts(
              typeof window === "undefined" ? undefined : window.localStorage,
              new Set([selectedId]),
            );
            recordMissionRemoval({
              missionId: selectedId,
              removedMissionIds: removedMissionIdsRef.current,
              missionDetails: missionDetailCacheRef.current,
              missionUpdates: missionUpdatesDuringRefreshRef.current,
            });
            composerRevisionByMissionIdRef.current.delete(selectedId);
          }
        }
        if (selectedId !== null) {
          const selectedSummary = refreshedMissions.find((mission) => mission.id === selectedId);
          const selectedSource =
            selectedSummary === undefined
              ? undefined
              : missionListSourceForSummary(selectedSummary);
          if (selectedSource !== undefined && props.initialMission?.id === selectedId) {
            activeSourceRef.current = selectedSource;
            setActiveSource(selectedSource);
            selectedMissionIdsRef.current[selectedSource] = selectedId;
          }
        }
        const sourceMissions = refreshedMissions.filter(
          (mission) => missionListSourceForSummary(mission) === activeSourceRef.current,
        );
        let missionId = selectedMissionIdsRef.current[activeSourceRef.current] ?? null;
        if (missionId !== null && !sourceMissions.some((mission) => mission.id === missionId)) {
          selectedMissionIdRef.current = null;
          setSelectedMissionId(null);
          setSelectedMission(null);
          missionId = null;
        }
        if (missionId === null) {
          const lastOpenedId = readLastOpenedMissionId(
            typeof window === "undefined" ? undefined : window.localStorage,
          );
          missionId = selectPreferredMissionId(sourceMissions, lastOpenedId);
        }
        if (missionId !== null) {
          if (missionId === eagerMissionId && eagerMissionLoad !== undefined) {
            await eagerMissionLoad;
          } else {
            await openMission(missionId, {
              silent: hadInitialMemoryStateRef.current,
              source: activeSourceRef.current,
            });
          }
        } else {
          writeLastOpenedMissionId(
            typeof window === "undefined" ? undefined : window.localStorage,
            null,
          );
        }
        if (!cancelled) setHasResolvedInitialLoad(true);
      } catch (loadError) {
        if (!cancelled && !hadInitialMemoryStateRef.current) {
          setHasResolvedInitialLoad(true);
          setError(missionError(loadError));
        }
      }
    };
    void refreshFromStore();
    return () => {
      cancelled = true;
    };
  }, [
    discardComposerRecovery,
    openMission,
    updateUnreadMissionOutputIds,
    props.initialMission?.id,
  ]);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) return;
    const teamMissions = teamMissionsForMentionCandidates(missions);
    let cancelled = false;
    void Promise.all(
      teamMissions.map(async (mission) => {
        try {
          return [mission.id, (await api.getMissionMentionCandidates(mission.id)).members] as const;
        } catch {
          return [mission.id, []] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setMentionCandidatesByMissionId(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [missions]);

  const presentedMissions = useMemo(
    () =>
      missions.map((mission) => ({
        ...mission,
        title: formatMissionListTitle(
          mission.title,
          mentionCandidatesByMissionId[mission.id] ?? [],
          t("mentionUnavailable", { ns: "missions" }),
        ),
      })),
    [mentionCandidatesByMissionId, missions, t],
  );

  const visibleMissions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const sourceMissions = presentedMissions.filter(
      (mission) => missionListSourceForSummary(mission) === activeSource,
    );
    if (query === "") return sourceMissions;
    return sourceMissions.filter((mission) =>
      [mission.title, mission.workspace.basename, mission.executor.name].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    );
  }, [activeSource, presentedMissions, search]);

  const changeSource = useCallback(
    (nextSource: MissionListSource) => {
      if (nextSource === activeSourceRef.current) return;
      activeSourceRef.current = nextSource;
      setActiveSource(nextSource);
      setError(null);
      const sourceMissions = missions.filter(
        (mission) => missionListSourceForSummary(mission) === nextSource,
      );
      const rememberedId = selectedMissionIdsRef.current[nextSource];
      const missionId =
        rememberedId !== undefined && sourceMissions.some((mission) => mission.id === rememberedId)
          ? rememberedId
          : sourceMissions[0]?.id;
      if (missionId === undefined) {
        selectedMissionIdRef.current = null;
        setSelectedMissionId(null);
        setSelectedMission(null);
        return;
      }
      void openMission(missionId, { source: nextSource });
    },
    [missions, openMission],
  );
  if (!hasResolvedInitialLoad) {
    return <MissionsPageSkeleton label={t("loading", { ns: "missions" })} railWidth={railWidth} />;
  }
  return (
    <section
      className="missions-page"
      style={{ "--sidebar-width": `${railWidth}px` } as CSSProperties}
    >
      <MissionRail
        missions={visibleMissions}
        source={activeSource}
        search={search}
        pinnedMissionIds={pinnedMissionIds}
        unreadMissionOutputIds={unreadMissionOutputIds}
        selectedMissionId={selectedMissionId}
        onSearch={setSearch}
        onSourceChange={changeSource}
        onCreate={props.onCreate}
        onOpen={(summary) => openMission(summary.id, { source: activeSource })}
        onTogglePin={(summary) =>
          updatePinnedMissionIds((current) => togglePinnedMissionId(current, summary.id))
        }
        onMarkComplete={async (summary) => {
          const api = desktopApi();
          if (api === undefined) return;
          try {
            replaceMission(await api.markMissionComplete(summary.id));
            updatePinnedMissionIds((current) =>
              current.filter((missionId) => missionId !== summary.id),
            );
            setError(null);
          } catch (actionError) {
            setError(missionError(actionError));
          }
        }}
        onDelete={setDeleteCandidate}
      />
      <SidebarResizeHandle
        label={t("navigation.resize", { ns: "common" })}
        width={railWidth}
        preference={SIDEBAR_WIDTH_PREFERENCES.missions}
        onResize={setRailWidth}
      />

      <div className="mission-main">
        {selectedMission !== null ? (
          <MissionDetailFragment
            key={selectedMission.id}
            mission={selectedMission}
            navigationId={missionNavigationIdsRef.current.get(selectedMission.id)}
            initialComposerDraft={props.initialComposerDraft}
            initialComposerRevisionId={composerRevisionByMissionIdRef.current.get(
              selectedMission.id,
            )}
            initialComposerRecovery={composerRecoveryByMissionIdRef.current.get(selectedMission.id)}
            onComposerRecovery={preserveComposerRecovery}
            onComposerRecoverySuperseded={discardComposerSnapshot}
            onComposerRecoveryConsumed={consumeComposerRecovery}
            onComposerRecoveryConflict={rejectComposerRecovery}
            memoryEnabled={props.memoryEnabled}
            chatCache={missionChatCacheRef.current}
            teamIdentityCache={missionTeamIdentityCacheRef.current}
            prefetchedConversation={missionConversationRequestsRef.current.get(selectedMission.id)}
            initialThinkingRequestId={
              initialRunRequest?.missionId === selectedMission.id
                ? initialRunRequest.requestId
                : undefined
            }
            onConfigureModels={props.onConfigureModels}
            onOpenKnowledgeBases={props.onOpenKnowledgeBases}
            onOpenKnowledgeRevision={props.onOpenKnowledgeRevision}
            onEditExpert={props.onEditExpert}
            error={error}
            onDismissError={() => setError(null)}
            onSend={async (content, requestId, attachments, mode) => {
              const api = desktopApi();
              if (api === undefined) return;
              try {
                await api.sendMissionMessage({
                  id: selectedMission.id,
                  content,
                  requestId,
                  attachments: [...attachments],
                  mode,
                });
                setError(null);
              } catch (sendError) {
                setError(missionError(sendError));
                throw sendError;
              }
            }}
            onRun={async () => {
              const api = desktopApi();
              if (api === undefined) return;
              try {
                const executionActive =
                  selectedMission.execution !== undefined &&
                  ["queued", "running", "waiting"].includes(selectedMission.execution.status);
                replaceMission(
                  await (executionActive
                    ? api.recoverMission({
                        id: selectedMission.id,
                        requestId: crypto.randomUUID(),
                        expectedExecutionId: selectedMission.execution!.id,
                      })
                    : api.runMission(selectedMission.id)),
                );
                setError(null);
              } catch (runError) {
                setError(missionError(runError));
                throw runError;
              }
            }}
            onInterrupt={async () => {
              const api = desktopApi();
              if (api === undefined) return;
              try {
                if (selectedMission.execution === undefined) return;
                replaceMission(
                  await api.interruptMission({
                    id: selectedMission.id,
                    requestId: crypto.randomUUID(),
                    expectedExecutionId: selectedMission.execution.id,
                  }),
                );
                setError(null);
              } catch (interruptError) {
                setError(missionError(interruptError));
              }
            }}
            onForceInterrupt={async () => {
              const api = desktopApi();
              if (api === undefined) return;
              try {
                if (selectedMission.execution === undefined) return;
                replaceMission(
                  await api.forceInterruptMission({
                    id: selectedMission.id,
                    requestId: crypto.randomUUID(),
                    expectedExecutionId: selectedMission.execution.id,
                  }),
                );
                setError(null);
              } catch (interruptError) {
                setError(missionError(interruptError));
                throw interruptError;
              }
            }}
            onForceRemove={() =>
              setDeleteCandidate(
                missions.find((candidate) => candidate.id === selectedMission.id) ??
                  missionToSummary(selectedMission),
              )
            }
            onHumanResponded={async () => {
              const api = desktopApi();
              if (api !== undefined) replaceMission(await api.getMission(selectedMission.id));
            }}
            onOptionsChange={async (options) => {
              const api = desktopApi();
              if (api === undefined) return;
              try {
                replaceMission(
                  await api.updateMissionOptions({
                    id: selectedMission.id,
                    toolPermissionMode: options.toolPermissionMode,
                    modelOverride: options.modelOverride ?? null,
                  }),
                );
                setError(null);
              } catch (optionsError) {
                setError(missionError(optionsError));
                throw optionsError;
              }
            }}
            onContextStoresChange={async (contextMounts) => {
              const api = desktopApi();
              if (api === undefined) return;
              try {
                replaceMission(
                  await api.updateMissionContextMounts({
                    id: selectedMission.id,
                    contextMounts: [...contextMounts],
                  }),
                );
                setError(null);
              } catch (contextStoresError) {
                setError(missionError(contextStoresError));
                throw contextStoresError;
              }
            }}
            onLifecycleChange={async () => {
              const api = desktopApi();
              if (api === undefined) return;
              try {
                const updated =
                  selectedMission.lifecycleStatus === "active"
                    ? await api.markMissionComplete(selectedMission.id)
                    : await api.reopenMission(selectedMission.id);
                replaceMission(updated);
                if (selectedMission.lifecycleStatus === "active") {
                  updatePinnedMissionIds((current) =>
                    current.filter((missionId) => missionId !== selectedMission.id),
                  );
                }
                setError(null);
              } catch (actionError) {
                setError(missionError(actionError));
              }
            }}
            onBranchCreated={(mission) => {
              replaceMission(mission, { type: "task" });
              selectedMissionIdsRef.current = {
                ...selectedMissionIdsRef.current,
                task: mission.id,
              };
              selectedMissionIdRef.current = mission.id;
              setActiveSource("task");
              activeSourceRef.current = "task";
              setSelectedMissionId(mission.id);
              setSelectedMission(mission);
              cacheMissionDetail(mission);
              writeLastOpenedMissionId(window.localStorage, mission.id);
              setError(null);
            }}
          />
        ) : loadingMissionId !== null && loadingMissionId === selectedMissionId ? (
          <MissionDetailSkeleton
            label={t("loading", { ns: "missions" })}
            title={presentedMissions.find((mission) => mission.id === selectedMissionId)?.title}
          />
        ) : (
          <div className="mission-empty-detail">
            <h1>{t("empty", { ns: "missions" })}</h1>
            <p>{t("selectAnother", { ns: "missions" })}</p>
          </div>
        )}
        {error && selectedMission === null ? (
          <MissionErrorBanner error={error} onDismiss={() => setError(null)} />
        ) : null}
      </div>
      {deleteCandidate !== null ? (
        <ConfirmationDialog
          title={t("deleteTitle", { ns: "missions" })}
          description={t("deleteDescription", {
            ns: "missions",
            title: deleteCandidate.title,
          })}
          cancelLabel={t("actions.cancel", { ns: "common" })}
          confirmLabel={t("deleteMission", { ns: "missions" })}
          busyLabel={t("deleting", { ns: "missions" })}
          busy={deleting}
          tone="danger"
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={() => {
            const api = desktopApi();
            if (api === undefined) return;
            setDeleting(true);
            void withMissionUiWatchdog(api.deleteMission(deleteCandidate.id))
              .then(async () => {
                const deletedMissionId = deleteCandidate.id;
                recordMissionRemoval({
                  missionId: deletedMissionId,
                  removedMissionIds: removedMissionIdsRef.current,
                  missionDetails: missionDetailCacheRef.current,
                  missionUpdates: missionUpdatesDuringRefreshRef.current,
                });
                composerRevisionByMissionIdRef.current.delete(deletedMissionId);
                discardComposerRecovery(deletedMissionId);
                removeMissionDrafts(window.localStorage, new Set([deletedMissionId]));
                const storedMissions = await api.listMissions();
                setMissions(storedMissions);
                if (selectedMissionId === deletedMissionId) {
                  selectedMissionIdRef.current = null;
                  setSelectedMissionId(null);
                  setSelectedMission(null);
                  const fallback = storedMissions.find(
                    (mission) => missionListSourceForSummary(mission) === activeSourceRef.current,
                  );
                  if (fallback === undefined) {
                    writeLastOpenedMissionId(window.localStorage, null);
                  } else {
                    openMission(fallback.id, { source: activeSourceRef.current });
                  }
                }
                setDeleteCandidate(null);
                setError(null);
              })
              .catch((deleteError: unknown) => {
                setError(missionError(deleteError));
                setDeleteCandidate(null);
              })
              .finally(() => setDeleting(false));
          }}
        />
      ) : null}
    </section>
  );
}
