import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";

import {
  ArrowUp,
  ArrowCounterClockwise,
  CaretDown,
  CaretLeft,
  CaretRight,
  CheckCircle,
  Database,
  File,
  Folder,
  FolderOpen,
  GitBranch,
  MagnifyingGlass,
  Plus,
  Play,
  PushPin,
  ArrowBendUpLeft,
  Stop,
  StopCircle,
  SpinnerGap,
  TerminalWindow,
  Trash,
  User,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import type {
  ExpertPromptAttachment,
  ExpertPromptAttachmentKind,
  HumanInteractionResponse,
} from "@pragma/shared";

import { ConfirmationDialog } from "../../components/Dialog.tsx";
import { ProfiledExpertAvatar } from "../../components/ProfiledExpertAvatar.tsx";
import {
  type Mission,
  type ContextStore,
  type MissionContextMount,
  type MissionChatEntry,
  type MissionChatSnapshot,
  type MissionContextWindowState,
  type MissionHumanInteraction,
  type MissionSummary,
  type MissionWorkRecord,
  type DesktopMissionMemoryActivity,
  type DesktopToolPermissionMode,
  type MissionModelOverride,
  type PragmaDesktopAPI,
  latestMissionBranchableReply,
} from "../../../../shared/contracts/index.ts";
import { localizedMissionError } from "../../lib/mission-errors.ts";
import { i18n } from "../../i18n/index.ts";
import { shouldSubmitComposerOnEnter } from "../../lib/composer-keyboard.ts";
import { formatMissionDateTime, formatMissionTime } from "../../lib/mission-time.ts";
import {
  createMissionSendAttempt,
  useMissionCommandDelivery,
  type LocalMissionUserMessage,
} from "./mission-command-delivery.ts";
import {
  groupMissionConversationEntries,
  hideInterruptedExecutionFallbackEntries,
  hidePreparingQueuedChatEntries,
  mergeLatestChatPage,
  missionTurnFinalReplyIds,
  readyPendingQueuedRequestIds,
  shouldClearMissionThinkingPlaceholder,
  shouldShowMissionThinkingPlaceholder,
} from "./mission-conversation-model.ts";
import { useMissionClientOperation } from "./mission-client-operation.ts";
import { useMissionComposerState } from "./use-mission-composer-state.ts";
import { useMissionWork } from "./use-mission-work.ts";
import { useMissionHumanInteraction } from "./use-mission-human-interaction.ts";
import { useMissionOptions } from "./use-mission-options.ts";
import { useMissionContextOperations } from "./use-mission-context-operations.ts";
import { useMissionConversation } from "./use-mission-conversation.ts";
export {
  copyMissionReply,
  MissionChatEntryView,
  MissionContextOperationEntry,
  MissionThinkingEntry,
  MissionToolCallBlock,
} from "./mission-chat-presentation.tsx";
import {
  LocalMissionUserMessageView,
  MissionChatEntryView,
  MissionContextOperationEntry,
  MissionThinkingPlaceholder,
  MissionToolCallBlock,
} from "./mission-chat-presentation.tsx";
export {
  MISSION_CHAT_PAGE_SIZE,
  MISSION_WORK_CONVERSATION_PAGE_SIZE,
  MISSION_WORK_RECORD_PAGE_SIZE,
} from "./mission-view-constants.ts";
import { MISSION_CHAT_PAGE_SIZE, MISSION_WORK_RECORD_PAGE_SIZE } from "./mission-view-constants.ts";
import { runtimeDisplayName } from "../../lib/runtime-display.ts";
import { formatTokens } from "../../lib/usage-format.ts";
import { ToolPermissionSelect } from "../../components/ToolPermissionSelect.tsx";
import {
  MissionAttachmentList,
  MissionAttachmentPicker,
} from "../../components/MissionAttachments.tsx";
import { MissionModelOverrideControls } from "../../components/MissionModelOverrideControls.tsx";
import { MemoryStoreBrowser } from "../../components/MemoryStoreBrowser.tsx";
import {
  ContextStoreBrowser,
  type ContextStoreBrowserSource,
} from "../../components/ContextStoreBrowser.tsx";
import { SidebarResizeHandle } from "../../components/SidebarResizeHandle.tsx";
import { ContextStorePickerDialog } from "../../components/ContextStorePickerDialog.tsx";
import {
  SIDEBAR_WIDTH_PREFERENCES,
  usePersistentSidebarWidth,
} from "../../lib/sidebar-width-preference.ts";
import { pruneMissionDrafts, writeMissionDraft } from "../../lib/mission-draft.ts";
import {
  clipboardImageFile,
  missionImageSupport,
  stageClipboardImage,
} from "../../lib/mission-attachments.ts";
import {
  readPinnedMissionIds,
  readLastOpenedMissionId,
  selectPreferredMissionId,
  togglePinnedMissionId,
  writePinnedMissionIds,
  writeLastOpenedMissionId,
} from "../../lib/mission-preference.ts";

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

export function resolveMissionsPageInitialState(input: {
  readonly initialMission?: Mission | undefined;
  readonly memoryState?: MissionsPageMemoryState | undefined;
}): MissionsPageInitialState {
  const cachedMissions = input.memoryState?.missions ?? [];
  if (input.initialMission !== undefined) {
    const source = missionListSourceForMission(input.initialMission);
    return {
      missions: upsertMissionSummary(cachedMissions, missionToSummary(input.initialMission)),
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
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<MissionSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
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
  const missionChatCacheRef = useRef(new Map<string, MissionChatSnapshot>());
  const initialRunStartedRef = useRef(false);
  const hadInitialMemoryStateRef = useRef(props.initialMemoryState !== undefined);
  const removedMissionIdsRef = useRef(new Set<string>());
  const missionUpdatesDuringRefreshRef = useRef(
    new Map<
      string,
      { readonly mission: Mission; readonly source: MissionSummary["source"] } | null
    >(),
  );

  const replaceMission = useCallback((updated: Mission, source?: MissionSummary["source"]) => {
    if (
      updated.execution !== undefined &&
      !["queued", "running", "waiting"].includes(updated.execution.status)
    ) {
      setInitialRunRequest((current) => (current?.missionId === updated.id ? null : current));
    }
    if (updated.lifecycleStatus === "completed") {
      writeMissionDraft(
        typeof window === "undefined" ? undefined : window.localStorage,
        updated.id,
        "",
      );
    }
    setSelectedMission((current) =>
      current?.id === updated.id && updated.updatedAt >= current.updatedAt ? updated : current,
    );
    setMissions((current) => {
      const knownSource = current.find((mission) => mission.id === updated.id)?.source;
      return upsertMissionSummary(current, missionToSummary(updated, source ?? knownSource));
    });
  }, []);

  const updatePinnedMissionIds = useCallback((update: (current: readonly string[]) => string[]) => {
    setPinnedMissionIds((current) => {
      const next = update(current);
      writePinnedMissionIds(typeof window === "undefined" ? undefined : window.localStorage, next);
      return next;
    });
  }, []);

  const openMission = useCallback(
    async (
      id: string,
      options?: { readonly silent?: boolean; readonly source?: MissionListSource },
    ) => {
      const source = options?.source ?? activeSourceRef.current;
      selectedMissionIdsRef.current = { ...selectedMissionIdsRef.current, [source]: id };
      selectedMissionIdRef.current = id;
      setSelectedMissionId(id);
      setSelectedMission((current) => (current?.id === id ? current : null));
      setLoadingMissionId(id);
      if (!options?.silent) setError(null);
      writeLastOpenedMissionId(typeof window === "undefined" ? undefined : window.localStorage, id);
      const api = desktopApi();
      if (api === undefined) {
        setLoadingMissionId((current) => (current === id ? null : current));
        return;
      }
      try {
        const mission = await api.getMission(id);
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
        setLoadingMissionId((current) => (current === id ? null : current));
      }
    },
    [missionError],
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
      writeMissionDraft(
        typeof window === "undefined" ? undefined : window.localStorage,
        update.missionId,
        "",
      );
      missionUpdatesDuringRefreshRef.current.set(update.missionId, null);
      removedMissionIdsRef.current.add(update.missionId);
      setMissions((current) => current.filter((mission) => mission.id !== update.missionId));
      if (selectedMissionIdRef.current === update.missionId) {
        selectedMissionIdRef.current = null;
        setSelectedMissionId(null);
        setSelectedMission(null);
      }
    });
  }, [replaceMission]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

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
        const storedMissions = await api.listMissions();
        if (cancelled) return;
        const refreshedMissions = [...missionUpdatesDuringRefreshRef.current.values()].reduce(
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
        setMissions(refreshedMissions);
        pruneMissionDrafts(
          typeof window === "undefined" ? undefined : window.localStorage,
          new Set(
            storedMissions
              .filter((mission) => mission.lifecycleStatus === "active")
              .map((mission) => mission.id),
          ),
        );
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
          await openMission(missionId, {
            silent: hadInitialMemoryStateRef.current,
            source: activeSourceRef.current,
          });
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
  }, [openMission]);

  const visibleMissions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const sourceMissions = missions.filter(
      (mission) => missionListSourceForSummary(mission) === activeSource,
    );
    if (query === "") return sourceMissions;
    return sourceMissions.filter((mission) =>
      [mission.title, mission.workspace.basename, mission.executor.name].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    );
  }, [activeSource, missions, search]);

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
        now={now}
        pinnedMissionIds={pinnedMissionIds}
        selectedMissionId={selectedMissionId}
        onSearch={setSearch}
        onSourceChange={changeSource}
        onCreate={props.onCreate}
        onOpen={(summary) =>
          openMission(summary.id, { source: missionListSourceForSummary(summary) })
        }
        onTogglePin={(summary) =>
          updatePinnedMissionIds((current) => togglePinnedMissionId(current, summary.id))
        }
        onMarkComplete={async (summary) => {
          const api = desktopApi();
          if (api === undefined) return;
          try {
            replaceMission(await api.markMissionComplete(summary.id));
            writeMissionDraft(
              typeof window === "undefined" ? undefined : window.localStorage,
              summary.id,
              "",
            );
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
            initialComposerDraft={props.initialComposerDraft}
            memoryEnabled={props.memoryEnabled}
            chatCache={missionChatCacheRef.current}
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
                replaceMission(await api.runMission(selectedMission.id));
                setError(null);
              } catch (runError) {
                setError(missionError(runError));
              }
            }}
            onInterrupt={async () => {
              const api = desktopApi();
              if (api === undefined) return;
              try {
                replaceMission(await api.interruptMission(selectedMission.id));
                setError(null);
              } catch (interruptError) {
                setError(missionError(interruptError));
              }
            }}
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
                  writeMissionDraft(
                    typeof window === "undefined" ? undefined : window.localStorage,
                    selectedMission.id,
                    "",
                  );
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
              writeLastOpenedMissionId(window.localStorage, mission.id);
              setError(null);
            }}
          />
        ) : loadingMissionId !== null && loadingMissionId === selectedMissionId ? (
          <MissionDetailSkeleton label={t("loading", { ns: "missions" })} />
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
            void api
              .deleteMission(deleteCandidate.id)
              .then(async () => {
                const storedMissions = await api.listMissions();
                writeMissionDraft(window.localStorage, deleteCandidate.id, "");
                setMissions(storedMissions);
                if (selectedMissionId === deleteCandidate.id) {
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

export function MissionsPageSkeleton(props: {
  readonly label: string;
  readonly railWidth: number;
}) {
  return (
    <section
      className="missions-page mission-page-skeleton"
      style={{ "--sidebar-width": `${props.railWidth}px` } as CSSProperties}
      role="status"
      aria-label={props.label}
      aria-live="polite"
    >
      <aside className="mission-skeleton-rail" aria-hidden="true">
        <span className="mission-skeleton-block mission-skeleton-title" />
        <span className="mission-skeleton-block mission-skeleton-button" />
        <span className="mission-skeleton-block mission-skeleton-source-tabs" />
        <span className="mission-skeleton-block mission-skeleton-search" />
        {[0, 1].map((group) => (
          <div className="mission-skeleton-group" key={group}>
            <span className="mission-skeleton-block mission-skeleton-label" />
            <span className="mission-skeleton-block mission-skeleton-row" />
            <span className="mission-skeleton-block mission-skeleton-row is-short" />
          </div>
        ))}
      </aside>
      <div className="mission-skeleton-main" aria-hidden="true">
        <header>
          <span className="mission-skeleton-block mission-skeleton-heading" />
          <span className="mission-skeleton-block mission-skeleton-meta" />
        </header>
        <div className="mission-skeleton-tabs">
          <span className="mission-skeleton-block" />
          <span className="mission-skeleton-block" />
          <span className="mission-skeleton-block" />
        </div>
        <div className="mission-skeleton-body">
          <span className="mission-skeleton-block mission-skeleton-message" />
          <span className="mission-skeleton-block mission-skeleton-message is-wide" />
          <span className="mission-skeleton-block mission-skeleton-message is-short" />
        </div>
        <span className="mission-skeleton-block mission-skeleton-composer" />
      </div>
    </section>
  );
}

export function MissionDetailSkeleton(props: { readonly label: string }) {
  return (
    <div
      className="mission-detail-loading"
      role="status"
      aria-label={props.label}
      aria-live="polite"
    >
      <div className="mission-detail-loading-content" aria-hidden="true">
        <header>
          <span className="mission-skeleton-block mission-skeleton-meta" />
        </header>
        <div className="mission-skeleton-tabs">
          <span className="mission-skeleton-block" />
          <span className="mission-skeleton-block" />
          <span className="mission-skeleton-block" />
        </div>
        <div className="mission-skeleton-body">
          <span className="mission-skeleton-block mission-skeleton-message" />
          <span className="mission-skeleton-block mission-skeleton-message is-wide" />
          <span className="mission-skeleton-block mission-skeleton-message is-short" />
        </div>
        <span className="mission-skeleton-block mission-skeleton-composer" />
      </div>
    </div>
  );
}

export function MissionChatSkeleton(props: { readonly label: string }) {
  return (
    <div
      className="mission-chat-initial-loading"
      role="status"
      aria-label={props.label}
      aria-live="polite"
    >
      <div className="mission-chat-initial-loading-content" aria-hidden="true">
        <div className="mission-chat-skeleton-message is-assistant">
          <span className="mission-skeleton-block mission-chat-skeleton-avatar" />
          <div className="mission-chat-skeleton-copy">
            <span className="mission-skeleton-block is-heading" />
            <span className="mission-skeleton-block" />
            <span className="mission-skeleton-block is-short" />
          </div>
        </div>
        <div className="mission-chat-skeleton-message is-user">
          <div className="mission-chat-skeleton-copy">
            <span className="mission-skeleton-block" />
            <span className="mission-skeleton-block is-short" />
          </div>
        </div>
        <div className="mission-chat-skeleton-message is-assistant is-wide">
          <span className="mission-skeleton-block mission-chat-skeleton-avatar" />
          <div className="mission-chat-skeleton-copy">
            <span className="mission-skeleton-block is-heading" />
            <span className="mission-skeleton-block" />
            <span className="mission-skeleton-block" />
            <span className="mission-skeleton-block is-short" />
          </div>
        </div>
      </div>
    </div>
  );
}

function MissionRail(props: {
  readonly missions: readonly MissionSummary[];
  readonly source: MissionListSource;
  readonly search: string;
  readonly now: number;
  readonly pinnedMissionIds: readonly string[];
  readonly selectedMissionId: string | null;
  readonly onSearch: (value: string) => void;
  readonly onSourceChange: (source: MissionListSource) => void;
  readonly onCreate: () => void;
  readonly onOpen: (mission: MissionSummary) => void;
  readonly onTogglePin: (mission: MissionSummary) => void;
  readonly onMarkComplete: (mission: MissionSummary) => void | Promise<void>;
  readonly onDelete: (mission: MissionSummary) => void;
}) {
  const { t } = useTranslation("missions");
  const [searchCollapsed, setSearchCollapsed] = useState(false);
  const [visibleLimits, setVisibleLimits] = useState<MissionRailVisibleLimits>(
    MISSION_RAIL_INITIAL_VISIBLE_LIMITS,
  );
  const scrollAnchorRef = useRef(0);
  const searchRef = useRef<HTMLLabelElement>(null);
  const searchTransitionLockedRef = useRef(false);
  const searchTransitionTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pinnedMissionIdSet = useMemo(
    () => new Set(props.pinnedMissionIds),
    [props.pinnedMissionIds],
  );
  const missionGroups = useMemo(
    () =>
      resolveMissionRailGroups({
        missions: props.missions,
        pinnedMissionIds: props.pinnedMissionIds,
        visibleLimits,
      }),
    [props.missions, props.pinnedMissionIds, visibleLimits],
  );

  useEffect(() => {
    setVisibleLimits(MISSION_RAIL_INITIAL_VISIBLE_LIMITS);
  }, [props.search]);

  useEffect(
    () => () => {
      if (searchTransitionTimeoutRef.current !== undefined) {
        clearTimeout(searchTransitionTimeoutRef.current);
      }
    },
    [],
  );

  const lockSearchTransition = useCallback(() => {
    if (searchTransitionTimeoutRef.current !== undefined) {
      clearTimeout(searchTransitionTimeoutRef.current);
    }
    searchTransitionLockedRef.current = true;
    searchTransitionTimeoutRef.current = setTimeout(() => {
      searchTransitionLockedRef.current = false;
      searchTransitionTimeoutRef.current = undefined;
    }, MISSION_SEARCH_TRANSITION_LOCK_MS);
  }, []);

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLElement>) => {
      const scrollTop = event.currentTarget.scrollTop;
      const previousScrollTop = scrollAnchorRef.current;
      const nextSearchCollapsed = resolveMissionSearchCollapsed({
        collapsed: searchCollapsed,
        previousScrollTop,
        scrollTop,
        transitionLocked: searchTransitionLockedRef.current,
      });

      if (
        searchTransitionLockedRef.current ||
        scrollTop <= MISSION_SEARCH_TOP_REVEAL_OFFSET ||
        Math.abs(scrollTop - previousScrollTop) >= MISSION_SEARCH_SCROLL_THRESHOLD
      ) {
        scrollAnchorRef.current = scrollTop;
      }

      if (
        nextSearchCollapsed &&
        searchRef.current?.contains(event.currentTarget.ownerDocument.activeElement)
      ) {
        return;
      }
      if (nextSearchCollapsed !== searchCollapsed) {
        lockSearchTransition();
        setSearchCollapsed(nextSearchCollapsed);
      }
    },
    [lockSearchTransition, searchCollapsed],
  );

  return (
    <aside className="mission-rail" onScroll={handleScroll}>
      <div
        className={
          searchCollapsed ? "mission-rail-sticky is-search-collapsed" : "mission-rail-sticky"
        }
      >
        <button className="mission-new-button" type="button" onClick={props.onCreate}>
          <Plus size={18} aria-hidden="true" />
          {t("newMission")}
        </button>
        <div
          className={`mission-source-tabs is-${props.source}`}
          role="tablist"
          aria-label={t("missionSources")}
        >
          <span className="mission-source-indicator" aria-hidden="true" />
          <button
            type="button"
            role="tab"
            aria-selected={props.source === "task"}
            className={props.source === "task" ? "is-active" : undefined}
            onClick={() => props.onSourceChange("task")}
          >
            {t("sourceTabs.task")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={props.source === "automation"}
            className={props.source === "automation" ? "is-active" : undefined}
            onClick={() => props.onSourceChange("automation")}
          >
            {t("sourceTabs.automation")}
          </button>
        </div>
        <div className="mission-search-slot" aria-hidden={searchCollapsed ? "true" : undefined}>
          <label className="mission-search" ref={searchRef}>
            <MagnifyingGlass size={18} aria-hidden="true" />
            <span className="sr-only">{t("search")}</span>
            <input
              value={props.search}
              onChange={(event) => props.onSearch(event.target.value)}
              placeholder={t("search")}
              tabIndex={searchCollapsed ? -1 : undefined}
            />
          </label>
        </div>
      </div>
      {missionGroups.waitingInput.visibleMissions.length > 0 ||
      missionGroups.waitingInput.hiddenCount > 0 ? (
        <MissionRailGroup
          label={t("waitingInput")}
          emptyLabel={t("noWaitingInput")}
          missions={missionGroups.waitingInput.visibleMissions}
          hiddenCount={missionGroups.waitingInput.hiddenCount}
          now={props.now}
          pinnedMissionIds={pinnedMissionIdSet}
          selectedMissionId={props.selectedMissionId}
          onOpen={props.onOpen}
          onTogglePin={props.onTogglePin}
          onMarkComplete={props.onMarkComplete}
          onDelete={props.onDelete}
          onLoadMore={() => setVisibleLimits(increaseMissionRailVisibleLimit("waitingInput"))}
        />
      ) : null}
      <MissionRailGroup
        label={t("active")}
        emptyLabel={t(props.source === "automation" ? "noActiveAutomations" : "noActive")}
        missions={missionGroups.active.visibleMissions}
        hiddenCount={missionGroups.active.hiddenCount}
        now={props.now}
        pinnedMissionIds={pinnedMissionIdSet}
        selectedMissionId={props.selectedMissionId}
        onOpen={props.onOpen}
        onTogglePin={props.onTogglePin}
        onMarkComplete={props.onMarkComplete}
        onDelete={props.onDelete}
        onLoadMore={() => setVisibleLimits(increaseMissionRailVisibleLimit("active"))}
      />
      <MissionRailGroup
        label={t("completed")}
        emptyLabel={t(props.source === "automation" ? "noCompletedAutomations" : "noCompleted")}
        variant="completed"
        missions={missionGroups.completed.visibleMissions}
        hiddenCount={missionGroups.completed.hiddenCount}
        now={props.now}
        pinnedMissionIds={pinnedMissionIdSet}
        selectedMissionId={props.selectedMissionId}
        onOpen={props.onOpen}
        onTogglePin={props.onTogglePin}
        onMarkComplete={props.onMarkComplete}
        onDelete={props.onDelete}
        onLoadMore={() => setVisibleLimits(increaseMissionRailVisibleLimit("completed"))}
      />
    </aside>
  );
}

const MISSION_RAIL_PAGE_SIZE = 10;
const MISSION_RAIL_INITIAL_VISIBLE_LIMITS = {
  waitingInput: 10,
  active: 10,
  completed: 10,
} satisfies MissionRailVisibleLimits;
const MISSION_SEARCH_SCROLL_THRESHOLD = 6;
const MISSION_SEARCH_TOP_REVEAL_OFFSET = 4;
const MISSION_SEARCH_TRANSITION_LOCK_MS = 220;

type MissionRailGroupKey = "waitingInput" | "active" | "completed";

export interface MissionRailVisibleLimits {
  readonly waitingInput: number;
  readonly active: number;
  readonly completed: number;
}

export interface MissionRailResolvedGroup {
  readonly visibleMissions: readonly MissionSummary[];
  readonly hiddenCount: number;
}

export interface MissionRailResolvedGroups {
  readonly waitingInput: MissionRailResolvedGroup;
  readonly active: MissionRailResolvedGroup;
  readonly completed: MissionRailResolvedGroup;
}

export function resolveMissionRailGroups(input: {
  readonly missions: readonly MissionSummary[];
  readonly pinnedMissionIds: readonly string[];
  readonly visibleLimits: MissionRailVisibleLimits;
}): MissionRailResolvedGroups {
  const waitingInput = input.missions
    .filter(isWaitingInputMission)
    .toSorted((left, right) => comparePinnedMissions(left, right, input.pinnedMissionIds));
  const active = input.missions
    .filter((mission) => mission.lifecycleStatus === "active" && !isWaitingInputMission(mission))
    .toSorted((left, right) => comparePinnedMissions(left, right, input.pinnedMissionIds));
  const completed = input.missions.filter((mission) => mission.lifecycleStatus === "completed");

  return {
    waitingInput: resolveMissionRailGroup(waitingInput, input.visibleLimits.waitingInput),
    active: resolveMissionRailGroup(active, input.visibleLimits.active),
    completed: resolveMissionRailGroup(completed, input.visibleLimits.completed),
  };
}

function resolveMissionRailGroup(
  missions: readonly MissionSummary[],
  visibleLimit: number,
): MissionRailResolvedGroup {
  const boundedLimit = Math.max(0, visibleLimit);
  return {
    visibleMissions: missions.slice(0, boundedLimit),
    hiddenCount: Math.max(0, missions.length - boundedLimit),
  };
}

function increaseMissionRailVisibleLimit(
  group: MissionRailGroupKey,
): (current: MissionRailVisibleLimits) => MissionRailVisibleLimits {
  return (current) => ({
    ...current,
    [group]: current[group] + MISSION_RAIL_PAGE_SIZE,
  });
}

function isWaitingInputMission(mission: MissionSummary): boolean {
  return mission.lifecycleStatus === "active" && mission.execution?.status === "waiting";
}

export function resolveMissionSearchCollapsed(input: {
  readonly collapsed: boolean;
  readonly previousScrollTop: number;
  readonly scrollTop: number;
  readonly transitionLocked?: boolean | undefined;
}): boolean {
  if (input.scrollTop <= MISSION_SEARCH_TOP_REVEAL_OFFSET) return false;
  if (input.transitionLocked === true) return input.collapsed;

  const distance = input.scrollTop - input.previousScrollTop;
  if (Math.abs(distance) < MISSION_SEARCH_SCROLL_THRESHOLD) return input.collapsed;
  return distance > 0;
}

function MissionRailGroup(props: {
  readonly label: string;
  readonly emptyLabel: string;
  readonly variant?: "default" | "completed";
  readonly missions: readonly MissionSummary[];
  readonly hiddenCount: number;
  readonly now: number;
  readonly pinnedMissionIds: ReadonlySet<string>;
  readonly selectedMissionId: string | null;
  readonly onOpen: (mission: MissionSummary) => void;
  readonly onTogglePin: (mission: MissionSummary) => void;
  readonly onMarkComplete: (mission: MissionSummary) => void | Promise<void>;
  readonly onDelete: (mission: MissionSummary) => void;
  readonly onLoadMore: () => void;
}) {
  const completed = props.variant === "completed";

  return (
    <section className={completed ? "mission-rail-group is-completed" : "mission-rail-group"}>
      <h2>{props.label}</h2>
      {props.missions.length === 0 ? (
        <p className="mission-rail-empty">{props.emptyLabel}</p>
      ) : (
        <>
          {props.missions.map((mission) => {
            const executionActive =
              mission.execution !== undefined &&
              ["queued", "running", "waiting"].includes(mission.execution.status);
            const isActiveMission = mission.lifecycleStatus === "active";
            const isPinned = isActiveMission && props.pinnedMissionIds.has(mission.id);
            const showStatusDot = isActiveMission;
            return (
              <div
                className={[
                  "mission-row",
                  mission.id === props.selectedMissionId ? "is-active" : "",
                  isPinned ? "is-pinned" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={mission.id}
              >
                <button
                  className={showStatusDot ? "mission-row-open has-status-dot" : "mission-row-open"}
                  type="button"
                  onClick={() => props.onOpen(mission)}
                >
                  {showStatusDot ? (
                    <span className="mission-status-dot is-active" aria-hidden="true" />
                  ) : null}
                  <span className={completed ? "mission-row-completed-content" : undefined}>
                    <strong>{mission.title}</strong>
                    {completed ? (
                      <time
                        dateTime={mission.updatedAt}
                        title={formatMissionDateTime(mission.updatedAt)}
                      >
                        {formatMissionTime(mission.updatedAt, props.now)}
                      </time>
                    ) : (
                      <small>
                        <span>{missionStatusLabel(mission)}</span>
                        <time
                          dateTime={mission.updatedAt}
                          title={formatMissionDateTime(mission.updatedAt)}
                        >
                          {formatMissionTime(mission.updatedAt, props.now)}
                        </time>
                      </small>
                    )}
                  </span>
                </button>
                <div className="mission-row-actions">
                  {isActiveMission ? (
                    <>
                      <button
                        className="mission-row-icon-action"
                        type="button"
                        title={
                          isPinned
                            ? i18n.t("unpinMission", { ns: "missions" })
                            : i18n.t("pinMission", { ns: "missions" })
                        }
                        aria-label={i18n.t(isPinned ? "unpinNamed" : "pinNamed", {
                          ns: "missions",
                          title: mission.title,
                        })}
                        aria-pressed={isPinned}
                        onClick={() => props.onTogglePin(mission)}
                      >
                        <PushPin
                          size={15}
                          weight={isPinned ? "fill" : "regular"}
                          aria-hidden="true"
                        />
                      </button>
                      <button
                        className="mission-row-icon-action"
                        type="button"
                        title={i18n.t("markComplete", { ns: "missions" })}
                        aria-label={i18n.t("markCompleteNamed", {
                          ns: "missions",
                          title: mission.title,
                        })}
                        onClick={() => void props.onMarkComplete(mission)}
                      >
                        <CheckCircle size={15} aria-hidden="true" />
                      </button>
                    </>
                  ) : (
                    <button
                      className="mission-row-icon-action is-danger"
                      type="button"
                      disabled={executionActive}
                      title={
                        executionActive
                          ? i18n.t("waitToDelete", { ns: "missions" })
                          : i18n.t("deleteMission", { ns: "missions" })
                      }
                      aria-label={i18n.t("deleteNamed", { ns: "missions", title: mission.title })}
                      onClick={() => props.onDelete(mission)}
                    >
                      <Trash size={15} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {props.hiddenCount > 0 ? (
            <button className="mission-rail-load-more" type="button" onClick={props.onLoadMore}>
              <CaretDown size={14} aria-hidden="true" />
              {i18n.t("loadMoreMissions", { ns: "missions" })}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function comparePinnedMissions(
  left: MissionSummary,
  right: MissionSummary,
  pinnedMissionIds: readonly string[],
): number {
  const leftPinnedIndex = pinnedMissionIds.indexOf(left.id);
  const rightPinnedIndex = pinnedMissionIds.indexOf(right.id);
  const leftPinned = leftPinnedIndex >= 0;
  const rightPinned = rightPinnedIndex >= 0;
  if (leftPinned && rightPinned) return leftPinnedIndex - rightPinnedIndex;
  if (leftPinned) return -1;
  if (rightPinned) return 1;
  return right.updatedAt.localeCompare(left.updatedAt);
}

export type MissionComposerAction = "send" | "loading" | "interrupt";

export function resolveMissionComposerAction(input: {
  readonly draft: string;
  readonly sending: boolean;
  readonly executionActive: boolean;
  readonly interruptible: boolean;
  readonly awaitingRequest: boolean;
  readonly hasPendingQueuedMessage: boolean;
}): MissionComposerAction {
  if (input.sending) return "loading";
  if (input.draft.trim() !== "") return "send";
  if (input.executionActive && input.interruptible) return "interrupt";
  if (input.executionActive || input.awaitingRequest || input.hasPendingQueuedMessage) {
    return "loading";
  }
  return "send";
}

type MissionMemoryView = "store" | "activity";

export const DEFAULT_MISSION_MEMORY_VIEW: MissionMemoryView = "activity";

export function MissionDetailFragment(props: {
  readonly mission: Mission;
  readonly chatCache?: Map<string, MissionChatSnapshot> | undefined;
  readonly initialComposerDraft?: string | undefined;
  readonly initialThinkingRequestId?: string | undefined;
  readonly error?: string | null | undefined;
  readonly onDismissError?: (() => void) | undefined;
  readonly onRun?: () => void | Promise<void>;
  readonly onInterrupt?: () => void | Promise<void>;
  readonly onSend?: (
    content: string,
    requestId: string,
    attachments: readonly ExpertPromptAttachment[],
    mode: "enqueue" | "steer",
  ) => void | Promise<void | { readonly effectiveMode: "enqueue" | "steer" }>;
  readonly onOptionsChange?:
    | ((options: {
        readonly toolPermissionMode: DesktopToolPermissionMode;
        readonly modelOverride?: MissionModelOverride | undefined;
      }) => void | Promise<void>)
    | undefined;
  readonly onContextStoresChange?:
    ((contextMounts: readonly MissionContextMount[]) => void | Promise<void>) | undefined;
  readonly onHumanResponded?: () => void | Promise<void>;
  readonly onLifecycleChange?: () => void | Promise<void>;
  readonly onConfigureModels?: (() => void) | undefined;
  readonly onOpenKnowledgeBases?: (() => void) | undefined;
  readonly onOpenKnowledgeRevision?: ((storeId: string) => void) | undefined;
  readonly onEditExpert?: ((expertRef?: string | undefined) => void) | undefined;
  readonly onBranchCreated?: ((mission: Mission) => void) | undefined;
  readonly memoryEnabled?: boolean | undefined;
}) {
  const { t } = useTranslation(["missions", "common"]);
  const missionError = useCallback(
    (error: unknown) =>
      localizedMissionError(error, (key, options) =>
        options === undefined ? t(key) : t(key, options),
      ),
    [t],
  );
  const [tab, setTab] = useState<"chat" | "work" | "board" | "memory">("chat");
  const memoryEnabled = props.memoryEnabled ?? true;
  const activeTab = !memoryEnabled && tab === "memory" ? "chat" : tab;
  const [memoryView, setMemoryView] = useState<MissionMemoryView>(DEFAULT_MISSION_MEMORY_VIEW);
  const [workspaceAvailable, setWorkspaceAvailable] = useState<boolean | null>(null);
  const [memoryActivity, setMemoryActivity] = useState<DesktopMissionMemoryActivity>();
  const [memoryActivityError, setMemoryActivityError] = useState<string>();
  const [memoryActivityLoading, setMemoryActivityLoading] = useState(false);
  const [deliveryNotice, setDeliveryNotice] = useState<string>();
  const {
    state: clientOperation,
    begin: beginClientOperation,
    finish: finishClientOperation,
  } = useMissionClientOperation(props.mission.id);
  const [queuedMessageActions, setQueuedMessageActions] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const {
    records: workRecords,
    loading: workLoading,
    error: workError,
    retry: retryWork,
    selectedRecord: selectedWorkRecord,
    selectRecord: selectWorkRecord,
    conversation: workConversation,
    conversationLoading: workConversationLoading,
    loadEarlier: loadEarlierWorkConversation,
  } = useMissionWork({
    missionId: props.mission.id,
    executionId: props.mission.execution?.id,
    active: activeTab === "work",
    api: desktopApi(),
    formatError: missionError,
  });
  const {
    draft,
    setDraft,
    attachments,
    attachmentPreviews,
    clearAttachments,
    restoreAttachments,
    addAttachments,
    removeAttachment,
    discardAttachments,
  } = useMissionComposerState({
    mission: props.mission,
    initialDraft: props.initialComposerDraft,
    discardDrafts: desktopApi()?.discardMissionAttachmentDrafts,
    onAttachmentLimit: () => setOptionsError(t("attachmentLimit", { ns: "missions" })),
    onAttachmentsAccepted: () => setOptionsError(null),
  });
  const [branchCandidate, setBranchCandidate] = useState<
    Extract<MissionChatEntry, { kind: "assistant" }> | undefined
  >();
  const [branching, setBranching] = useState(false);
  const [contextStores, setContextStores] = useState<readonly ContextStore[]>([]);
  const [contextStoreIds, setContextStoreIds] = useState<readonly string[]>(
    props.mission.contextMounts.flatMap((mount) =>
      mount.kind === "context-store" ? [mount.storeId] : [],
    ),
  );
  const [contextStorePickerOpen, setContextStorePickerOpen] = useState(false);
  const [contextStoresSaving, setContextStoresSaving] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [chatRefreshRevision, setChatRefreshRevision] = useState(0);
  const {
    optimisticMessages,
    setOptimisticMessages,
    pendingQueuedMessages,
    setPendingQueuedMessages,
    awaitingRequestId,
    setAwaitingRequestId,
    recordSubmission,
    discardSubmission,
  } = useMissionCommandDelivery({
    missionId: props.mission.id,
    subscribe: desktopApi()?.subscribeMissionCommandOutcomes,
    onApplied: () => setChatRefreshRevision((current) => current + 1),
    onRejected: (outcome) => {
      if (outcome.error !== undefined) setOptionsError(missionError(outcome.error));
    },
  });
  const {
    chat,
    initialLoading: chatInitialLoading,
    loadingEarlier,
    historyError,
    syncError: chatSyncError,
    liveEntryStore,
    update: updateChat,
    loadEarlier: loadEarlierChat,
    observeFirstTokenPaint,
  } = useMissionConversation({
    missionId: props.mission.id,
    api: desktopApi(),
    cache: props.chatCache,
    refreshRevision: chatRefreshRevision,
    syncUnavailableMessage: t("chatSyncUnavailable", { ns: "missions" }),
    formatError: missionError,
  });
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const isTeam = props.mission.executor.kind === "team";
  const isFlow = props.mission.executor.kind === "flow";
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const chatBottomRef = useRef<HTMLSpanElement | null>(null);
  const followLatestFrameRef = useRef<number | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const queuedMessageActionsRef = useRef<Set<string>>(new Set());
  const autoRestoreExecutionRef = useRef<string | null>(null);
  const followLatestRef = useRef(true);
  const chatScrollTopRef = useRef(0);
  const chatScrollMissionIdRef = useRef(props.mission.id);
  useEffect(() => {
    if (!contextStorePickerOpen && !contextStoresSaving) {
      setContextStoreIds(
        props.mission.contextMounts.flatMap((mount) =>
          mount.kind === "context-store" ? [mount.storeId] : [],
        ),
      );
    }
  }, [contextStorePickerOpen, contextStoresSaving, props.mission.contextMounts]);

  useEffect(() => {
    let cancelled = false;
    const api = desktopApi();
    if (api === undefined) return;
    void api
      .listContextStores()
      .then((stores) => {
        if (!cancelled) {
          setContextStores(stores);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setOptionsError(missionError(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, [missionError, props.mission.id]);

  const memoryStoreSource = useMemo<ContextStoreBrowserSource>(() => {
    const target = { missionId: props.mission.id, storeId: "memory" } as const;
    return {
      getDescriptor: async () => await window.pragmaDesktop.getMissionContextStore(target),
      list: async (scopeId) =>
        await window.pragmaDesktop.listMissionContextStoreEntries({ ...target, scopeId }),
      read: async (scopeId, id, start) =>
        await window.pragmaDesktop.readMissionContextStoreEntry({
          ...target,
          scopeId,
          id,
          start,
          maxBytes: 64_000,
        }),
      search: async (scopeId, query) =>
        await window.pragmaDesktop.searchMissionContextStore({
          ...target,
          scopeId,
          query,
          maxResults: 50,
          contextLines: 2,
          caseSensitive: false,
        }),
    };
  }, [props.mission.id]);
  const missionBoardSource = useMemo<ContextStoreBrowserSource>(() => {
    const target = { missionId: props.mission.id, storeId: "mission-board" } as const;
    return {
      getDescriptor: async () => await window.pragmaDesktop.getMissionContextStore(target),
      list: async (scopeId) =>
        await window.pragmaDesktop.listMissionContextStoreEntries({ ...target, scopeId }),
      read: async (scopeId, id, start) =>
        await window.pragmaDesktop.readMissionContextStoreEntry({
          ...target,
          scopeId,
          id,
          start,
          maxBytes: 64_000,
        }),
      search: async (scopeId, query) =>
        await window.pragmaDesktop.searchMissionContextStore({
          ...target,
          scopeId,
          query,
          maxResults: 50,
          contextLines: 2,
          caseSensitive: false,
        }),
    };
  }, [props.mission.id]);
  const prependScrollHeightRef = useRef<number | null>(null);
  const {
    questionIndex: humanQuestionIndex,
    setQuestionIndex: setHumanQuestionIndex,
    notes: humanNotes,
    setNotes: setHumanNotes,
    questionNotes: humanQuestionNotes,
    setQuestionNotes: setHumanQuestionNotes,
    answers: humanAnswers,
    setAnswers: setHumanAnswers,
    customAnswers: humanCustomAnswers,
    setCustomAnswers: setHumanCustomAnswers,
    responding,
    respond,
  } = useMissionHumanInteraction({
    missionId: props.mission.id,
    api: desktopApi(),
    updateChat,
    onResponded: props.onHumanResponded,
    onError: (responseError) => setOptionsError(missionError(responseError)),
  });
  const { operations: contextOperations, compact: compactContext } = useMissionContextOperations({
    missionId: props.mission.id,
    canCompact: chat?.contextWindow?.canCompact === true,
    api: desktopApi(),
    begin: () => beginClientOperation("compacting"),
    finish: finishClientOperation,
    updateChat,
    formatError: missionError,
    followLatest: () => {
      followLatestRef.current = true;
    },
  });
  const scheduleFollowLatest = useCallback(() => {
    if (followLatestFrameRef.current !== undefined) return;
    followLatestFrameRef.current = requestAnimationFrame(() => {
      followLatestFrameRef.current = undefined;
      if (!followLatestRef.current) return;
      chatBottomRef.current?.scrollIntoView({ block: "end" });
    });
  }, []);

  useEffect(
    () => () => {
      if (followLatestFrameRef.current !== undefined) {
        cancelAnimationFrame(followLatestFrameRef.current);
        followLatestFrameRef.current = undefined;
      }
    },
    [],
  );

  useEffect(() => {
    const list = chatListRef.current;
    if (activeTab !== "chat" || list === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (prependScrollHeightRef.current === null) scheduleFollowLatest();
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeTab, props.mission.id, scheduleFollowLatest]);
  const executionStatus = chat?.execution?.status ?? props.mission.execution?.status;
  const executionActive =
    executionStatus !== undefined && ["queued", "running", "waiting"].includes(executionStatus);
  const optionsSaving = clientOperation.kind === "saving_options";
  const runtimeCompactingContext =
    chat?.entries.some(
      (entry) => entry.kind === "context_operation" && entry.status === "running",
    ) ?? false;
  const compactingContext = clientOperation.kind === "compacting" || runtimeCompactingContext;
  const clientOperationBusy = clientOperation.kind !== "idle";
  const interactions = chat?.pendingInteractions ?? [];
  const interruptible = chat?.execution?.interruptible ?? false;
  const controlsDisabled = executionActive || clientOperationBusy || compactingContext;
  const {
    models,
    runtimeIdentity,
    modelsLoading,
    defaultModelSelection,
    modelResetRequired,
    toolPermissionMode,
    modelOverride,
    save: saveOptions,
  } = useMissionOptions({
    missionId: props.mission.id,
    executorRef: props.mission.executor.ref,
    isFlow,
    persistedToolPermissionMode: props.mission.toolPermissionMode,
    persistedModelOverride: props.mission.modelOverride,
    saving: optionsSaving,
    controlsDisabled,
    api: desktopApi(),
    beginSave: () => beginClientOperation("saving_options"),
    finishSave: finishClientOperation,
    persist: props.onOptionsChange,
    onError: (optionError) => setOptionsError(missionError(optionError)),
    onClearError: () => setOptionsError(null),
  });
  const imageUnsupported =
    missionImageSupport(models, modelOverride, defaultModelSelection) === "unsupported";
  const visibleError = props.error ?? optionsError;
  const unavailableTool =
    visibleError === null || visibleError === undefined
      ? undefined
      : unavailableMcpToolName(visibleError);
  const presentedError =
    unavailableTool === undefined
      ? visibleError
      : t("mcpToolUnavailable", { ns: "missions", tool: unavailableTool });
  const repairUnavailableTool =
    unavailableTool === undefined || props.onEditExpert === undefined
      ? undefined
      : () =>
          props.onEditExpert?.(
            props.mission.executor.kind === "expert" ? props.mission.executor.ref : undefined,
          );
  const repairUnavailableToolLabel =
    repairUnavailableTool === undefined
      ? undefined
      : props.mission.executor.kind === "expert"
        ? t("editAffectedExpert", { ns: "missions" })
        : t("openStudioToEditExpert", { ns: "missions" });

  useEffect(() => {
    setOptimisticMessages([]);
    setPendingQueuedMessages([]);
    setAwaitingRequestId(null);
    setOptionsError(null);
    queuedMessageActionsRef.current = new Set();
    setQueuedMessageActions(queuedMessageActionsRef.current);
    autoRestoreExecutionRef.current = null;
  }, [props.mission.id]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 130)}px`;
  }, [draft]);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) return;
    let cancelled = false;
    void api.validateWorkspace(props.mission.workspace.path).then((result) => {
      if (!cancelled) setWorkspaceAvailable(result.ok);
    });
    return () => {
      cancelled = true;
    };
  }, [props.mission.workspace.path]);

  useEffect(() => {
    setHumanQuestionIndex(0);
    followLatestRef.current = true;
    setShowJumpToLatest(false);
  }, [props.mission.id, setHumanQuestionIndex]);

  useEffect(() => {
    if (memoryEnabled || tab !== "memory") return;
    setTab("chat");
    setMemoryView("activity");
    setMemoryActivity(undefined);
    setMemoryActivityError(undefined);
    setMemoryActivityLoading(false);
  }, [memoryEnabled, tab]);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined || !memoryEnabled || activeTab !== "memory" || memoryView !== "activity")
      return;
    let cancelled = false;
    setMemoryActivityLoading(true);
    void api
      .getMissionMemoryActivity(props.mission.id)
      .then((activity) => {
        if (cancelled) return;
        setMemoryActivity(activity);
        setMemoryActivityError(undefined);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setMemoryActivityError(missionError(loadError));
      })
      .finally(() => {
        if (!cancelled) setMemoryActivityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, memoryEnabled, memoryView, props.mission.execution?.id, props.mission.id]);

  const beginQueuedMessageAction = (queueItemRequestId: string): boolean => {
    if (queuedMessageActionsRef.current.has(queueItemRequestId)) return false;
    const next = new Set(queuedMessageActionsRef.current).add(queueItemRequestId);
    queuedMessageActionsRef.current = next;
    setQueuedMessageActions(next);
    return true;
  };

  const finishQueuedMessageAction = (queueItemRequestId: string): void => {
    if (!queuedMessageActionsRef.current.has(queueItemRequestId)) return;
    const next = new Set(queuedMessageActionsRef.current);
    next.delete(queueItemRequestId);
    queuedMessageActionsRef.current = next;
    setQueuedMessageActions(next);
  };

  const send = async (retry?: LocalMissionUserMessage) => {
    const content = retry?.content ?? draft.trim();
    if (content === "" || isFlow) return;
    const operationToken = beginClientOperation("sending");
    if (operationToken === undefined) return;
    const optimistic = createMissionSendAttempt({
      content,
      attachments,
      retry,
      createRequestId: () => crypto.randomUUID(),
      now: () => new Date().toISOString(),
    });
    const requestId = optimistic.id;
    recordSubmission(optimistic, retry?.retryMode === "new-request" ? retry.id : undefined);
    const shouldPrepareQueuedMessage = executionActive;
    if (retry === undefined) setDraft("");
    const sentAttachmentIds = optimistic.attachments.map((attachment) => attachment.id);
    const sentAttachmentPreviews = attachmentPreviews;
    let discardSentDrafts = false;
    if (retry === undefined) {
      clearAttachments();
    }
    if (shouldPrepareQueuedMessage) {
      setPendingQueuedMessages((current) =>
        current.some((message) => message.requestId === requestId)
          ? current
          : [...current, { requestId, content, attachments: optimistic.attachments }],
      );
    } else {
      setOptimisticMessages((current) =>
        (retry?.retryMode === "new-request"
          ? current.filter((message) => message.id !== retry.id)
          : current
        ).some((message) => message.id === requestId)
          ? current.map((message) => (message.id === requestId ? optimistic : message))
          : [
              ...(retry?.retryMode === "new-request"
                ? current.filter((message) => message.id !== retry.id)
                : current),
              optimistic,
            ],
      );
      setAwaitingRequestId(requestId);
    }
    followLatestRef.current = true;
    try {
      await props.onSend?.(content, requestId, optimistic.attachments, "enqueue");
      setDeliveryNotice(undefined);
      if (shouldPrepareQueuedMessage) {
        const api = desktopApi();
        const snapshot =
          api === undefined
            ? undefined
            : await api
                .getMissionChat({ id: props.mission.id, limit: MISSION_CHAT_PAGE_SIZE })
                .catch(() => undefined);
        if (snapshot !== undefined) {
          updateChat((current) => mergeLatestChatPage(current, snapshot));
        }
      }
    } catch {
      const api = desktopApi();
      const snapshot =
        api === undefined
          ? undefined
          : await api
              .getMissionChat({ id: props.mission.id, limit: MISSION_CHAT_PAGE_SIZE })
              .catch(() => undefined);
      if (snapshot !== undefined) updateChat((current) => mergeLatestChatPage(current, snapshot));
      const persisted = snapshot?.entries.some((entry) => entry.id === requestId) ?? false;
      if (persisted) discardSubmission(requestId);
      discardSentDrafts = persisted;
      setPendingQueuedMessages((current) =>
        current.filter((message) => message.requestId !== requestId),
      );
      setOptimisticMessages((current) =>
        persisted
          ? current.filter((message) => message.id !== requestId)
          : optimistic.attachments.length > 0
            ? current.filter((message) => message.id !== requestId)
            : current.some((message) => message.id === requestId)
              ? current.map((message) =>
                  message.id === requestId
                    ? { ...message, status: "failed", retryMode: "same-request" }
                    : message,
                )
              : [...current, { ...optimistic, status: "failed", retryMode: "same-request" }],
      );
      if (retry === undefined && !persisted && optimistic.attachments.length > 0) {
        setDraft(content);
        restoreAttachments(optimistic.attachments, sentAttachmentPreviews);
      }
      setAwaitingRequestId(null);
    } finally {
      if (discardSentDrafts && sentAttachmentIds.length > 0) {
        discardAttachments(sentAttachmentIds);
      }
      finishClientOperation(operationToken);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  const pickAttachments = async (kind: ExpertPromptAttachmentKind) => {
    if (isFlow) return;
    try {
      addAttachments(await window.pragmaDesktop.pickMissionAttachments({ kind }));
    } catch (pickError) {
      setOptionsError(missionError(pickError));
    }
  };

  const pasteImage = async (file: File) => {
    try {
      const result = await stageClipboardImage(file, (input) =>
        window.pragmaDesktop.stageMissionClipboardImage(input),
      );
      addAttachments(result);
    } catch (pasteError) {
      setOptionsError(missionError(pasteError));
    }
  };

  const interrupt = async () => {
    if (interrupting || !interruptible) return;
    setInterrupting(true);
    try {
      await props.onInterrupt?.();
    } finally {
      setInterrupting(false);
    }
  };

  const refreshLatestChat = async (): Promise<void> => {
    const api = desktopApi();
    if (api === undefined) return;
    const snapshot = await api.getMissionChat({
      id: props.mission.id,
      limit: MISSION_CHAT_PAGE_SIZE,
    });
    updateChat((current) => mergeLatestChatPage(current, snapshot));
  };

  const steerQueuedMessage = async (queueItemRequestId: string): Promise<void> => {
    const api = desktopApi();
    if (api === undefined || !beginQueuedMessageAction(queueItemRequestId)) return;
    try {
      await api.trySteerQueuedMissionMessage({
        id: props.mission.id,
        requestId: crypto.randomUUID(),
        queueItemRequestId,
      });
      await refreshLatestChat();
    } catch (steerError) {
      setOptionsError(missionError(steerError));
    } finally {
      finishQueuedMessageAction(queueItemRequestId);
    }
  };

  const removeQueuedMessage = async (
    queueItemRequestId: string,
    content: string,
  ): Promise<void> => {
    const api = desktopApi();
    if (api === undefined || !beginQueuedMessageAction(queueItemRequestId)) return;
    try {
      await api.removeQueuedMissionMessage({
        id: props.mission.id,
        requestId: crypto.randomUUID(),
        queueItemRequestId,
      });
      setDraft(content);
      await refreshLatestChat();
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (removeError) {
      setOptionsError(missionError(removeError));
    } finally {
      finishQueuedMessageAction(queueItemRequestId);
    }
  };

  const persistedQueuedRequestIds = useMemo(
    () => new Set(chat?.queue?.items.map((item) => item.requestId) ?? []),
    [chat?.queue?.items],
  );
  const visiblePendingQueuedMessages = useMemo(
    () =>
      pendingQueuedMessages.filter((message) => !persistedQueuedRequestIds.has(message.requestId)),
    [pendingQueuedMessages, persistedQueuedRequestIds],
  );
  const pendingQueuedRequestIds = useMemo(
    () => new Set(pendingQueuedMessages.map((message) => message.requestId)),
    [pendingQueuedMessages],
  );
  const displayEntries = useMemo(
    () =>
      hideInterruptedExecutionFallbackEntries(
        hidePreparingQueuedChatEntries(chat?.entries ?? [], pendingQueuedRequestIds),
      ),
    [chat?.entries, pendingQueuedRequestIds],
  );
  const durableEntryIds = useMemo(
    () => new Set(displayEntries.map((entry) => entry.id)),
    [displayEntries],
  );
  const conversationEntries = useMemo(
    () =>
      [
        ...displayEntries.map((entry) => ({ type: "durable" as const, entry })),
        ...optimisticMessages
          .filter((message) => !durableEntryIds.has(message.id))
          .map((message) => ({ type: "local" as const, entry: message })),
        ...contextOperations.map((operation) => ({
          type: "context-operation" as const,
          entry: operation,
        })),
      ].toSorted((left, right) => left.entry.createdAt.localeCompare(right.entry.createdAt)),
    [contextOperations, displayEntries, durableEntryIds, optimisticMessages],
  );
  const conversationBlocks = useMemo(
    () => groupMissionConversationEntries(conversationEntries),
    [conversationEntries],
  );
  const finalReplyIds = useMemo(() => missionTurnFinalReplyIds(displayEntries), [displayEntries]);
  const latestBranchableReplyId = useMemo(
    () => latestMissionBranchableReply(displayEntries)?.id,
    [displayEntries],
  );
  const selectedWorkInputSenderName = useMemo(() => {
    if (selectedWorkRecord === undefined) return "";
    return missionWorkInputSenderName(selectedWorkRecord, workRecords);
  }, [selectedWorkRecord, t, workRecords]);
  const lastEntry = displayEntries.at(-1);
  const lastEntryFingerprint =
    lastEntry === undefined
      ? "empty"
      : `${lastEntry.id}:${lastEntry.kind}:${entryContentLength(lastEntry)}`;
  const lastContextOperation = contextOperations.at(-1);
  const lastContextOperationFingerprint =
    lastContextOperation === undefined
      ? "empty"
      : `${lastContextOperation.id}:${lastContextOperation.status}`;
  const thinkingRequestId = awaitingRequestId ?? props.initialThinkingRequestId ?? null;
  const showThinkingPlaceholder = shouldShowMissionThinkingPlaceholder(chat, thinkingRequestId);
  const composerAction = resolveMissionComposerAction({
    draft,
    sending: clientOperation.kind === "sending",
    executionActive,
    interruptible,
    awaitingRequest: awaitingRequestId !== null,
    hasPendingQueuedMessage: pendingQueuedMessages.length > 0,
  });

  useEffect(() => {
    if (durableEntryIds.size === 0) return;
    setOptimisticMessages((current) =>
      current.filter((message) => !durableEntryIds.has(message.id)),
    );
  }, [durableEntryIds]);

  useEffect(() => {
    if (pendingQueuedMessages.length === 0 || chat === null) return;
    const readyOrStartedRequestIds = readyPendingQueuedRequestIds(
      pendingQueuedMessages,
      persistedQueuedRequestIds,
      chat.entries,
    );
    const startedRequestIds = new Set<string>();
    for (const entry of chat.entries) {
      if (
        entry.kind === "user" &&
        entry.delivery?.status !== undefined &&
        entry.delivery.status !== "queued"
      ) {
        startedRequestIds.add(entry.id);
      }
    }
    if (readyOrStartedRequestIds.size === 0) return;
    const startedPendingMessage = pendingQueuedMessages.find((message) =>
      startedRequestIds.has(message.requestId),
    );
    if (startedPendingMessage !== undefined) {
      setAwaitingRequestId(startedPendingMessage.requestId);
    }
    setPendingQueuedMessages((current) =>
      current.filter((message) => !readyOrStartedRequestIds.has(message.requestId)),
    );
  }, [chat, pendingQueuedMessages, persistedQueuedRequestIds]);

  useEffect(() => {
    if (awaitingRequestId === null || chat === null) return;
    if (shouldClearMissionThinkingPlaceholder(chat, awaitingRequestId)) {
      setAwaitingRequestId(null);
    }
  }, [awaitingRequestId, chat]);

  useEffect(() => {
    const executionId = props.mission.execution?.id;
    if (
      props.mission.lifecycleStatus !== "active" ||
      executionId === undefined ||
      !executionActive ||
      interruptible ||
      autoRestoreExecutionRef.current === executionId
    ) {
      return;
    }
    const operationToken = beginClientOperation("restoring");
    if (operationToken === undefined) return;
    autoRestoreExecutionRef.current = executionId;
    void Promise.resolve(props.onRun?.())
      .catch((restoreError: unknown) => {
        console.error("Failed to auto-restore Mission execution.", restoreError);
      })
      .finally(() => finishClientOperation(operationToken));
  }, [
    beginClientOperation,
    executionActive,
    finishClientOperation,
    interruptible,
    props.mission.execution?.id,
    props.mission.lifecycleStatus,
    props.onRun,
  ]);

  const loadEarlier = async (): Promise<void> => {
    await loadEarlierChat(() => {
      const element = scrollRef.current;
      prependScrollHeightRef.current = element?.scrollHeight ?? null;
      followLatestRef.current = false;
    });
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    if (prependScrollHeightRef.current !== null) {
      element.scrollTop += element.scrollHeight - prependScrollHeightRef.current;
      prependScrollHeightRef.current = null;
      setShowJumpToLatest(true);
      return;
    }
    if (followLatestRef.current) {
      scheduleFollowLatest();
      setShowJumpToLatest(false);
    } else {
      setShowJumpToLatest(true);
    }
  }, [
    awaitingRequestId,
    conversationEntries.length,
    displayEntries.length,
    lastEntryFingerprint,
    lastContextOperationFingerprint,
    interactions.length,
    scheduleFollowLatest,
  ]);

  useLayoutEffect(() => {
    if (activeTab !== "chat") return;
    const element = scrollRef.current;
    if (element === null) return;
    if (chatScrollMissionIdRef.current !== props.mission.id) {
      chatScrollMissionIdRef.current = props.mission.id;
      chatScrollTopRef.current = 0;
    }
    element.scrollTop = chatScrollTopRef.current;
  }, [activeTab, props.mission.id]);

  const changeTab = (nextTab: "chat" | "work" | "board" | "memory"): void => {
    if (nextTab === "memory" && !memoryEnabled) return;
    if (activeTab === "chat") {
      const element = scrollRef.current;
      if (element !== null) chatScrollTopRef.current = element.scrollTop;
    }
    setTab(nextTab);
  };
  const selectBranchCandidate = useCallback(
    (entry: Extract<MissionChatEntry, { kind: "assistant" }>) => setBranchCandidate(entry),
    [],
  );

  const revisionStoreId =
    props.mission.origin.type === "system-store-revision"
      ? props.mission.origin.storeId
      : undefined;
  const missionStatusBar = (
    <div className="mission-detail-status-bar" aria-label={props.mission.title}>
      <p>
        <span className="mission-ready-dot" aria-hidden="true" />
        {missionStatusLabel(
          props.mission,
          clientOperation.kind === "sending" ||
            (props.mission.execution === undefined && thinkingRequestId !== null),
        )}
        <span aria-hidden="true">·</span>
        <Folder size={16} aria-hidden="true" />
        {props.mission.workspace.basename}
        {workspaceAvailable === false ? (
          <strong>{t("workspaceUnavailableTitle", { ns: "missions" })}</strong>
        ) : null}
        <span aria-hidden="true">·</span>
        {isTeam ? (
          <UsersThree size={17} aria-hidden="true" />
        ) : isFlow ? (
          <GitBranch size={17} aria-hidden="true" />
        ) : (
          <User size={17} aria-hidden="true" />
        )}
        {props.mission.executor.name}
        {runtimeIdentity === undefined ? null : (
          <>
            <span aria-hidden="true">·</span>
            <TerminalWindow size={17} aria-hidden="true" />
            {runtimeDisplayName(t, runtimeIdentity)}
          </>
        )}
        {revisionStoreId !== undefined && props.onOpenKnowledgeRevision !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <button
              className="mission-lifecycle-status-action"
              type="button"
              onClick={() => props.onOpenKnowledgeRevision?.(revisionStoreId)}
            >
              {t("openKnowledgeRevision", { ns: "missions" })}
            </button>
          </>
        ) : null}
        <span aria-hidden="true">·</span>
        <button
          className="mission-lifecycle-status-action"
          type="button"
          disabled={clientOperationBusy}
          onClick={() => void props.onLifecycleChange?.()}
        >
          {props.mission.lifecycleStatus === "active" ? (
            <>
              <CheckCircle size={16} aria-hidden="true" />
              {t("markComplete", { ns: "missions" })}
            </>
          ) : (
            <>
              <ArrowCounterClockwise size={16} aria-hidden="true" />
              {t("reopen", { ns: "missions" })}
            </>
          )}
        </button>
      </p>
      {props.mission.lifecycleStatus === "active" &&
      (props.mission.execution === undefined ||
        (!executionActive && isFlow) ||
        (executionActive && !interruptible)) &&
      !(props.mission.branch !== undefined && props.mission.execution === undefined) ? (
        <button
          className="primary-button"
          type="button"
          disabled={clientOperationBusy}
          onClick={() => void props.onRun?.()}
        >
          <Play size={17} />
          {executionActive
            ? t("resume", { ns: "missions" })
            : props.mission.execution === undefined
              ? t("run", { ns: "missions" })
              : t("runAgain", { ns: "missions" })}
        </button>
      ) : null}
    </div>
  );

  return (
    <section className="mission-detail">
      <div className="mission-detail-topbar">
        {missionStatusBar}
        <div
          className="mission-detail-tabs"
          role="tablist"
          aria-label={t("detailViews", { ns: "missions" })}
        >
          <button
            className={activeTab === "chat" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={activeTab === "chat"}
            onClick={() => changeTab("chat")}
          >
            {isTeam ? t("teamChannel", { ns: "missions" }) : t("chat", { ns: "missions" })}
          </button>
          <button
            className={activeTab === "work" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={activeTab === "work"}
            onClick={() => changeTab("work")}
          >
            {t("work", { ns: "missions" })}
          </button>
          <button
            className={activeTab === "board" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={activeTab === "board"}
            onClick={() => changeTab("board")}
          >
            {t("missionBoard", { ns: "missions" })}
          </button>
          {memoryEnabled ? (
            <button
              className={activeTab === "memory" ? "is-active" : ""}
              type="button"
              role="tab"
              aria-selected={activeTab === "memory"}
              onClick={() => changeTab("memory")}
            >
              {t("memory", { ns: "missions" })}
            </button>
          ) : null}
        </div>
      </div>
      <div className="mission-detail-body">
        {activeTab !== "chat" && presentedError !== null && presentedError !== undefined ? (
          <MissionErrorBanner
            error={presentedError}
            actionLabel={repairUnavailableToolLabel}
            onAction={repairUnavailableTool}
            onDismiss={() => {
              setOptionsError(null);
              props.onDismissError?.();
            }}
          />
        ) : null}
        {activeTab === "chat" ? (
          <div className="mission-chat-shell">
            <div
              className="mission-chat-scroll"
              ref={scrollRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                chatScrollTopRef.current = element.scrollTop;
                const nearBottom =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 72;
                followLatestRef.current = nearBottom;
                if (nearBottom) setShowJumpToLatest(false);
              }}
            >
              <div className="mission-chat-list" ref={chatListRef}>
                {chatInitialLoading && !showThinkingPlaceholder ? (
                  <MissionChatSkeleton label={t("loadingChat", { ns: "missions" })} />
                ) : null}
                {!chatInitialLoading && chat?.page.nextBeforeCursor !== undefined ? (
                  <button
                    className="mission-load-earlier"
                    type="button"
                    disabled={loadingEarlier}
                    onClick={() => void loadEarlier()}
                  >
                    {loadingEarlier
                      ? t("loadingEarlier", { ns: "missions" })
                      : t("loadEarlier", { ns: "missions" })}
                  </button>
                ) : null}
                {chatSyncError === null ? null : (
                  <div className="mission-history-error" role="alert">
                    <span>{chatSyncError}</span>
                    <button
                      type="button"
                      onClick={() => setChatRefreshRevision((current) => current + 1)}
                    >
                      {t("retryChatSync", { ns: "missions" })}
                    </button>
                  </div>
                )}
                {historyError === null ? null : (
                  <p className="mission-history-error" role="alert">
                    {historyError}
                  </p>
                )}
                {conversationBlocks.map((block) => {
                  if (block.type === "tools") {
                    return (
                      <MissionToolCallBlock
                        collapsed={block.collapsed}
                        entries={block.entries}
                        key={`tools:${block.entries[0]!.id}`}
                      />
                    );
                  }
                  return block.item.type === "local" ? (
                    <LocalMissionUserMessageView
                      message={block.item.entry}
                      missionId={props.mission.id}
                      key={block.item.entry.id}
                      retryDisabled={clientOperationBusy}
                      onRetry={
                        block.item.entry.retryMode !== undefined
                          ? (message) => void send(message)
                          : undefined
                      }
                    />
                  ) : block.item.type === "context-operation" ? (
                    <MissionContextOperationEntry
                      operation={block.item.entry}
                      key={block.item.entry.id}
                      retryDisabled={
                        clientOperationBusy || chat?.contextWindow?.canCompact !== true
                      }
                      onRetry={() => void compactContext(block.item.entry.id)}
                    />
                  ) : (
                    <MissionChatEntryView
                      entry={block.item.entry}
                      key={block.item.entry.id}
                      liveEntryStore={liveEntryStore}
                      missionId={props.mission.id}
                      onVisibleContent={observeFirstTokenPaint}
                      paintExecutionId={block.item.entry.executionId ?? chat?.execution?.id}
                      showExecutorLabel
                      showCopy={finalReplyIds.has(block.item.entry.id)}
                      showBranch={
                        block.item.entry.id === latestBranchableReplyId &&
                        props.mission.executor.kind !== "flow" &&
                        !executionActive &&
                        !clientOperationBusy &&
                        (chat?.queue?.state ?? "idle") === "idle" &&
                        (chat?.queue?.pendingCount ?? 0) === 0 &&
                        (chat?.pendingInteractions.length ?? 0) === 0
                      }
                      onBranch={selectBranchCandidate}
                    />
                  );
                })}
                {showThinkingPlaceholder ? (
                  <MissionThinkingPlaceholder executorName={props.mission.executor.name} />
                ) : null}
                <span
                  aria-hidden="true"
                  className="mission-chat-bottom-anchor"
                  ref={chatBottomRef}
                />
              </div>
              {showJumpToLatest ? (
                <button
                  className="mission-jump-latest"
                  type="button"
                  onClick={() => {
                    followLatestRef.current = true;
                    scheduleFollowLatest();
                    setShowJumpToLatest(false);
                  }}
                >
                  <CaretDown size={15} aria-hidden="true" />
                  {t("jumpLatest", { ns: "missions" })}
                </button>
              ) : null}
            </div>
            <div className="mission-chat-footer">
              {presentedError !== null && presentedError !== undefined ? (
                <MissionErrorBanner
                  error={presentedError}
                  actionLabel={repairUnavailableToolLabel}
                  onAction={repairUnavailableTool}
                  onDismiss={() => {
                    setOptionsError(null);
                    props.onDismissError?.();
                  }}
                />
              ) : null}
              {interactions[0] !== undefined && missionFooterTip(props.mission, chat) ? (
                <small className="mission-chat-footer-tip">
                  {missionFooterTip(props.mission, chat)}
                </small>
              ) : null}
              {compactingContext ? (
                <small
                  className="mission-chat-footer-tip mission-context-operation-tip"
                  id="mission-context-compaction-status"
                  role="status"
                >
                  {t("contextCompactionInputDisabled", { ns: "missions" })}
                </small>
              ) : null}
              {deliveryNotice === undefined ? null : (
                <small className="mission-chat-footer-tip" role="status">
                  {deliveryNotice}
                </small>
              )}
              {chat?.queue?.state === "paused" ? (
                <small className="mission-chat-footer-tip" role="status">
                  <span>{t("queuePaused", { ns: "missions" })}</span>{" "}
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => void desktopApi()?.resumeMissionQueue(props.mission.id)}
                  >
                    {t("resumeQueue", { ns: "missions" })}
                  </button>
                </small>
              ) : null}
              {modelResetRequired ? (
                <small className="mission-chat-footer-tip mission-model-reset-note" role="status">
                  <span>{t("modelConfigurationResetRequired", { ns: "missions" })}</span>
                  <button className="text-button" type="button" onClick={props.onConfigureModels}>
                    {t("configureModels", { ns: "missions" })}
                  </button>
                </small>
              ) : null}
              {interactions[0] !== undefined ? (
                <>
                  <MissionHumanComposer
                    interaction={interactions[0]}
                    answers={humanAnswers[interactions[0].interactionId] ?? {}}
                    customAnswers={humanCustomAnswers[interactions[0].interactionId] ?? {}}
                    notes={humanNotes[interactions[0].interactionId] ?? ""}
                    questionNotes={humanQuestionNotes[interactions[0].interactionId] ?? {}}
                    questionIndex={humanQuestionIndex}
                    interactionPosition={{ current: 1, total: interactions.length }}
                    responding={responding}
                    interruptible={interruptible}
                    interrupting={interrupting}
                    onQuestionIndex={setHumanQuestionIndex}
                    onAnswer={(question, value) => {
                      setHumanAnswer(
                        setHumanAnswers,
                        interactions[0]!.interactionId,
                        question,
                        value,
                      );
                      setHumanCustomAnswer(
                        setHumanCustomAnswers,
                        interactions[0]!.interactionId,
                        question,
                        "",
                      );
                    }}
                    onCustomAnswer={(question, value) => {
                      setHumanAnswer(
                        setHumanAnswers,
                        interactions[0]!.interactionId,
                        question,
                        undefined,
                      );
                      setHumanCustomAnswer(
                        setHumanCustomAnswers,
                        interactions[0]!.interactionId,
                        question,
                        value,
                      );
                    }}
                    onNotes={(value) =>
                      setHumanNotes((current) => ({
                        ...current,
                        [interactions[0]!.interactionId]: value,
                      }))
                    }
                    onQuestionNote={(question, value) =>
                      setHumanQuestionNote(
                        setHumanQuestionNotes,
                        interactions[0]!.interactionId,
                        question,
                        value,
                      )
                    }
                    onRespond={(response) => void respond(interactions[0]!, response)}
                    onInterrupt={() => void interrupt()}
                  />
                </>
              ) : (
                <>
                  <div className="mission-chat-composer-meta">
                    {missionFooterTip(props.mission, chat) ? (
                      <small className="mission-chat-footer-tip">
                        {missionFooterTip(props.mission, chat)}
                      </small>
                    ) : null}
                    <MissionUsageHint
                      missionId={props.mission.id}
                      executionActive={executionActive}
                    />
                  </div>
                  <div className="mission-chat-composer-shell">
                    {(chat?.queue?.items.length ?? 0) + visiblePendingQueuedMessages.length > 0 ? (
                      <div
                        className="mission-prompt-queue"
                        aria-label={t("queuedMessages", { ns: "missions" })}
                      >
                        {chat?.queue?.items.map((item) => {
                          const preparing = pendingQueuedRequestIds.has(item.requestId);
                          return (
                            <div className="mission-prompt-queue-item" key={item.requestId}>
                              <span className="mission-prompt-queue-marker" aria-hidden="true">
                                <ArrowBendUpLeft size={16} />
                              </span>
                              <strong>{t("queuedMessage", { ns: "missions" })}</strong>
                              <span title={item.content}>{item.content}</span>
                              <div className="mission-prompt-queue-actions">
                                {chat.queue?.supportsSteer === true &&
                                interruptible &&
                                !item.hasAttachments &&
                                preparing ? (
                                  <button
                                    className="mission-queue-steer is-preparing"
                                    type="button"
                                    aria-label={t("preparingQueuedSteer", { ns: "missions" })}
                                    title={t("preparingQueuedSteer", { ns: "missions" })}
                                    disabled
                                  >
                                    <SpinnerGap size={16} aria-hidden="true" />
                                  </button>
                                ) : chat.queue?.supportsSteer === true &&
                                  interruptible &&
                                  !item.hasAttachments ? (
                                  <button
                                    className="mission-queue-steer"
                                    type="button"
                                    disabled={queuedMessageActions.has(item.requestId)}
                                    onClick={() => void steerQueuedMessage(item.requestId)}
                                  >
                                    <ArrowBendUpLeft size={16} aria-hidden="true" />
                                    {t("deliverySteer", { ns: "missions" })}
                                  </button>
                                ) : null}
                                <button
                                  className="mission-queue-remove"
                                  type="button"
                                  aria-label={t("removeQueuedMessage", { ns: "missions" })}
                                  title={t("removeQueuedMessage", { ns: "missions" })}
                                  disabled={queuedMessageActions.has(item.requestId) || preparing}
                                  onClick={() =>
                                    void removeQueuedMessage(item.requestId, item.content)
                                  }
                                >
                                  <Trash size={17} aria-hidden="true" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                        {visiblePendingQueuedMessages.map((item) => (
                          <div
                            className="mission-prompt-queue-item is-preparing"
                            key={item.requestId}
                          >
                            <span className="mission-prompt-queue-marker" aria-hidden="true">
                              <ArrowBendUpLeft size={16} />
                            </span>
                            <strong>{t("queuedMessage", { ns: "missions" })}</strong>
                            <span title={item.content}>{item.content}</span>
                            <div className="mission-prompt-queue-actions">
                              {chat?.queue?.supportsSteer === true &&
                              interruptible &&
                              item.attachments.length === 0 ? (
                                <button
                                  className="mission-queue-steer is-preparing"
                                  type="button"
                                  aria-label={t("preparingQueuedSteer", { ns: "missions" })}
                                  title={t("preparingQueuedSteer", { ns: "missions" })}
                                  disabled
                                >
                                  <SpinnerGap size={16} aria-hidden="true" />
                                </button>
                              ) : null}
                              <button
                                className="mission-queue-remove"
                                type="button"
                                aria-label={t("removeQueuedMessage", { ns: "missions" })}
                                title={t("removeQueuedMessage", { ns: "missions" })}
                                disabled
                              >
                                <Trash size={17} aria-hidden="true" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <div className="mission-chat-composer" aria-busy={clientOperationBusy}>
                      <MissionAttachmentList
                        attachments={attachments}
                        previews={attachmentPreviews}
                        imageUnsupported={imageUnsupported}
                        onRemove={removeAttachment}
                      />
                      <textarea
                        ref={textareaRef}
                        rows={1}
                        value={draft}
                        disabled={
                          isFlow ||
                          clientOperationBusy ||
                          compactingContext ||
                          props.mission.lifecycleStatus === "completed"
                        }
                        placeholder={
                          compactingContext
                            ? t("contextCompactionInputDisabled", { ns: "missions" })
                            : props.mission.lifecycleStatus === "completed"
                              ? t("reopenToContinue", { ns: "missions" })
                              : isFlow
                                ? t("flowContinues", { ns: "missions" })
                                : t("messageExecutor", {
                                    ns: "missions",
                                    name: props.mission.executor.name,
                                  })
                        }
                        aria-label={t("messageExecutor", {
                          ns: "missions",
                          name: props.mission.executor.name,
                        })}
                        aria-describedby={
                          compactingContext ? "mission-context-compaction-status" : undefined
                        }
                        onChange={(event) => setDraft(event.target.value)}
                        onPaste={(event) => {
                          const file = clipboardImageFile(event.clipboardData);
                          if (
                            file === undefined ||
                            isFlow ||
                            clientOperationBusy ||
                            compactingContext ||
                            props.mission.lifecycleStatus === "completed"
                          )
                            return;
                          event.preventDefault();
                          void pasteImage(file);
                        }}
                        onKeyDown={(event) => {
                          if (shouldSubmitComposerOnEnter(event.nativeEvent)) {
                            event.preventDefault();
                            void send();
                          }
                        }}
                      />
                      <div className="mission-chat-composer-toolbar">
                        <div className="mission-chat-options" aria-label={t("missionOptions")}>
                          <MissionAttachmentPicker
                            compact
                            disabled={
                              isFlow ||
                              clientOperationBusy ||
                              compactingContext ||
                              props.mission.lifecycleStatus === "completed"
                            }
                            onPick={pickAttachments}
                          />
                          <button
                            className="mission-context-store-trigger"
                            type="button"
                            disabled={
                              controlsDisabled ||
                              contextStoresSaving ||
                              pendingQueuedMessages.length > 0
                            }
                            aria-label={t("missionKnowledge", { ns: "missions" })}
                            title={
                              pendingQueuedMessages.length > 0
                                ? t("missionKnowledgeQueuePending", { ns: "missions" })
                                : executionActive
                                  ? t("optionsAvailableNextTurn", { ns: "missions" })
                                  : t("missionKnowledgeSelected", {
                                      ns: "missions",
                                      count: props.mission.contextMounts.length,
                                    })
                            }
                            onClick={() => setContextStorePickerOpen(true)}
                          >
                            <FolderOpen size={17} aria-hidden="true" />
                            <span>{t("missionKnowledge", { ns: "missions" })}</span>
                            {props.mission.contextMounts.length === 0 ? null : (
                              <strong>{props.mission.contextMounts.length}</strong>
                            )}
                          </button>
                          <ToolPermissionSelect
                            detailed
                            value={toolPermissionMode}
                            disabled={controlsDisabled}
                            title={
                              executionActive
                                ? t("optionsAvailableNextTurn", { ns: "missions" })
                                : t("permissionOverride", { ns: "missions" })
                            }
                            onChange={(value) => void saveOptions(value, modelOverride)}
                          />
                          {!isFlow ? (
                            <MissionModelOverrideControls
                              models={models}
                              loading={modelsLoading}
                              disabled={controlsDisabled}
                              keepOpenWhenDisabled={optionsSaving}
                              value={modelOverride}
                              defaultValue={defaultModelSelection}
                              onChange={(value) => void saveOptions(toolPermissionMode, value)}
                            />
                          ) : null}
                        </div>
                        <div className="mission-chat-actions">
                          {chat?.contextWindow === undefined ? null : (
                            <ContextWindowControl
                              state={chat.contextWindow}
                              compacting={compactingContext}
                              onCompact={() => void compactContext()}
                            />
                          )}
                          {composerAction === "interrupt" ? (
                            <button
                              className="is-interrupt"
                              type="button"
                              aria-label={t("interrupt", { ns: "missions" })}
                              title={t("interrupt", { ns: "missions" })}
                              disabled={interrupting}
                              onClick={() => void interrupt()}
                            >
                              <Stop size={17} weight="fill" aria-hidden="true" />
                            </button>
                          ) : composerAction === "loading" ? (
                            <button
                              className="is-loading"
                              type="button"
                              aria-label={t("loading", { ns: "common" })}
                              title={t("loading", { ns: "common" })}
                              aria-busy="true"
                              disabled
                            >
                              <SpinnerGap size={19} aria-hidden="true" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              aria-label={t("send", { ns: "missions" })}
                              disabled={
                                isFlow ||
                                draft.trim() === "" ||
                                clientOperationBusy ||
                                props.mission.lifecycleStatus === "completed"
                              }
                              onClick={() => void send()}
                            >
                              <ArrowUp size={19} weight="bold" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        ) : activeTab === "board" ? (
          <div className="mission-board-shell">
            <ContextStoreBrowser source={missionBoardSource} variant="mission-board" />
          </div>
        ) : activeTab === "memory" ? (
          <div className="mission-memory-shell">
            {memoryView === "store" ? (
              <MemoryStoreBrowser
                className="mission-memory-store"
                source={memoryStoreSource}
                onBack={() => setMemoryView("activity")}
                backLabel={t("backToMemoryActivity")}
              />
            ) : (
              <MissionMemoryActivity
                activity={memoryActivity}
                error={memoryActivityError}
                loading={memoryActivityLoading}
                onBrowseStore={() => setMemoryView("store")}
              />
            )}
          </div>
        ) : workError !== null && workRecords.length === 0 ? (
          <div className="mission-work-empty" role="alert">
            <WarningCircle size={31} weight="thin" aria-hidden="true" />
            <h2>{t("workHistoryUnavailable", { ns: "missions" })}</h2>
            <p>{workError}</p>
            <button className="mission-load-earlier" type="button" onClick={retryWork}>
              {t("actions.retry", { ns: "common" })}
            </button>
          </div>
        ) : workLoading && workRecords.length === 0 ? (
          <div className="mission-work-empty">
            <SpinnerGap size={31} className="is-spinning" aria-hidden="true" />
            <h2>
              {t("loadingWorkHistory", { ns: "missions", defaultValue: "正在加载工作纪录..." })}
            </h2>
            <p>
              {t("loadingWorkHistoryDescription", {
                ns: "missions",
                defaultValue: "如果包含多个 Agent 或大量事件，可能需要稍等片刻",
              })}
            </p>
          </div>
        ) : workRecords.length === 0 ? (
          <div className="mission-work-empty">
            <CheckCircle size={31} weight="thin" aria-hidden="true" />
            <h2>
              {props.mission.execution === undefined
                ? t("noExecutionRecords", { ns: "missions" })
                : t("executionStatus", {
                    ns: "missions",
                    status: props.mission.execution.status,
                  })}
            </h2>
            <p>
              {props.mission.execution === undefined
                ? t("runToCreateExecution", { ns: "missions" })
                : t("executionId", { ns: "missions", id: props.mission.execution.id })}
            </p>
          </div>
        ) : (
          <MissionWorkGrid records={workRecords} onSelect={selectWorkRecord} />
        )}
      </div>
      {selectedWorkRecord === undefined ? null : (
        <MissionWorkDrawer
          record={selectedWorkRecord}
          inputSenderName={selectedWorkInputSenderName}
          entries={
            workConversation?.recordId === selectedWorkRecord.recordId
              ? workConversation.entries
              : []
          }
          loading={workConversationLoading}
          onLoadEarlier={
            workConversation?.recordId === selectedWorkRecord.recordId &&
            workConversation.nextBeforeCursor !== undefined
              ? () => loadEarlierWorkConversation()
              : undefined
          }
          onClose={() => selectWorkRecord(null)}
        />
      )}
      {contextStorePickerOpen ? (
        <ContextStorePickerDialog
          stores={contextStores}
          selectedStoreIds={contextStoreIds}
          description={t("missionKnowledgePickerDescription", { ns: "missions" })}
          footerHint={t("missionKnowledgeNextExecutionHint", { ns: "missions" })}
          onSelectedStoreIdsChange={setContextStoreIds}
          onGoToKnowledgeBases={props.onOpenKnowledgeBases}
          onClose={() => {
            const nextMounts: readonly MissionContextMount[] = [
              ...contextStoreIds.map((storeId) => ({
                kind: "context-store" as const,
                storeId,
              })),
              ...props.mission.contextMounts.filter(
                (mount): mount is Extract<MissionContextMount, { kind: "context-store-draft" }> =>
                  mount.kind === "context-store-draft",
              ),
            ];
            setContextStorePickerOpen(false);
            if (JSON.stringify(nextMounts) === JSON.stringify(props.mission.contextMounts)) return;
            setContextStoresSaving(true);
            void Promise.resolve(props.onContextStoresChange?.(nextMounts))
              .catch((saveError: unknown) => {
                setContextStoreIds(
                  props.mission.contextMounts.flatMap((mount) =>
                    mount.kind === "context-store" ? [mount.storeId] : [],
                  ),
                );
                setOptionsError(missionError(saveError));
              })
              .finally(() => setContextStoresSaving(false));
          }}
        />
      ) : null}
      {branchCandidate === undefined ? null : (
        <ConfirmationDialog
          title={t("createBranchTitle", { ns: "missions" })}
          description={t("createBranchDescription", {
            ns: "missions",
            title: props.mission.title,
          })}
          cancelLabel={t("actions.cancel", { ns: "common" })}
          confirmLabel={t("createBranch", { ns: "missions" })}
          busyLabel={t("creatingBranch", { ns: "missions" })}
          busy={branching}
          tone="primary"
          onCancel={() => setBranchCandidate(undefined)}
          onConfirm={() => {
            const api = desktopApi();
            if (api === undefined) return;
            setBranching(true);
            void api
              .createMissionBranch({
                sourceMissionId: props.mission.id,
                expectedExecutionId: chat?.execution?.id ?? null,
                expectedMessageId: branchCandidate.id,
              })
              .then((mission) => {
                setBranchCandidate(undefined);
                props.onBranchCreated?.(mission);
              })
              .catch((branchError: unknown) => setOptionsError(missionError(branchError)))
              .finally(() => setBranching(false));
          }}
        />
      )}
    </section>
  );
}

interface MissionWorkGridEdge {
  readonly id: string;
  readonly path: string;
}

interface MissionWorkGridRect {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export function missionWorkCallOrder(
  records: readonly MissionWorkRecord[],
): ReadonlyMap<string, number> {
  const calledRecords = records
    .filter((record) => record.parentRecordId !== undefined)
    .toSorted((left, right) => {
      const created = left.createdAt.localeCompare(right.createdAt);
      return created === 0 ? left.recordId.localeCompare(right.recordId) : created;
    });
  return new Map(calledRecords.map((record, index) => [record.recordId, index + 1] as const));
}

export function missionWorkGridEdgePath(input: {
  readonly source: MissionWorkGridRect;
  readonly target: MissionWorkGridRect;
  readonly surface: Pick<MissionWorkGridRect, "left" | "top">;
  readonly arrowGap?: number | undefined;
  readonly verticalTrunkY?: number | undefined;
}): string {
  const arrowGap = input.arrowGap ?? 10;
  const sourceCenterX = input.source.left + input.source.width / 2 - input.surface.left;
  const sourceCenterY = input.source.top + input.source.height / 2 - input.surface.top;
  const targetCenterX = input.target.left + input.target.width / 2 - input.surface.left;

  if (input.target.top >= input.source.bottom) {
    const sourceY = input.source.bottom - input.surface.top;
    const targetY = input.target.top - input.surface.top - arrowGap;
    const middleY = input.verticalTrunkY ?? sourceY + (targetY - sourceY) / 2;
    return `M ${sourceCenterX} ${sourceY} V ${middleY} H ${targetCenterX} V ${targetY}`;
  }
  if (input.target.bottom <= input.source.top) {
    const sourceY = input.source.top - input.surface.top;
    const targetY = input.target.bottom - input.surface.top + arrowGap;
    const middleY = sourceY + (targetY - sourceY) / 2;
    return `M ${sourceCenterX} ${sourceY} V ${middleY} H ${targetCenterX} V ${targetY}`;
  }

  if (targetCenterX >= sourceCenterX) {
    const sourceX = input.source.right - input.surface.left;
    const targetX = input.target.left - input.surface.left - arrowGap;
    return `M ${sourceX} ${sourceCenterY} H ${targetX}`;
  }
  const sourceX = input.source.left - input.surface.left;
  const targetX = input.target.right - input.surface.left + arrowGap;
  return `M ${sourceX} ${sourceCenterY} H ${targetX}`;
}

export function MissionWorkGrid(props: {
  readonly records: readonly MissionWorkRecord[];
  readonly onSelect: (recordId: string) => void;
}) {
  const { t } = useTranslation("missions");
  const surfaceRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const [edges, setEdges] = useState<readonly MissionWorkGridEdge[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const markerId = `mission-work-arrow-${useId().replaceAll(":", "")}`;
  const pageCount = Math.max(1, Math.ceil(props.records.length / MISSION_WORK_RECORD_PAGE_SIZE));
  const pageRecords = useMemo(
    () => missionWorkPageRecords(props.records, pageIndex, MISSION_WORK_RECORD_PAGE_SIZE),
    [pageIndex, props.records],
  );
  const recordSetIdentity = props.records
    .filter((record) => record.parentRecordId === undefined)
    .map((record) => record.recordId)
    .join(":");
  useEffect(() => setPageIndex(0), [recordSetIdentity]);
  useEffect(() => {
    setPageIndex((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);
  const density =
    pageRecords.length === 1 ? "single" : pageRecords.length === 2 ? "pair" : "network";
  const callOrder = useMemo(() => missionWorkCallOrder(props.records), [props.records]);
  const levels = useMemo(() => {
    const compareByCallOrder = (left: MissionWorkRecord, right: MissionWorkRecord) => {
      if (left.parentRecordId === undefined && right.parentRecordId !== undefined) return -1;
      if (right.parentRecordId === undefined && left.parentRecordId !== undefined) return 1;
      return (callOrder.get(left.recordId) ?? 0) - (callOrder.get(right.recordId) ?? 0);
    };
    if (pageRecords.length <= 2) {
      return [[0, pageRecords.toSorted(compareByCallOrder)] as const];
    }
    const grouped = new Map<number, MissionWorkRecord[]>();
    for (const record of pageRecords) {
      const depth = workRecordDepth(record, props.records);
      grouped.set(depth, [...(grouped.get(depth) ?? []), record]);
    }
    return [...grouped.entries()]
      .toSorted(([left], [right]) => left - right)
      .map(([depth, records]) => [depth, records.toSorted(compareByCallOrder)] as const);
  }, [callOrder, pageRecords, props.records]);

  const updateEdges = useCallback(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;
    const surfaceRect = surface.getBoundingClientRect();
    const cardRects = new Map(
      [...cardRefs.current].map(([recordId, card]) => [recordId, card.getBoundingClientRect()]),
    );
    const verticalTrunks = new Map<string, number>();
    for (const record of pageRecords) {
      if (record.parentRecordId === undefined) continue;
      const source = cardRects.get(record.parentRecordId);
      const target = cardRects.get(record.recordId);
      if (source === undefined || target === undefined || target.top < source.bottom) continue;
      const sourceY = source.bottom - surfaceRect.top;
      const targetY = target.top - surfaceRect.top - 10;
      const candidate = sourceY + (targetY - sourceY) / 2;
      verticalTrunks.set(
        record.parentRecordId,
        Math.min(verticalTrunks.get(record.parentRecordId) ?? candidate, candidate),
      );
    }
    const nextEdges = pageRecords.flatMap((record): MissionWorkGridEdge[] => {
      if (record.parentRecordId === undefined) return [];
      const source = cardRects.get(record.parentRecordId);
      const target = cardRects.get(record.recordId);
      if (source === undefined || target === undefined) return [];
      return [
        {
          id: `${record.parentRecordId}:${record.recordId}`,
          path: missionWorkGridEdgePath({
            source,
            target,
            surface: surfaceRect,
            verticalTrunkY: verticalTrunks.get(record.parentRecordId),
          }),
        },
      ];
    });
    setEdges(nextEdges);
  }, [pageRecords]);

  useLayoutEffect(() => {
    updateEdges();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateEdges);
    if (surfaceRef.current !== null) observer.observe(surfaceRef.current);
    for (const card of cardRefs.current.values()) observer.observe(card);
    return () => observer.disconnect();
  }, [levels, updateEdges]);

  return (
    <div
      className={`mission-work-list is-${density}${density === "network" ? "" : " is-sparse"}${pageCount > 1 ? " has-pagination" : ""}`}
    >
      <div className="mission-work-list-header">
        <p className="mission-work-description">{t("executionMapDescription")}</p>
        {pageCount <= 1 ? null : (
          <nav className="mission-work-pagination" aria-label={t("workPagination")}>
            <button
              type="button"
              aria-label={t("previousWorkPage")}
              disabled={pageIndex === 0}
              onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
            >
              <CaretLeft size={15} aria-hidden="true" />
            </button>
            <span>
              {t("workPageSummary", {
                page: pageIndex + 1,
                pages: pageCount,
                count: props.records.length,
              })}
            </span>
            <button
              type="button"
              aria-label={t("nextWorkPage")}
              disabled={pageIndex >= pageCount - 1}
              onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}
            >
              <CaretRight size={15} aria-hidden="true" />
            </button>
          </nav>
        )}
      </div>
      <div
        className="mission-work-grid"
        data-density={density}
        ref={surfaceRef}
        role="list"
        aria-label={t("executionWork")}
      >
        <svg className="mission-work-grid-connections" aria-hidden="true">
          <defs>
            <marker
              id={markerId}
              markerWidth="9"
              markerHeight="9"
              refX="8"
              refY="4.5"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path d="M 0 0 L 9 4.5 L 0 9 Z" />
            </marker>
          </defs>
          {edges.map((edge) => (
            <path
              key={edge.id}
              className="mission-work-grid-connection"
              d={edge.path}
              markerEnd={`url(#${markerId})`}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {levels.map(([depth, records]) => (
          <div className="mission-work-grid-row" key={depth} data-depth={depth} role="presentation">
            {records.map((record) => {
              const title = missionWorkRecordTitle(record);
              const order = callOrder.get(record.recordId);
              const callOrderLabel =
                order === undefined ? undefined : t("workCallOrder", { number: order });
              return (
                <div className="mission-work-grid-item" key={record.recordId} role="listitem">
                  <button
                    className={`mission-work-card is-${record.status}`}
                    ref={(element) => {
                      if (element === null) cardRefs.current.delete(record.recordId);
                      else cardRefs.current.set(record.recordId, element);
                    }}
                    type="button"
                    aria-label={[
                      title,
                      workStatusLabel(record.status, record.waitReason),
                      callOrderLabel,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                    onClick={() => props.onSelect(record.recordId)}
                  >
                    {order === undefined ? null : (
                      <span className="mission-work-call-order" aria-hidden="true">
                        #{order}
                      </span>
                    )}
                    <span className="mission-work-card-avatar">
                      <ProfiledExpertAvatar
                        avatarId={record.avatarId}
                        size={density === "single" ? "lg" : "md"}
                      />
                      <span
                        className={`mission-work-status is-${record.status}`}
                        aria-hidden="true"
                      />
                    </span>
                    <strong>{title}</strong>
                    <small>
                      {workStatusLabel(record.status, record.waitReason)}
                      {record.tasks.length > 1
                        ? ` · ${t("conversationTurns", { count: record.tasks.length })}`
                        : ""}
                    </small>
                    {density === "single" ? (
                      <p className="mission-work-card-summary">{record.summary}</p>
                    ) : null}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function missionWorkPageRecords(
  records: readonly MissionWorkRecord[],
  pageIndex: number,
  pageSize: number,
): MissionWorkRecord[] {
  if (records.length <= pageSize) return [...records];
  const callOrder = missionWorkCallOrder(records);
  const ordered = records.toSorted((left, right) => {
    if (left.parentRecordId === undefined && right.parentRecordId !== undefined) return -1;
    if (right.parentRecordId === undefined && left.parentRecordId !== undefined) return 1;
    const order = (callOrder.get(left.recordId) ?? 0) - (callOrder.get(right.recordId) ?? 0);
    if (order !== 0) return order;
    const created = left.createdAt.localeCompare(right.createdAt);
    return created === 0 ? left.recordId.localeCompare(right.recordId) : created;
  });
  const start = Math.max(0, pageIndex) * pageSize;
  const selected = ordered.slice(start, start + pageSize);
  const byId = new Map(records.map((record) => [record.recordId, record]));
  const included = new Set(selected.map((record) => record.recordId));
  for (const record of selected) {
    let parentId = record.parentRecordId;
    while (parentId !== undefined && !included.has(parentId)) {
      included.add(parentId);
      parentId = byId.get(parentId)?.parentRecordId;
    }
  }
  return ordered.filter((record) => included.has(record.recordId));
}

export function MissionMemoryActivity(props: {
  readonly activity?: DesktopMissionMemoryActivity | undefined;
  readonly error?: string | undefined;
  readonly loading: boolean;
  readonly onBrowseStore: () => void;
}) {
  const { t } = useTranslation("missions");
  if (props.loading)
    return (
      <div className="mission-memory-activity">
        <MissionMemoryActivityHeader onBrowseStore={props.onBrowseStore} />
        <div className="mission-memory-empty">{t("memoryActivityLoading")}</div>
      </div>
    );
  if (props.error !== undefined) {
    return (
      <div className="mission-memory-activity">
        <MissionMemoryActivityHeader onBrowseStore={props.onBrowseStore} />
        <div className="mission-memory-empty" role="alert">
          <WarningCircle size={31} weight="thin" aria-hidden="true" />
          <h2>{t("memoryActivityUnavailable")}</h2>
          <p>{props.error}</p>
        </div>
      </div>
    );
  }
  if (props.activity === undefined || props.activity.executions.length === 0) {
    return (
      <div className="mission-memory-activity">
        <MissionMemoryActivityHeader onBrowseStore={props.onBrowseStore} />
        <div className="mission-memory-empty">
          <CheckCircle size={31} weight="thin" aria-hidden="true" />
          <h2>{t("noMemoryActivity")}</h2>
          <p>{t("noMemoryActivityDescription")}</p>
        </div>
      </div>
    );
  }
  const totals = props.activity.executions.reduce(
    (current, execution) => ({
      evidence: current.evidence + execution.capture.published,
      recall:
        current.recall + execution.recall.list + execution.recall.search + execution.recall.read,
      attention:
        current.attention +
        execution.capture.failed +
        execution.recall.denied +
        execution.recall.failed,
    }),
    { evidence: 0, recall: 0, attention: 0 },
  );
  return (
    <div className="mission-memory-activity">
      <MissionMemoryActivityHeader onBrowseStore={props.onBrowseStore} />
      <dl className="mission-memory-summary" aria-label={t("memoryActivitySummary")}>
        <div>
          <dt>{t("memoryCapturedShort")}</dt>
          <dd>{totals.evidence}</dd>
          <small>{t("memoryCapturedClarification")}</small>
        </div>
        <div>
          <dt>{t("memoryRecallOperations")}</dt>
          <dd>{totals.recall}</dd>
          <small>{t("memoryRecallOperationsDescription")}</small>
        </div>
        <div className={totals.attention > 0 ? "is-warning" : ""}>
          <dt>{t("memoryNeedsAttention")}</dt>
          <dd>{totals.attention}</dd>
          <small>{t("memoryNeedsAttentionDescription")}</small>
        </div>
      </dl>
      <section className="mission-memory-executions" aria-label={t("memoryExecutionActivity")}>
        <header>
          <h3>{t("memoryExecutionActivity")}</h3>
          <span>{t("memoryExecutionCount", { count: props.activity.executions.length })}</span>
        </header>
        {props.activity.executions.map((execution, index) => (
          <article key={execution.executionId}>
            <header>
              <div>
                <strong>{t("memoryExecutionNumber", { number: index + 1 })}</strong>
                <code>{execution.executionId}</code>
              </div>
              {execution.capture.failed + execution.recall.denied + execution.recall.failed > 0 ? (
                <span className="mission-memory-attention-badge">{t("memoryNeedsAttention")}</span>
              ) : (
                <span className="mission-memory-success-badge">{t("memoryActivityHealthy")}</span>
              )}
            </header>
            <div className="mission-memory-groups">
              <section>
                <h4>{t("memoryCaptureGroup")}</h4>
                <dl>
                  <div>
                    <dt>{t("memoryCapturedShort")}</dt>
                    <dd>{execution.capture.published}</dd>
                  </div>
                  <div>
                    <dt>{t("memorySkipped")}</dt>
                    <dd>{execution.capture.skipped}</dd>
                  </div>
                  <div className={execution.capture.failed > 0 ? "is-warning" : ""}>
                    <dt>{t("memoryCaptureFailed")}</dt>
                    <dd>{execution.capture.failed}</dd>
                  </div>
                </dl>
              </section>
              <section>
                <h4>{t("memoryRecallGroup")}</h4>
                <dl>
                  <div>
                    <dt>{t("memoryListed")}</dt>
                    <dd>{execution.recall.list}</dd>
                  </div>
                  <div>
                    <dt>{t("memorySearched")}</dt>
                    <dd>{execution.recall.search}</dd>
                  </div>
                  <div>
                    <dt>{t("memoryRead")}</dt>
                    <dd>{execution.recall.read}</dd>
                  </div>
                  <div className={execution.recall.denied > 0 ? "is-warning" : ""}>
                    <dt>{t("memoryRecallDenied")}</dt>
                    <dd>{execution.recall.denied}</dd>
                  </div>
                  <div className={execution.recall.failed > 0 ? "is-warning" : ""}>
                    <dt>{t("memoryRecallFailed")}</dt>
                    <dd>{execution.recall.failed}</dd>
                  </div>
                </dl>
              </section>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}

function MissionMemoryActivityHeader(props: { readonly onBrowseStore: () => void }) {
  const { t } = useTranslation("missions");
  return (
    <header className="mission-memory-activity-header">
      <div>
        <h2>{t("memoryActivity")}</h2>
        <p>{t("memoryActivityDescription")}</p>
      </div>
      <button type="button" onClick={props.onBrowseStore}>
        <Database size={17} aria-hidden="true" />
        {t("browseMemoryStore")}
      </button>
    </header>
  );
}

function MissionUsageHint(props: {
  readonly missionId: string;
  readonly executionActive: boolean;
}) {
  const { t } = useTranslation("usage");
  const [usageState, setUsageState] = useState<MissionUsageHintState>({
    revision: -1,
    totalTokens: 0,
  });
  const executionActiveRef = useRef(props.executionActive);
  const previousExecutionRef = useRef({
    missionId: props.missionId,
    active: props.executionActive,
  });
  executionActiveRef.current = props.executionActive;

  useEffect(() => {
    let active = true;
    setUsageState({ revision: -1, totalTokens: 0 });
    const refresh = async (): Promise<void> => {
      const result = await window.pragmaDesktop.getMissionUsage(props.missionId);
      if (active) {
        setUsageState((current) =>
          applyMissionUsageHintRevision(current, {
            revision: result.revision,
            totalTokens: result.usage.totalTokens,
          }),
        );
      }
    };
    void refresh().catch(() => undefined);
    const unsubscribe = window.pragmaDesktop.subscribeUsageUpdates((update) => {
      if (update.missionId !== props.missionId) return;
      if (executionActiveRef.current || update.provisional === true) return;
      if (update.missionUsage !== undefined) {
        setUsageState((current) =>
          applyMissionUsageHintRevision(current, {
            revision: update.revision,
            totalTokens: update.missionUsage!.totalTokens,
          }),
        );
        return;
      }
      void refresh().catch(() => undefined);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [props.missionId]);

  useEffect(() => {
    const previous = previousExecutionRef.current;
    previousExecutionRef.current = {
      missionId: props.missionId,
      active: props.executionActive,
    };
    if (previous.missionId !== props.missionId || !previous.active || props.executionActive) {
      return;
    }
    void window.pragmaDesktop
      .getMissionUsage(props.missionId)
      .then((result) => {
        setUsageState((current) =>
          applyMissionUsageHintRevision(current, {
            revision: result.revision,
            totalTokens: result.usage.totalTokens,
          }),
        );
      })
      .catch(() => undefined);
  }, [props.executionActive, props.missionId]);

  if (usageState.totalTokens === 0) return null;

  return (
    <small className="mission-usage-hint" aria-live="polite">
      {t("missionHint", { tokens: formatTokens(usageState.totalTokens) })}
    </small>
  );
}

interface MissionUsageHintState {
  readonly revision: number;
  readonly totalTokens: number;
}

export function applyMissionUsageHintRevision(
  current: MissionUsageHintState,
  next: MissionUsageHintState,
): MissionUsageHintState {
  return next.revision < current.revision ? current : next;
}

export function ContextWindowControl(props: {
  readonly state: MissionContextWindowState;
  readonly compacting: boolean;
  readonly onCompact: () => void;
}) {
  const { t } = useTranslation("missions");
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const popoverId = useId();
  const popoverLabelId = useId();
  const usage = props.state.usage;
  const percent = usage?.percent ?? null;
  const boundedPercent = Math.max(0, Math.min(100, percent ?? 0));
  const invalidUsage =
    usage !== undefined &&
    ((usage.usedTokens !== null && usage.usedTokens > usage.contextWindowTokens) ||
      (usage.percent !== null && usage.percent > 100));
  const percentText =
    percent === null
      ? t("contextUnknown")
      : t("contextPercentValue", {
          value: new Intl.NumberFormat(i18n.language, {
            maximumFractionDigits: 1,
          }).format(boundedPercent),
        });
  const tokenFormatter = new Intl.NumberFormat(i18n.language);
  const tone = boundedPercent >= 90 ? "is-critical" : boundedPercent >= 70 ? "is-warning" : "";
  const usageLabel = t("contextWindowUsage", { value: percentText });
  const accessibleUsageLabel = [
    usageLabel,
    invalidUsage ? t("contextUsageInvalid") : undefined,
    props.state.compactionBlockedReason === "not_ready"
      ? t("contextCompactionNotReady")
      : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  const cancelScheduledClose = () => {
    if (closeTimerRef.current === undefined) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = undefined;
  };
  const scheduleClose = () => {
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = undefined;
      setOpen(false);
    }, CONTEXT_POPOVER_CLOSE_DELAY_MS);
  };

  useEffect(
    () => () => {
      if (closeTimerRef.current !== undefined) clearTimeout(closeTimerRef.current);
    },
    [],
  );

  return (
    <div
      className={`mission-context-window ${tone}`}
      onMouseEnter={() => {
        cancelScheduledClose();
        setOpen(true);
      }}
      onMouseLeave={(event) => {
        if (!event.currentTarget.matches(":focus-within")) scheduleClose();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          cancelScheduledClose();
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          cancelScheduledClose();
          setOpen(false);
        }
      }}
    >
      <button
        className="mission-context-trigger"
        type="button"
        aria-label={accessibleUsageLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={popoverId}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen((current) => !current)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle className="mission-context-track" cx="12" cy="12" r="8.5" pathLength="100" />
          <circle
            className="mission-context-progress"
            cx="12"
            cy="12"
            r="8.5"
            pathLength="100"
            strokeDasharray="100"
            strokeDashoffset={100 - boundedPercent}
          />
        </svg>
        {invalidUsage ? (
          <span className="mission-context-warning-badge" aria-hidden="true">
            !
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className="mission-context-popover"
          id={popoverId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={popoverLabelId}
        >
          <div className="mission-context-heading">
            <strong id={popoverLabelId}>{t("contextWindow")}</strong>
            <span>{percentText}</span>
          </div>
          {invalidUsage ? (
            <p className="mission-context-invalid" role="alert">
              <WarningCircle size={15} weight="fill" aria-hidden="true" />
              {t("contextUsageInvalid")}
            </p>
          ) : null}
          <dl>
            <div>
              <dt>{t("contextCurrent")}</dt>
              <dd>
                {usage?.usedTokens === null || usage === undefined
                  ? t("contextUnknown")
                  : tokenFormatter.format(usage.usedTokens)}
              </dd>
            </div>
            <div>
              <dt>{t("contextTotal")}</dt>
              <dd>
                {usage === undefined
                  ? t("contextUnknown")
                  : tokenFormatter.format(usage.contextWindowTokens)}
              </dd>
            </div>
          </dl>
          <button
            className="mission-context-compact"
            type="button"
            disabled={!props.state.canCompact || props.compacting}
            onClick={props.onCompact}
          >
            {props.compacting ? <SpinnerGap className="spin" size={15} aria-hidden="true" /> : null}
            {props.compacting ? t("contextCompacting") : t("contextCompact")}
          </button>
          {props.state.compactionBlockedReason === "not_ready" ? (
            <p className="mission-context-compact-hint">{t("contextCompactionNotReady")}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const CONTEXT_POPOVER_CLOSE_DELAY_MS = 500;

function MissionErrorBanner(props: {
  readonly error: string;
  readonly actionLabel?: string | undefined;
  readonly onAction?: (() => void) | undefined;
  readonly onDismiss: () => void;
}) {
  const { t } = useTranslation("common");
  return (
    <div className="mission-page-error" role="alert">
      <span>{props.error}</span>
      <div className="mission-error-actions">
        {props.actionLabel !== undefined && props.onAction !== undefined ? (
          <button className="mission-error-action" type="button" onClick={props.onAction}>
            {props.actionLabel}
          </button>
        ) : null}
        <button
          className="mission-error-dismiss"
          type="button"
          aria-label={t("actions.close")}
          title={t("actions.close")}
          onClick={props.onDismiss}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function unavailableMcpToolName(error: string): string | undefined {
  return /MCP tool ([A-Za-z0-9_-]+) is not currently available\./.exec(error)?.[1];
}

export function MissionWorkDrawer(props: {
  readonly record: MissionWorkRecord;
  readonly inputSenderName: string;
  readonly entries: readonly MissionChatEntry[];
  readonly loading: boolean;
  readonly onLoadEarlier?: (() => void | Promise<void>) | undefined;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation(["missions", "common"]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);
  const prependScrollHeightRef = useRef<number | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const conversationBlocks = useMemo(
    () =>
      groupMissionConversationEntries(
        props.entries.map((entry) => ({ type: "durable" as const, entry })),
      ),
    [props.entries],
  );
  const lastEntry = props.entries.at(-1);
  const conversationFingerprint =
    lastEntry === undefined
      ? "empty"
      : `${lastEntry.id}:${lastEntry.kind}:${entryContentLength(lastEntry)}`;

  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll === null) return;
    if (prependScrollHeightRef.current !== null) {
      scroll.scrollTop += scroll.scrollHeight - prependScrollHeightRef.current;
      prependScrollHeightRef.current = null;
      setShowJumpToLatest(true);
      return;
    }
    if (followLatestRef.current) {
      scroll.scrollTop = scroll.scrollHeight;
      setShowJumpToLatest(false);
    } else {
      setShowJumpToLatest(true);
    }
  }, [conversationFingerprint, props.entries.length]);

  const loadEarlier = async (): Promise<void> => {
    const scroll = scrollRef.current;
    prependScrollHeightRef.current = scroll?.scrollHeight ?? null;
    followLatestRef.current = false;
    try {
      await props.onLoadEarlier?.();
    } finally {
      requestAnimationFrame(() => {
        const current = scrollRef.current;
        const previousHeight = prependScrollHeightRef.current;
        if (current !== null && previousHeight !== null) {
          current.scrollTop += current.scrollHeight - previousHeight;
        }
        prependScrollHeightRef.current = null;
        setShowJumpToLatest(true);
      });
    }
  };

  return (
    <div className="mission-work-drawer-layer" role="presentation">
      <button
        className="mission-work-drawer-scrim"
        type="button"
        aria-label={t("actions.close", { ns: "common" })}
        onClick={props.onClose}
      />
      <aside
        className="mission-work-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mission-work-drawer-title"
      >
        <header>
          <div>
            <small>{t("agentConversation", { ns: "missions" })}</small>
            <h2 id="mission-work-drawer-title">{missionWorkRecordTitle(props.record)}</h2>
            <p>
              {workStatusLabel(props.record.status, props.record.waitReason)} ·{" "}
              {t("readOnlyConversation", { ns: "missions" })}
              {props.record.status === "running" || props.record.status === "waiting" ? (
                <span className="mission-work-streaming">
                  <SpinnerGap size={13} aria-hidden="true" />
                  {t("streaming", { ns: "missions" })}
                </span>
              ) : null}
            </p>
          </div>
          <button
            type="button"
            aria-label={t("actions.close", { ns: "common" })}
            onClick={props.onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="mission-work-drawer-body">
          <div
            className="mission-chat-scroll mission-work-conversation-scroll"
            ref={scrollRef}
            aria-live="polite"
            onScroll={(event) => {
              const element = event.currentTarget;
              const nearBottom =
                element.scrollHeight - element.scrollTop - element.clientHeight < 72;
              followLatestRef.current = nearBottom;
              if (nearBottom) setShowJumpToLatest(false);
            }}
          >
            <div className="mission-chat-list mission-work-conversation-list">
              {props.onLoadEarlier === undefined ? null : (
                <button
                  className="mission-load-earlier"
                  type="button"
                  disabled={props.loading}
                  onClick={() => void loadEarlier()}
                >
                  {props.loading
                    ? t("loadingEarlier", { ns: "missions" })
                    : t("loadEarlier", { ns: "missions" })}
                </button>
              )}
              {props.loading && props.entries.length === 0 ? (
                <p className="mission-work-conversation-empty">
                  <SpinnerGap size={14} aria-hidden="true" />
                  {t("streaming", { ns: "missions" })}
                </p>
              ) : props.entries.length === 0 ? (
                <p className="mission-work-conversation-empty">
                  {t("waitingForAgentConversation", { ns: "missions" })}
                </p>
              ) : (
                conversationBlocks.map((block) => {
                  if (block.type === "tools") {
                    return (
                      <MissionToolCallBlock
                        collapsed={block.collapsed}
                        entries={block.entries}
                        key={`tools:${block.entries[0]!.id}`}
                      />
                    );
                  }
                  return block.item.type === "durable" ? (
                    <MissionChatEntryView
                      entry={block.item.entry}
                      key={block.item.entry.id}
                      userLabel={props.inputSenderName}
                    />
                  ) : null;
                })
              )}
            </div>
            {showJumpToLatest ? (
              <button
                className="mission-jump-latest"
                type="button"
                onClick={() => {
                  const scroll = scrollRef.current;
                  if (scroll !== null) scroll.scrollTop = scroll.scrollHeight;
                  followLatestRef.current = true;
                  setShowJumpToLatest(false);
                }}
              >
                <CaretDown size={15} aria-hidden="true" />
                {t("jumpLatest", { ns: "missions" })}
              </button>
            ) : null}
          </div>
        </div>
      </aside>
    </div>
  );
}

export type MissionHumanQuestion = NonNullable<
  MissionHumanInteraction["request"]["questions"]
>[number];

function MissionHumanComposer(props: {
  readonly interaction: MissionHumanInteraction;
  readonly answers: Readonly<Record<string, string | readonly string[]>>;
  readonly customAnswers: Readonly<Record<string, string>>;
  readonly notes: string;
  readonly questionNotes: Readonly<Record<string, string>>;
  readonly questionIndex: number;
  readonly interactionPosition: { readonly current: number; readonly total: number };
  readonly responding: boolean;
  readonly interruptible: boolean;
  readonly interrupting: boolean;
  readonly onQuestionIndex: (index: number) => void;
  readonly onAnswer: (question: string, value: string | readonly string[]) => void;
  readonly onCustomAnswer: (question: string, value: string) => void;
  readonly onNotes: (value: string) => void;
  readonly onQuestionNote: (question: string, value: string) => void;
  readonly onRespond: (response: HumanInteractionResponse) => void;
  readonly onInterrupt: () => void;
}) {
  const { t } = useTranslation("missions");
  const [visibleQuestionNotes, setVisibleQuestionNotes] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const request = props.interaction.request;
  const questions = request.questions ?? [];
  const index = Math.min(props.questionIndex, Math.max(questions.length - 1, 0));
  const question = questions[index];
  const answer = question === undefined ? undefined : props.answers[question.question];
  const customAnswer = question === undefined ? "" : (props.customAnswers[question.question] ?? "");
  const questionNote = question === undefined ? "" : (props.questionNotes[question.question] ?? "");
  const questionNoteVisible =
    question !== undefined && (visibleQuestionNotes.has(question.question) || questionNote !== "");
  const isLastQuestion = index === questions.length - 1;
  const currentAnswerValid =
    question !== undefined &&
    hasValidMissionHumanAnswer(question, props.answers, props.customAnswers);
  const heading =
    question?.question ?? request.title ?? t("humanInputRequired", { ns: "missions" });
  const helperText =
    question === undefined
      ? (request.prompt ?? t("humanReview", { ns: "missions" }))
      : request.prompt === undefined || request.prompt === question.question
        ? undefined
        : request.prompt;

  return (
    <section className="mission-human-composer" aria-labelledby="mission-human-title">
      <header>
        <div className="mission-human-heading">
          {question === undefined ? (
            <small>
              {t("userInputPosition", {
                ns: "missions",
                current: props.interactionPosition.current,
                total: props.interactionPosition.total,
              })}
            </small>
          ) : (
            <small>{question.header}</small>
          )}
          <strong id="mission-human-title">{heading}</strong>
          {helperText === undefined ? null : <p>{helperText}</p>}
        </div>
        <div className="mission-human-header-actions">
          {request.kind !== "approval" && question !== undefined && questions.length > 1 ? (
            <div
              className="mission-human-question-navigation"
              aria-label={t("questionNavigation", { ns: "missions" })}
            >
              <button
                type="button"
                aria-label={t("previousQuestion", { ns: "missions" })}
                title={t("previousQuestion", { ns: "missions" })}
                disabled={index === 0 || props.responding}
                onClick={() => props.onQuestionIndex(index - 1)}
              >
                <CaretLeft size={16} aria-hidden="true" />
              </button>
              <span aria-live="polite">
                {t("questionProgress", {
                  ns: "missions",
                  current: index + 1,
                  total: questions.length,
                })}
              </span>
              <button
                type="button"
                aria-label={t("nextQuestion", { ns: "missions" })}
                title={t("nextQuestion", { ns: "missions" })}
                disabled={index === questions.length - 1 || props.responding}
                onClick={() => props.onQuestionIndex(index + 1)}
              >
                <CaretRight size={16} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          <button
            className="mission-human-interrupt"
            type="button"
            aria-label={t("interrupt", { ns: "missions" })}
            title={t("interrupt", { ns: "missions" })}
            disabled={!props.interruptible || props.interrupting}
            onClick={props.onInterrupt}
          >
            <StopCircle size={20} weight="fill" aria-hidden="true" />
          </button>
        </div>
      </header>
      {request.kind === "approval" ? (
        <>
          {request.data === undefined ? null : <pre>{formatInteractionData(request.data)}</pre>}
          <textarea
            value={props.notes}
            onChange={(event) => props.onNotes(event.target.value)}
            placeholder={t("optionalNotes", { ns: "missions" })}
          />
          <footer>
            <button
              type="button"
              disabled={props.responding}
              onClick={() =>
                props.onRespond({
                  approved: false,
                  decision: "rejected",
                  notes: props.notes,
                })
              }
            >
              {t("reject", { ns: "missions" })}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={props.responding}
              onClick={() =>
                props.onRespond({
                  approved: true,
                  decision: "approved",
                  notes: props.notes,
                })
              }
            >
              {props.responding
                ? t("submitting", { ns: "missions" })
                : t("approveContinue", { ns: "missions" })}
            </button>
          </footer>
        </>
      ) : question === undefined ? (
        <footer>
          <button
            className="primary-button"
            type="button"
            disabled={props.responding}
            onClick={() => props.onRespond({ notes: props.notes })}
          >
            {t("continue", { ns: "missions" })}
          </button>
        </footer>
      ) : (
        <>
          <div className="mission-human-question">
            <HumanQuestionInput
              question={question}
              answer={answer}
              customAnswer={customAnswer}
              onAnswer={(value) => props.onAnswer(question.question, value)}
              onCustomAnswer={(value) => props.onCustomAnswer(question.question, value)}
            />
          </div>
          {questionNoteVisible ? (
            <textarea
              value={questionNote}
              onChange={(event) => props.onQuestionNote(question.question, event.target.value)}
              placeholder={t("optionalNotes", { ns: "missions" })}
            />
          ) : null}
          <footer>
            {questionNoteVisible ? null : (
              <button
                className="mission-human-add-note"
                type="button"
                disabled={props.responding}
                onClick={() =>
                  setVisibleQuestionNotes((current) => new Set([...current, question.question]))
                }
              >
                <Plus size={16} aria-hidden="true" />
                {t("addNote", { ns: "missions" })}
              </button>
            )}
            <button
              className="primary-button"
              type="button"
              disabled={!currentAnswerValid || props.responding}
              onClick={() => {
                if (!isLastQuestion) {
                  props.onQuestionIndex(index + 1);
                  return;
                }
                const notes = formatMissionHumanQuestionNotes(questions, props.questionNotes);
                props.onRespond({
                  answers: mergeMissionHumanAnswers(props.answers, props.customAnswers),
                  ...(notes === "" ? {} : { notes }),
                });
              }}
            >
              {props.responding
                ? t("submitting", { ns: "missions" })
                : isLastQuestion
                  ? t("confirmContinue", { ns: "missions" })
                  : t("nextQuestion", { ns: "missions" })}
            </button>
          </footer>
        </>
      )}
    </section>
  );
}

function HumanQuestionInput(props: {
  readonly question: MissionHumanQuestion;
  readonly answer: string | readonly string[] | undefined;
  readonly customAnswer: string;
  readonly onAnswer: (value: string | readonly string[]) => void;
  readonly onCustomAnswer: (value: string) => void;
}) {
  const { t } = useTranslation("missions");
  if (props.question.kind === "text") {
    return (
      <textarea
        value={typeof props.answer === "string" ? props.answer : ""}
        onChange={(event) => props.onAnswer(event.target.value)}
        aria-labelledby="mission-human-title"
        autoFocus
      />
    );
  }
  if (props.question.kind === "single_choice") {
    return (
      <>
        <div className="mission-human-options">
          {props.question.options.map((option) => {
            const selected = props.answer === option.label;
            return (
              <button
                className={selected ? "is-selected" : ""}
                type="button"
                aria-pressed={selected}
                key={option.label}
                onClick={() => props.onAnswer(option.label)}
              >
                <span className="mission-human-option-copy">
                  <strong>{option.label}</strong>
                  {option.description === "" ? null : <small>{option.description}</small>}
                </span>
                {selected ? (
                  <CheckCircle
                    className="mission-human-option-state"
                    size={18}
                    weight="fill"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
        <HumanCustomAnswerInput
          value={props.customAnswer}
          onChange={props.onCustomAnswer}
          label={t("customAnswer")}
          placeholder={t("customAnswerPlaceholder")}
        />
      </>
    );
  }
  const selected = Array.isArray(props.answer) ? props.answer : [];
  return (
    <>
      <div className="mission-human-options is-multiple">
        {props.question.options.map((option) => {
          const optionSelected = selected.includes(option.label);
          return (
            <label className={optionSelected ? "is-selected" : ""} key={option.label}>
              <input
                type="checkbox"
                checked={optionSelected}
                onChange={(event) =>
                  props.onAnswer(
                    event.target.checked
                      ? [...selected, option.label]
                      : selected.filter((value) => value !== option.label),
                  )
                }
              />
              <span className="mission-human-option-copy">
                <strong>{option.label}</strong>
                {option.description === "" ? null : <small>{option.description}</small>}
              </span>
            </label>
          );
        })}
      </div>
      <HumanCustomAnswerInput
        value={props.customAnswer}
        onChange={props.onCustomAnswer}
        label={t("customAnswer")}
        placeholder={t("customAnswerPlaceholder")}
      />
    </>
  );
}

function HumanCustomAnswerInput(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly label: string;
  readonly placeholder: string;
}) {
  return (
    <label className="mission-human-custom-answer">
      <span>{props.label}</span>
      <input
        type="text"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
      />
    </label>
  );
}

function humanAnswerValid(
  question: MissionHumanQuestion,
  answer: string | readonly string[] | undefined,
  customAnswer: string | undefined,
): boolean {
  if (question.kind !== "text" && customAnswer !== undefined && customAnswer.trim() !== "") {
    return true;
  }
  if (question.kind === "multiple_choice") return Array.isArray(answer) && answer.length > 0;
  return typeof answer === "string" && answer.trim() !== "";
}

export function hasValidMissionHumanAnswers(
  questions: readonly MissionHumanQuestion[],
  answers: Readonly<Record<string, string | readonly string[]>>,
  customAnswers: Readonly<Record<string, string>>,
): boolean {
  return questions.every((question) =>
    hasValidMissionHumanAnswer(question, answers, customAnswers),
  );
}

export function hasValidMissionHumanAnswer(
  question: MissionHumanQuestion,
  answers: Readonly<Record<string, string | readonly string[]>>,
  customAnswers: Readonly<Record<string, string>>,
): boolean {
  return humanAnswerValid(question, answers[question.question], customAnswers[question.question]);
}

export function mergeMissionHumanAnswers(
  answers: Readonly<Record<string, string | readonly string[]>>,
  customAnswers: Readonly<Record<string, string>>,
): Record<string, string | readonly string[]> {
  const merged = { ...answers };
  for (const [question, customAnswer] of Object.entries(customAnswers)) {
    if (customAnswer.trim() !== "") merged[question] = customAnswer;
  }
  return merged;
}

export function formatMissionHumanQuestionNotes(
  questions: readonly MissionHumanQuestion[],
  notes: Readonly<Record<string, string>>,
): string {
  return questions
    .flatMap((question) => {
      const note = notes[question.question]?.trim();
      return note === undefined || note === "" ? [] : [`${question.question}\n${note}`];
    })
    .join("\n\n");
}

function entryContentLength(entry: MissionChatEntry): number {
  if (entry.kind === "tool") {
    return (entry.inputPreview?.length ?? 0) + (entry.outputPreview?.length ?? 0);
  }
  if (entry.kind === "agent_activity") return entry.label?.length ?? 0;
  if (entry.kind === "context_operation") return entry.error?.length ?? 0;
  return entry.content.length;
}

function missionFooterTip(mission: Mission, chat: MissionChatSnapshot | null): string | null {
  if (mission.lifecycleStatus === "completed") {
    return i18n.t("reopenToContinue", { ns: "missions" });
  }
  const execution = chat?.execution ?? mission.execution;
  if (execution === undefined) return null;
  if (execution.status === "failed")
    return execution.error ?? i18n.t("executionFailed", { ns: "missions" });
  if (execution.status === "cancelled") {
    return i18n.t("executionInterrupted", { ns: "missions" });
  }
  if (
    ["queued", "running", "waiting"].includes(execution.status) &&
    chat?.execution?.interruptible === false
  ) {
    return i18n.t("resumeBeforeInterrupt", { ns: "missions" });
  }
  return null;
}

function formatInteractionData(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function workRecordDepth(record: MissionWorkRecord, records: readonly MissionWorkRecord[]): number {
  const byKey = new Map(records.map((candidate) => [candidate.recordId, candidate]));
  let depth = 0;
  let parentKey = record.parentRecordId;
  const visited = new Set<string>();
  while (parentKey !== undefined && !visited.has(parentKey)) {
    visited.add(parentKey);
    depth += 1;
    parentKey = byKey.get(parentKey)?.parentRecordId;
  }
  return Math.min(depth, 6);
}

export function missionWorkRecordTitle(record: MissionWorkRecord): string {
  if (record.fallbackOrdinal === undefined) return record.title;
  return i18n.t("runtimeAgentFallbackName", {
    ns: "missions",
    number: record.fallbackOrdinal,
  });
}

export function missionWorkInputSenderName(
  record: MissionWorkRecord,
  records: readonly MissionWorkRecord[],
): string {
  if (record.parentRecordId === undefined) {
    return record.kind === "root"
      ? i18n.t("you", { ns: "missions" })
      : i18n.t("mainAgent", { ns: "missions" });
  }
  const parent = records.find((candidate) => candidate.recordId === record.parentRecordId);
  return parent === undefined
    ? i18n.t("mainAgent", { ns: "missions" })
    : missionWorkRecordTitle(parent);
}

export function workStatusLabel(
  status: MissionWorkRecord["status"],
  waitReason?: MissionWorkRecord["waitReason"],
): string {
  switch (status) {
    case "queued":
      return i18n.t("statusQueued", { ns: "missions" });
    case "running":
      return i18n.t("statusWorking", { ns: "missions" });
    case "waiting":
      return waitReason === "experts"
        ? i18n.t("statusWaitingExperts", { ns: "missions" })
        : waitReason === "human_input"
          ? i18n.t("statusNeedsInput", { ns: "missions" })
          : i18n.t("statusWaiting", { ns: "missions" });
    case "succeeded":
      return i18n.t("statusSucceeded", { ns: "missions" });
    case "failed":
      return i18n.t("statusFailed", { ns: "missions" });
    case "cancelled":
    case "interrupted":
      return i18n.t("statusCancelled", { ns: "missions" });
  }
}

export function missionStatusLabel(mission: Mission | MissionSummary, preparing = false): string {
  if (mission.lifecycleStatus === "completed") return i18n.t("statusCompleted", { ns: "missions" });
  if (
    preparing &&
    (mission.execution === undefined ||
      !["queued", "running", "waiting"].includes(mission.execution.status))
  ) {
    return i18n.t("statusPreparing", { ns: "missions" });
  }
  switch (mission.execution?.status) {
    case "queued":
      return i18n.t("statusQueued", { ns: "missions" });
    case "running":
      return i18n.t("statusWorking", { ns: "missions" });
    case "waiting":
      return mission.execution.waitReason === "experts"
        ? i18n.t("statusWaitingExperts", { ns: "missions" })
        : mission.execution.waitReason === "human_input"
          ? i18n.t("statusNeedsInput", { ns: "missions" })
          : i18n.t("statusWaiting", { ns: "missions" });
    case "succeeded":
      return i18n.t("statusSucceeded", { ns: "missions" });
    case "failed":
      return i18n.t("statusFailed", { ns: "missions" });
    case "cancelled":
      return i18n.t("statusCancelled", { ns: "missions" });
    default:
      return i18n.t("statusReady", { ns: "missions" });
  }
}

function missionListSourceForMission(mission: Mission): MissionListSource {
  return ["automation", "system-store-revision"].includes(mission.origin.type)
    ? "automation"
    : "task";
}

export function missionListSourceForSummary(mission: MissionSummary): MissionListSource {
  return mission.source.type === "task" ? "task" : "automation";
}

function missionToSummary(
  mission: Mission,
  source: MissionSummary["source"] = mission.origin.type === "automation"
    ? { type: "automation", automationRef: mission.origin.automationRef }
    : mission.origin.type === "system-store-revision"
      ? {
          type: "managed-automation",
          kind: "knowledge-revision",
          jobId: mission.origin.jobId,
          storeId: mission.origin.storeId,
        }
      : { type: "task" },
): MissionSummary {
  return {
    id: mission.id,
    title: mission.title,
    workspace: { basename: mission.workspace.basename },
    executor: { kind: mission.executor.kind, name: mission.executor.name },
    ...(mission.execution === undefined ? {} : { execution: { status: mission.execution.status } }),
    source,
    lifecycleStatus: mission.lifecycleStatus,
    updatedAt: mission.updatedAt,
  };
}

export function upsertMissionSummary(
  missions: readonly MissionSummary[],
  updated: MissionSummary,
): MissionSummary[] {
  const current = missions.find((mission) => mission.id === updated.id);
  if (current !== undefined && current.updatedAt > updated.updatedAt) return [...missions];
  return [...missions.filter((mission) => mission.id !== updated.id), updated].toSorted(
    (left, right) => right.updatedAt.localeCompare(left.updatedAt),
  );
}

function setHumanAnswer(
  update: Dispatch<SetStateAction<Record<string, Record<string, string | readonly string[]>>>>,
  interactionId: string,
  question: string,
  value: string | readonly string[] | undefined,
): void {
  update((current) => {
    const answers = { ...current[interactionId] };
    if (value === undefined) delete answers[question];
    else answers[question] = value;
    const next = { ...current };
    if (Object.keys(answers).length === 0) delete next[interactionId];
    else next[interactionId] = answers;
    return next;
  });
}

function setHumanCustomAnswer(
  update: Dispatch<SetStateAction<Record<string, Record<string, string>>>>,
  interactionId: string,
  question: string,
  value: string,
): void {
  update((current) => {
    const answers = { ...current[interactionId] };
    if (value === "") delete answers[question];
    else answers[question] = value;
    const next = { ...current };
    if (Object.keys(answers).length === 0) delete next[interactionId];
    else next[interactionId] = answers;
    return next;
  });
}

function setHumanQuestionNote(
  update: Dispatch<SetStateAction<Record<string, Record<string, string>>>>,
  interactionId: string,
  question: string,
  value: string,
): void {
  update((current) => {
    const notes = { ...current[interactionId] };
    if (value === "") delete notes[question];
    else notes[question] = value;
    const next = { ...current };
    if (Object.keys(notes).length === 0) delete next[interactionId];
    else next[interactionId] = notes;
    return next;
  });
}

function desktopApi(): PragmaDesktopAPI | undefined {
  return typeof window === "undefined" ? undefined : window.pragmaDesktop;
}
