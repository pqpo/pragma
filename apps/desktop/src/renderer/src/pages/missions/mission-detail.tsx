import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  CaretDown,
  CheckCircle,
  DotsThreeVertical,
  Folder,
  FolderOpen,
  GitBranch,
  Play,
  ArrowBendUpLeft,
  Stop,
  SpinnerGap,
  TerminalWindow,
  Trash,
  User,
  UsersThree,
  WarningCircle,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ExpertPromptAttachment } from "@pragma/shared";
import { ConfirmationDialog } from "../../components/Dialog.tsx";
import { StudioActionButton } from "../../components/StudioActionButton.tsx";
import {
  type Mission,
  type ContextStore,
  type MissionContextMount,
  type MissionChatEntry,
  type MissionConversationSnapshot,
  type MissionWorkRecord,
  type DesktopMissionMemoryActivity,
  type DesktopToolPermissionMode,
  type ExpertMentionCandidate,
  type MissionMentionCandidates,
  type MissionModelOverride,
  latestMissionBranchableReply,
} from "../../../../shared/contracts/index.ts";
import { localizedMissionError } from "../../lib/mission-errors.ts";
import {
  createMissionSendAttempt,
  mergeMissionQueuedMessages,
  useMissionCommandDelivery,
  type LocalMissionUserMessage,
} from "./mission-command-delivery.ts";
import {
  groupMissionConversationEntries,
  hideInterruptedExecutionFallbackEntries,
  hideQueuedChatEntries,
  mergeLatestChatPage,
  missionTurnFinalReplyIds,
  orderMissionConversationEntries,
  readyPendingQueuedRequestIds,
  shouldClearMissionThinkingPlaceholder,
  shouldShowMissionThinkingPlaceholder,
  teamCoordinatorChatEntries,
} from "./mission-conversation-model.ts";
import { useMissionClientOperation } from "./mission-client-operation.ts";
import {
  MissionChatComposer,
  recoverFailedMissionSend,
  type MissionComposerHandle,
} from "./mission-chat-composer.tsx";
import {
  replaceMissionComposerSnapshotDraft,
  type MissionComposerRecoveryConsumeReason,
  type MissionComposerRecoveryWriteReason,
  type MissionComposerSnapshot,
} from "./mission-composer-recovery.ts";
import { useMissionWork } from "./use-mission-work.ts";
import {
  excludeRespondedMissionHumanInteractions,
  useMissionHumanInteraction,
} from "./use-mission-human-interaction.ts";
import { useMissionOptions } from "./use-mission-options.ts";
import { useMissionContextOperations } from "./use-mission-context-operations.ts";
import {
  conversationFromPage,
  loadMissionConversationProjection,
  mergeConversationState,
  useMissionConversation,
  type MissionConversationPrefetch,
} from "./use-mission-conversation.ts";
import {
  LocalMissionUserMessageView,
  MissionChatEntryView,
  MissionContextOperationEntry,
  MissionThinkingPlaceholder,
  MissionToolCallBlock,
  MissionUserMessageContent,
} from "./mission-chat-presentation.tsx";
import { runtimeDisplayName } from "../../lib/runtime-display.ts";
import { ToolPermissionSelect } from "../../components/ToolPermissionSelect.tsx";
import { MissionModelOverrideControls } from "../../components/MissionModelOverrideControls.tsx";
import { MemoryStoreBrowser } from "../../components/MemoryStoreBrowser.tsx";
import {
  ContextStoreBrowser,
  type ContextStoreBrowserSource,
} from "../../components/ContextStoreBrowser.tsx";
import { ContextStorePickerDialog } from "../../components/ContextStorePickerDialog.tsx";
import { missionImageSupport } from "../../lib/mission-attachments.ts";
import {
  desktopApi,
  entryContentLength,
  missionConversationBlockKey,
  missionFooterTip,
  missionStatusLabel,
  missionWorkInputSenderName,
  setHumanAnswer,
  setHumanCustomAnswer,
  setHumanQuestionNote,
} from "./mission-page-utils.ts";
import {
  ContextWindowControl,
  MissionErrorBanner,
  MissionMemoryActivity,
  MissionUsageHint,
  unavailableMcpToolName,
} from "./mission-memory-usage.tsx";
import {
  MissionTeamParticipantList,
  MissionWorkGrid,
  expertIdFromRef,
  teamParticipantWorkRecords,
} from "./mission-participants-work.tsx";
import { MissionChatSkeleton } from "./mission-rail.tsx";
import { MissionHumanComposer } from "./mission-human-question.tsx";
import { MissionWorkDrawer } from "./mission-work-drawer.tsx";

type MissionQueuedMessageAction = "steer" | "remove";

export const MISSION_RECOVERY_WATCHDOG_MS = 60_000;

let cachedMissionContextStores: readonly ContextStore[] | undefined;

let missionContextStoresRequest: Promise<readonly ContextStore[]> | undefined;

export async function withMissionUiWatchdog<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return await Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              "Mission operation exceeded the 60-second UI wait limit and continues in the background.",
            ),
          ),
        MISSION_RECOVERY_WATCHDOG_MS,
      );
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

type MissionMemoryView = "store" | "activity";

export const DEFAULT_MISSION_MEMORY_VIEW: MissionMemoryView = "activity";

export function MissionDetailFragment(props: {
  readonly mission: Mission;
  readonly navigationId?: string | undefined;
  readonly chatCache?: Map<string, MissionConversationSnapshot> | undefined;
  readonly teamIdentityCache?: Map<string, MissionMentionCandidates> | undefined;
  readonly prefetchedConversation?: Promise<MissionConversationPrefetch | undefined> | undefined;
  readonly initialComposerDraft?: string | undefined;
  readonly initialComposerRevisionId?: string | undefined;
  readonly initialComposerRecovery?: MissionComposerSnapshot | undefined;
  readonly onComposerRecovery?:
    | ((snapshot: MissionComposerSnapshot, reason: MissionComposerRecoveryWriteReason) => void)
    | undefined;
  readonly onComposerRecoverySuperseded?: ((snapshot: MissionComposerSnapshot) => void) | undefined;
  readonly onComposerRecoveryConsumed?:
    | ((snapshot: MissionComposerSnapshot, reason: MissionComposerRecoveryConsumeReason) => void)
    | undefined;
  readonly onComposerRecoveryConflict?:
    ((recovery: MissionComposerSnapshot, current: MissionComposerSnapshot) => void) | undefined;
  readonly initialThinkingRequestId?: string | undefined;
  readonly error?: string | null | undefined;
  readonly onDismissError?: (() => void) | undefined;
  readonly onRun?: () => void | Promise<void>;
  readonly onInterrupt?: () => void | Promise<void>;
  readonly onForceInterrupt?: () => void | Promise<void>;
  readonly onForceRemove?: () => void;
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
  const isTeam = props.mission.executor.kind === "team";
  const isFlow = props.mission.executor.kind === "flow";
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
    reset: resetClientOperation,
  } = useMissionClientOperation(props.mission.id);
  const [queuedMessageActions, setQueuedMessageActions] = useState<
    ReadonlyMap<string, MissionQueuedMessageAction>
  >(() => new Map());
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const teamIdentityKey = `${props.mission.id}:${props.mission.project.revision}`;
  const [loadedTeamIdentity, setLoadedTeamIdentity] = useState<
    | {
        readonly key: string;
        readonly coordinator?: ExpertMentionCandidate | undefined;
        readonly members: readonly ExpertMentionCandidate[];
      }
    | undefined
  >(() => {
    const cached = props.teamIdentityCache?.get(teamIdentityKey);
    return cached === undefined
      ? undefined
      : { key: teamIdentityKey, coordinator: cached.coordinator, members: cached.members };
  });
  const mentionCandidates =
    isTeam && loadedTeamIdentity?.key === teamIdentityKey ? loadedTeamIdentity.members : [];
  const teamCoordinator =
    isTeam && loadedTeamIdentity?.key === teamIdentityKey
      ? loadedTeamIdentity.coordinator
      : undefined;
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
    active: activeTab === "work" || (isTeam && activeTab === "chat"),
    api: desktopApi(),
    formatError: missionError,
  });
  const [branchCandidate, setBranchCandidate] = useState<
    Extract<MissionChatEntry, { kind: "assistant" }> | undefined
  >();
  const [branching, setBranching] = useState(false);
  const [contextStores, setContextStores] = useState<readonly ContextStore[]>(
    () => cachedMissionContextStores ?? [],
  );
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
    navigationId: props.navigationId,
    api: desktopApi(),
    cache: props.chatCache,
    prefetchedConversation: props.prefetchedConversation,
    refreshRevision: chatRefreshRevision,
    syncUnavailableMessage: t("chatSyncUnavailable", { ns: "missions" }),
    formatError: missionError,
  });
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const chatFooterRef = useRef<HTMLDivElement | null>(null);
  const followLatestFrameRef = useRef<number | undefined>(undefined);
  const composerRef = useRef<MissionComposerHandle | null>(null);
  const lastUnmountedComposerSnapshotRef = useRef<MissionComposerSnapshot | undefined>(undefined);
  const pendingComposerDraftReplacementRef = useRef<
    | {
        readonly expectedRevisionId: string;
        readonly nextRevisionId: string;
        readonly draft: string;
      }
    | undefined
  >(undefined);
  const queuedMessageActionsRef = useRef<Map<string, MissionQueuedMessageAction>>(new Map());
  const followLatestRef = useRef(true);
  const chatScrollTopRef = useRef(0);
  const chatScrollMissionIdRef = useRef(props.mission.id);
  const selectedWorkTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previousSelectedWorkRecordRef = useRef<MissionWorkRecord | undefined>(undefined);
  const bindComposerRef = useCallback((composer: MissionComposerHandle | null): void => {
    composerRef.current = composer;
    if (composer !== null) lastUnmountedComposerSnapshotRef.current = undefined;
  }, []);
  useEffect(() => {
    const recovery = props.initialComposerRecovery;
    if (recovery?.missionId !== props.mission.id || composerRef.current === null) return;
    const restoreResult = composerRef.current.restore(recovery);
    if (restoreResult === "restored") {
      props.onComposerRecoveryConsumed?.(recovery, "claimed");
    } else if (restoreResult === "conflict") {
      props.onComposerRecoveryConflict?.(recovery, composerRef.current.snapshot());
    }
  }, [
    props.initialComposerRecovery,
    props.mission.id,
    props.onComposerRecoveryConflict,
    props.onComposerRecoveryConsumed,
  ]);
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
    if (props.mission.executor.kind !== "team") {
      setLoadedTeamIdentity(undefined);
      return;
    }
    const api = desktopApi();
    if (api === undefined) {
      if (props.teamIdentityCache?.get(teamIdentityKey) === undefined) {
        setLoadedTeamIdentity({ key: teamIdentityKey, members: [] });
      }
      return;
    }
    let cancelled = false;
    void api
      .getMissionMentionCandidates(props.mission.id)
      .then((result) => {
        if (!cancelled) {
          if (props.teamIdentityCache !== undefined) {
            props.teamIdentityCache.delete(teamIdentityKey);
            props.teamIdentityCache.set(teamIdentityKey, result);
            while (props.teamIdentityCache.size > 8) {
              const oldest = props.teamIdentityCache.keys().next().value as string | undefined;
              if (oldest === undefined) break;
              props.teamIdentityCache.delete(oldest);
            }
          }
          setLoadedTeamIdentity({
            key: teamIdentityKey,
            coordinator: result.coordinator,
            members: result.members,
          });
        }
      })
      .catch(() => {
        if (!cancelled && props.teamIdentityCache?.get(teamIdentityKey) === undefined) {
          setLoadedTeamIdentity({ key: teamIdentityKey, members: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.mission.executor.kind, props.mission.id, props.teamIdentityCache, teamIdentityKey]);

  useEffect(() => {
    if (
      previousSelectedWorkRecordRef.current !== undefined &&
      selectedWorkRecord === undefined &&
      selectedWorkTriggerRef.current !== null
    ) {
      const trigger = selectedWorkTriggerRef.current;
      selectedWorkTriggerRef.current = null;
      requestAnimationFrame(() => trigger.focus());
    }
    previousSelectedWorkRecordRef.current = selectedWorkRecord;
  }, [selectedWorkRecord]);

  useEffect(() => {
    if (!contextStorePickerOpen) return;
    let cancelled = false;
    const api = desktopApi();
    if (api === undefined) return;
    missionContextStoresRequest ??= api.listContextStores().then((stores) => {
      cachedMissionContextStores = stores;
      return stores;
    });
    void missionContextStoresRequest
      .then((stores) => {
        if (!cancelled) {
          setContextStores(stores);
        }
      })
      .catch((loadError: unknown) => {
        missionContextStoresRequest = undefined;
        if (!cancelled) setOptionsError(missionError(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, [contextStorePickerOpen, missionError]);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined || contextStores.length === 0) return;
    const invalidate = (): void => {
      cachedMissionContextStores = undefined;
      missionContextStoresRequest = undefined;
    };
    const unsubscribes = contextStores.map((store) =>
      api.subscribeContextStoreChanges(store.id, invalidate),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [contextStores]);

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
    respondedInteractionIds,
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
      const scroller = scrollRef.current;
      if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
    });
  }, []);

  useEffect(
    () =>
      liveEntryStore.subscribePublished(() => {
        if (followLatestRef.current) scheduleFollowLatest();
      }),
    [liveEntryStore, scheduleFollowLatest],
  );

  useLayoutEffect(() => {
    if (activeTab !== "chat") return;
    const footer = chatFooterRef.current;
    const scroller = scrollRef.current;
    if (footer === null || scroller === null) return;

    const syncFooterHeight = (): void => {
      scroller.style.setProperty(
        "--mission-chat-footer-height",
        `${Math.ceil(footer.getBoundingClientRect().height)}px`,
      );
      if (followLatestRef.current) scheduleFollowLatest();
    };

    syncFooterHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncFooterHeight);
    observer.observe(footer);
    return () => {
      observer.disconnect();
      scroller.style.removeProperty("--mission-chat-footer-height");
    };
  }, [activeTab, scheduleFollowLatest]);

  useEffect(
    () => () => {
      if (followLatestFrameRef.current !== undefined) {
        cancelAnimationFrame(followLatestFrameRef.current);
        followLatestFrameRef.current = undefined;
      }
    },
    [],
  );

  const missionExecutionStatus = props.mission.execution?.status;
  const conversationExecutionStatus = chat?.execution?.status;
  const executionStatus =
    missionExecutionStatus !== undefined &&
    ["succeeded", "failed", "cancelled"].includes(missionExecutionStatus)
      ? missionExecutionStatus
      : (conversationExecutionStatus ?? missionExecutionStatus);
  const executionActive =
    executionStatus !== undefined && ["queued", "running", "waiting"].includes(executionStatus);
  const optionsSaving = clientOperation.kind === "saving_options";
  const runtimeCompactingContext =
    chat?.entries.some(
      (entry) => entry.kind === "context_operation" && entry.status === "running",
    ) ?? false;
  const compactingContext = clientOperation.kind === "compacting" || runtimeCompactingContext;
  const clientOperationBusy = clientOperation.kind !== "idle";
  const interactions = excludeRespondedMissionHumanInteractions(
    chat?.pendingInteractions ?? [],
    respondedInteractionIds,
  );
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
    queuedMessageActionsRef.current = new Map();
    setQueuedMessageActions(queuedMessageActionsRef.current);
  }, [props.mission.id]);

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

  const beginQueuedMessageAction = (
    queueItemRequestId: string,
    action: MissionQueuedMessageAction,
  ): boolean => {
    if (queuedMessageActionsRef.current.has(queueItemRequestId)) return false;
    const next = new Map(queuedMessageActionsRef.current).set(queueItemRequestId, action);
    queuedMessageActionsRef.current = next;
    setQueuedMessageActions(next);
    return true;
  };

  const finishQueuedMessageAction = (queueItemRequestId: string): void => {
    if (!queuedMessageActionsRef.current.has(queueItemRequestId)) return;
    const next = new Map(queuedMessageActionsRef.current);
    next.delete(queueItemRequestId);
    queuedMessageActionsRef.current = next;
    setQueuedMessageActions(next);
  };

  const send = async (retry?: LocalMissionUserMessage) => {
    const composerSnapshot = composerRef.current?.snapshot();
    const content = retry?.content ?? composerSnapshot?.draft.trim() ?? "";
    if (content === "" || isFlow) return;
    const operationToken = beginClientOperation("sending");
    if (operationToken === undefined) return;
    const optimistic = createMissionSendAttempt({
      content,
      attachments: composerSnapshot?.attachments ?? [],
      retry,
      createRequestId: () => crypto.randomUUID(),
      now: () => new Date().toISOString(),
    });
    const requestId = optimistic.id;
    recordSubmission(optimistic, retry?.retryMode === "new-request" ? retry.id : undefined);
    const shouldPrepareQueuedMessage = executionActive;
    const sentAttachmentIds = optimistic.attachments.map((attachment) => attachment.id);
    let discardSentDrafts = false;
    if (retry === undefined) composerRef.current?.clear();
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
      if (retry === undefined && composerSnapshot !== undefined) {
        props.onComposerRecoveryConsumed?.(composerSnapshot, "send-succeeded");
      }
      setDeliveryNotice(undefined);
      if (shouldPrepareQueuedMessage) {
        await refreshLatestChat().catch(() => undefined);
      }
    } catch {
      const snapshot = await refreshLatestChat().catch(() => undefined);
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
      if (!persisted) {
        const recovery: MissionComposerSnapshot = {
          missionId: props.mission.id,
          revisionId: composerSnapshot?.revisionId ?? requestId,
          draft: content,
          attachments: optimistic.attachments,
          attachmentPreviews: composerSnapshot?.attachmentPreviews ?? {},
        };
        recoverFailedMissionSend({
          recovery,
          composer: composerRef.current,
          preserve: (snapshot) => props.onComposerRecovery?.(snapshot, "send-failed"),
          discard: props.onComposerRecoverySuperseded,
        });
      }
      setAwaitingRequestId(null);
    } finally {
      if (discardSentDrafts && sentAttachmentIds.length > 0) {
        void desktopApi()?.discardMissionAttachmentDrafts({ attachmentIds: sentAttachmentIds });
      }
      finishClientOperation(operationToken);
      requestAnimationFrame(() => composerRef.current?.focus(props.mission.id));
    }
  };

  const interrupt = async () => {
    if (interrupting || !interruptible) return;
    setInterrupting(true);
    try {
      await withMissionUiWatchdog(Promise.resolve(props.onInterrupt?.()));
    } finally {
      setInterrupting(false);
    }
  };

  const retryRecovery = async () => {
    const operationToken = beginClientOperation("restoring");
    if (operationToken === undefined) return;
    try {
      await withMissionUiWatchdog(Promise.resolve(props.onRun?.()));
      await refreshLatestChat();
    } finally {
      finishClientOperation(operationToken);
    }
  };

  const forceInterrupt = async () => {
    if (interrupting) return;
    setInterrupting(true);
    try {
      await withMissionUiWatchdog(Promise.resolve(props.onForceInterrupt?.()));
      await refreshLatestChat();
    } finally {
      setInterrupting(false);
    }
  };

  const refreshLatestChat = async (): Promise<MissionConversationSnapshot | undefined> => {
    const api = desktopApi();
    if (api === undefined) return undefined;
    const { page, state } = await loadMissionConversationProjection(api, props.mission.id);
    let result: MissionConversationSnapshot | undefined;
    updateChat((current) => {
      const pageSnapshot = mergeLatestChatPage(current, conversationFromPage(page, current));
      const next = state === undefined ? pageSnapshot : mergeConversationState(pageSnapshot, state);
      result = next ?? undefined;
      return next;
    });
    return result;
  };

  const steerQueuedMessage = async (queueItemRequestId: string): Promise<void> => {
    const api = desktopApi();
    if (api === undefined || !beginQueuedMessageAction(queueItemRequestId, "steer")) return;
    try {
      const result = await api.trySteerQueuedMissionMessage({
        id: props.mission.id,
        requestId: crypto.randomUUID(),
        queueItemRequestId,
      });
      if (result.queueSteer.outcome === "steered") {
        followLatestRef.current = true;
        setShowJumpToLatest(false);
      }
      await refreshLatestChat();
      if (result.queueSteer.outcome === "steered") scheduleFollowLatest();
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
    const sourceSnapshot = composerRef.current?.snapshot();
    if (
      api === undefined ||
      sourceSnapshot === undefined ||
      !beginQueuedMessageAction(queueItemRequestId, "remove")
    )
      return;
    try {
      await api.removeQueuedMissionMessage({
        id: props.mission.id,
        requestId: crypto.randomUUID(),
        queueItemRequestId,
      });
      if (composerRef.current !== null) {
        composerRef.current.replaceDraft(props.mission.id, sourceSnapshot.revisionId, content);
      } else {
        const replacement = {
          expectedRevisionId: sourceSnapshot.revisionId,
          nextRevisionId: crypto.randomUUID(),
          draft: content,
        };
        const unmountedSnapshot = lastUnmountedComposerSnapshotRef.current;
        if (unmountedSnapshot === undefined) {
          pendingComposerDraftReplacementRef.current = replacement;
        } else {
          const recovered = replaceMissionComposerSnapshotDraft({
            snapshot: unmountedSnapshot,
            ...replacement,
          });
          if (recovered !== undefined) {
            lastUnmountedComposerSnapshotRef.current = recovered;
            props.onComposerRecovery?.(recovered, "unmount");
          }
        }
      }
      await refreshLatestChat();
      requestAnimationFrame(() => composerRef.current?.focus(props.mission.id));
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
  const queuedMessages = useMemo(
    () => mergeMissionQueuedMessages(chat?.queue?.items ?? [], pendingQueuedMessages),
    [chat?.queue?.items, pendingQueuedMessages],
  );
  const visibleQueuedMessages = queuedMessages;
  const visibleQueuedRequestIds = useMemo(
    () => new Set(queuedMessages.map((message) => message.requestId)),
    [queuedMessages],
  );
  const unfilteredDisplayEntries = useMemo(
    () =>
      hideInterruptedExecutionFallbackEntries(
        hideQueuedChatEntries(chat?.entries ?? [], visibleQueuedRequestIds),
      ),
    [chat?.entries, visibleQueuedRequestIds],
  );
  const coordinatorId =
    (teamCoordinator === undefined ? undefined : expertIdFromRef(teamCoordinator.ref)) ??
    workRecords.find((record) => record.kind === "root")?.executorId;
  const displayEntries = useMemo(
    () =>
      isTeam
        ? teamCoordinatorChatEntries(unfilteredDisplayEntries, coordinatorId)
        : unfilteredDisplayEntries,
    [coordinatorId, isTeam, unfilteredDisplayEntries],
  );
  const participantWorkRecords = useMemo(
    () => (isTeam ? teamParticipantWorkRecords(workRecords, mentionCandidates) : []),
    [isTeam, mentionCandidates, workRecords],
  );
  const participantWorkFingerprint = participantWorkRecords
    .map((record) => `${record.recordId}:${record.status}:${record.updatedAt}`)
    .join("|");
  const durableEntryIds = useMemo(
    () => new Set(displayEntries.map((entry) => entry.id)),
    [displayEntries],
  );
  const conversationEntries = useMemo(
    () =>
      orderMissionConversationEntries([
        ...displayEntries.map((entry) => ({ type: "durable" as const, entry })),
        ...optimisticMessages
          .filter((message) => !durableEntryIds.has(message.id))
          .map((message) => ({ type: "local" as const, entry: message })),
        ...contextOperations.map((operation) => ({
          type: "context-operation" as const,
          entry: operation,
        })),
      ]),
    [contextOperations, displayEntries, durableEntryIds, optimisticMessages],
  );
  const conversationBlocks = useMemo(
    () => groupMissionConversationEntries(conversationEntries),
    [conversationEntries],
  );
  const getConversationScrollElement = useCallback(() => scrollRef.current, []);
  const getConversationItemKey = useCallback(
    (index: number) => {
      if (index === 0) return `${props.mission.id}:history-header`;
      if (index === conversationBlocks.length + 1) return `${props.mission.id}:live-footer`;
      const block = conversationBlocks[index - 1]!;
      return missionConversationBlockKey(props.mission.id, index - 1, block);
    },
    [conversationBlocks, props.mission.id],
  );
  const estimateConversationItemSize = useCallback(
    (index: number) => (index === 0 ? 56 : index === conversationBlocks.length + 1 ? 72 : 80),
    [conversationBlocks.length],
  );
  const conversationVirtualizer = useVirtualizer({
    count: conversationBlocks.length + 2,
    getScrollElement: getConversationScrollElement,
    getItemKey: getConversationItemKey,
    estimateSize: estimateConversationItemSize,
    overscan: 8,
    initialRect: { width: 900, height: 800 },
  });
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
  const backendRecoveryAvailable =
    chat?.controlHealth !== undefined &&
    ["orphaned", "interrupt_uncertain", "recovery_failed", "deletion_pending"].includes(
      chat.controlHealth.state,
    );
  const recoveryAvailable = backendRecoveryAvailable;
  const recoveryActions = new Set(chat?.controlHealth?.availableActions ?? []);
  useEffect(() => {
    const executionStatus = props.mission.execution?.status;
    if (
      props.mission.lifecycleStatus !== "completed" &&
      (executionStatus === undefined || ["queued", "running", "waiting"].includes(executionStatus))
    ) {
      return;
    }
    resetClientOperation();
    setAwaitingRequestId(null);
    setPendingQueuedMessages([]);
  }, [
    props.mission.execution?.status,
    props.mission.lifecycleStatus,
    resetClientOperation,
    setAwaitingRequestId,
    setPendingQueuedMessages,
  ]);

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

  const loadEarlier = async (): Promise<void> => {
    const scroller = scrollRef.current;
    const previousScrollTop = scroller?.scrollTop ?? 0;
    const previousScrollHeight = scroller?.scrollHeight ?? 0;
    await loadEarlierChat(() => {
      followLatestRef.current = false;
    });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const currentScroller = scrollRef.current;
        if (currentScroller === null) return;
        currentScroller.scrollTop =
          previousScrollTop + Math.max(0, currentScroller.scrollHeight - previousScrollHeight);
      });
    });
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
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
    participantWorkFingerprint,
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
  const showRecoveryActions =
    recoveryAvailable &&
    (chat?.controlHealth?.state === "deletion_pending" || (executionActive && !interruptible));
  const showMissionRunAction =
    props.mission.lifecycleStatus === "active" &&
    (props.mission.execution === undefined ||
      (!executionActive && isFlow) ||
      (executionActive && !interruptible)) &&
    !(props.mission.branch !== undefined && props.mission.execution === undefined);
  const missionDetailActionMenu = (
    <div className="mission-detail-action-menu" role="presentation">
      <button
        className="mission-detail-action-menu-trigger"
        type="button"
        aria-label={t("moreActions", { ns: "missions" })}
        aria-haspopup="true"
        title={t("moreActions", { ns: "missions" })}
      >
        <DotsThreeVertical size={18} weight="bold" aria-hidden="true" />
      </button>
      <div
        className="mission-detail-action-popover"
        role="group"
        aria-label={t("moreActions", { ns: "missions" })}
      >
        <div className="mission-detail-action-popover-surface">
          {props.onLifecycleChange !== undefined ? (
            <StudioActionButton
              label={t(props.mission.lifecycleStatus === "active" ? "markComplete" : "reopen", {
                ns: "missions",
              })}
              tooltip={t(props.mission.lifecycleStatus === "active" ? "markComplete" : "reopen", {
                ns: "missions",
              })}
              tooltipPlacement="left"
              disabled={clientOperationBusy}
              icon={
                props.mission.lifecycleStatus === "active" ? (
                  <CheckCircle size={20} aria-hidden="true" />
                ) : (
                  <ArrowCounterClockwise size={20} aria-hidden="true" />
                )
              }
              onClick={() => void props.onLifecycleChange?.()}
            />
          ) : null}
          {showRecoveryActions ? (
            <div
              className="mission-recovery-actions"
              role="group"
              aria-label={t("recoveryActions", { ns: "missions" })}
            >
              {recoveryActions.has("recover") ? (
                <StudioActionButton
                  label={t("resume", { ns: "missions" })}
                  tooltip={t("resume", { ns: "missions" })}
                  tooltipPlacement="left"
                  tone="primary"
                  disabled={clientOperationBusy}
                  busy={clientOperation.kind === "restoring"}
                  icon={<ArrowCounterClockwise size={20} aria-hidden="true" />}
                  onClick={() => void retryRecovery()}
                />
              ) : null}
              {recoveryActions.has("force_interrupt") ? (
                <StudioActionButton
                  label={t("forceInterrupt", { ns: "missions" })}
                  tooltip={t("forceInterrupt", { ns: "missions" })}
                  tooltipPlacement="left"
                  tone="danger"
                  disabled={clientOperationBusy || interrupting}
                  busy={interrupting}
                  icon={<Stop size={20} weight="fill" aria-hidden="true" />}
                  onClick={() => void forceInterrupt()}
                />
              ) : null}
              {recoveryActions.has("force_remove") ? (
                <StudioActionButton
                  label={t("forceRemove", { ns: "missions" })}
                  tooltip={t("forceRemove", { ns: "missions" })}
                  tooltipPlacement="left"
                  tone="danger"
                  disabled={clientOperationBusy}
                  icon={<Trash size={20} aria-hidden="true" />}
                  onClick={() => props.onForceRemove?.()}
                />
              ) : null}
            </div>
          ) : showMissionRunAction ? (
            executionActive ? (
              <StudioActionButton
                label={t("resume", { ns: "missions" })}
                tooltip={t("resume", { ns: "missions" })}
                tooltipPlacement="left"
                tone="primary"
                disabled={clientOperationBusy}
                icon={<Play size={20} aria-hidden="true" />}
                onClick={() => void props.onRun?.()}
              />
            ) : (
              <StudioActionButton
                label={t(props.mission.execution === undefined ? "run" : "runAgain", {
                  ns: "missions",
                })}
                tooltip={t(props.mission.execution === undefined ? "run" : "runAgain", {
                  ns: "missions",
                })}
                tooltipPlacement="left"
                tone="primary"
                disabled={clientOperationBusy}
                icon={<Play size={20} aria-hidden="true" />}
                onClick={() => void props.onRun?.()}
              />
            )
          ) : null}
        </div>
      </div>
    </div>
  );
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
              className="mission-knowledge-revision-action"
              type="button"
              onClick={() => props.onOpenKnowledgeRevision?.(revisionStoreId)}
            >
              {t("openKnowledgeRevision", { ns: "missions" })}
            </button>
          </>
        ) : null}
      </p>
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
          {missionDetailActionMenu}
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
                const atBottom =
                  element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
                followLatestRef.current = atBottom;
                setShowJumpToLatest(!atBottom);
              }}
            >
              <div
                className="mission-chat-virtual-list"
                style={{ height: conversationVirtualizer.getTotalSize() }}
              >
                {conversationVirtualizer.getVirtualItems().map((virtualRow) => {
                  const index = virtualRow.index;
                  const block = index === 0 ? undefined : conversationBlocks[index - 1];
                  return (
                    <div
                      key={virtualRow.key}
                      ref={conversationVirtualizer.measureElement}
                      data-index={index}
                      className="mission-chat-virtual-row"
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                    >
                      {index === 0 ? (
                        <div className="mission-chat-virtual-header">
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
                          {chat?.page.truncation === undefined ? null : (
                            <p className="mission-history-error" role="status">
                              {t("historyTruncated", {
                                ns: "missions",
                                count: chat.page.truncation.omittedEntries,
                                truncatedFields: chat.page.truncation.truncatedFields,
                              })}
                            </p>
                          )}
                        </div>
                      ) : index === conversationBlocks.length + 1 ? (
                        <div className="mission-chat-virtual-footer">
                          {showThinkingPlaceholder ? (
                            <MissionThinkingPlaceholder
                              executorName={props.mission.executor.name}
                            />
                          ) : null}
                          {participantWorkRecords.length === 0 ? null : (
                            <MissionTeamParticipantList
                              records={participantWorkRecords}
                              allRecords={workRecords}
                              onOpenWork={() => changeTab("work")}
                              onSelect={(recordId, trigger) => {
                                selectedWorkTriggerRef.current = trigger;
                                selectWorkRecord(recordId);
                              }}
                            />
                          )}
                          <span aria-hidden="true" className="mission-chat-bottom-anchor" />
                        </div>
                      ) : block?.type === "tools" ? (
                        <div className="mission-chat-virtual-entry">
                          <MissionToolCallBlock
                            collapsed={block.collapsed}
                            entries={block.entries}
                            mentionCandidates={mentionCandidates}
                          />
                        </div>
                      ) : block?.item.type === "local" ? (
                        <div className="mission-chat-virtual-entry">
                          <LocalMissionUserMessageView
                            message={block.item.entry}
                            missionId={props.mission.id}
                            mentionCandidates={mentionCandidates}
                            retryDisabled={clientOperationBusy}
                            onRetry={
                              block.item.entry.retryMode !== undefined
                                ? (message) => void send(message)
                                : undefined
                            }
                          />
                        </div>
                      ) : block?.item.type === "context-operation" ? (
                        <div className="mission-chat-virtual-entry">
                          <MissionContextOperationEntry
                            operation={block.item.entry}
                            retryDisabled={
                              clientOperationBusy || chat?.contextWindow?.canCompact !== true
                            }
                            onRetry={() => void compactContext(block.item.entry.id)}
                          />
                        </div>
                      ) : block?.item.type === "durable" ? (
                        <div className="mission-chat-virtual-entry">
                          <MissionChatEntryView
                            entry={block.item.entry}
                            liveEntryStore={liveEntryStore}
                            missionId={props.mission.id}
                            mentionCandidates={mentionCandidates}
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
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="mission-chat-footer" ref={chatFooterRef}>
              {showJumpToLatest ? (
                <button
                  className="mission-jump-latest mission-jump-latest-overlay"
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
                    disabled={clientOperationBusy}
                    onClick={() => {
                      const api = desktopApi();
                      if (api === undefined) return;
                      void api
                        .resumeMissionQueue(props.mission.id)
                        .then(async () => await refreshLatestChat())
                        .catch((resumeError: unknown) =>
                          setOptionsError(missionError(resumeError)),
                        );
                    }}
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
                    {visibleQueuedMessages.length > 0 ? (
                      <div
                        className="mission-prompt-queue"
                        aria-label={t("queuedMessages", { ns: "missions" })}
                      >
                        {visibleQueuedMessages.map((item) => {
                          const action = queuedMessageActions.get(item.requestId);
                          const steering = action === "steer";
                          const canSteer =
                            chat?.queue?.supportsSteer === true &&
                            interruptible &&
                            !item.hasAttachments;
                          return (
                            <div className="mission-prompt-queue-item" key={item.requestId}>
                              <span className="mission-prompt-queue-marker" aria-hidden="true">
                                <ArrowBendUpLeft size={16} />
                              </span>
                              <strong>{t("queuedMessage", { ns: "missions" })}</strong>
                              <MissionUserMessageContent
                                source={item.content}
                                mentionCandidates={mentionCandidates}
                                inline
                              />
                              <div className="mission-prompt-queue-actions">
                                {canSteer ? (
                                  <button
                                    className={`mission-queue-steer${steering ? " is-preparing" : ""}`}
                                    type="button"
                                    aria-label={
                                      steering
                                        ? t("preparingQueuedSteer", { ns: "missions" })
                                        : undefined
                                    }
                                    title={
                                      steering
                                        ? t("preparingQueuedSteer", { ns: "missions" })
                                        : undefined
                                    }
                                    aria-busy={steering || undefined}
                                    disabled={!item.persisted || action !== undefined}
                                    onClick={() => void steerQueuedMessage(item.requestId)}
                                  >
                                    {steering ? (
                                      <SpinnerGap size={16} aria-hidden="true" />
                                    ) : (
                                      <>
                                        <ArrowBendUpLeft size={16} aria-hidden="true" />
                                        {t("deliverySteer", { ns: "missions" })}
                                      </>
                                    )}
                                  </button>
                                ) : null}
                                <button
                                  className="mission-queue-remove"
                                  type="button"
                                  aria-label={t("removeQueuedMessage", { ns: "missions" })}
                                  title={t("removeQueuedMessage", { ns: "missions" })}
                                  disabled={!item.persisted || action !== undefined}
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
                      </div>
                    ) : null}
                    <MissionChatComposer
                      ref={bindComposerRef}
                      mission={props.mission}
                      initialRevisionId={props.initialComposerRevisionId}
                      initialDraft={props.initialComposerDraft}
                      initialRecovery={props.initialComposerRecovery}
                      onInitialRecoveryConsumed={(snapshot) =>
                        props.onComposerRecoveryConsumed?.(snapshot, "claimed")
                      }
                      onUnmountState={(snapshot) => {
                        const replacement = pendingComposerDraftReplacementRef.current;
                        pendingComposerDraftReplacementRef.current = undefined;
                        const recovered =
                          replacement === undefined
                            ? snapshot
                            : (replaceMissionComposerSnapshotDraft({
                                snapshot,
                                ...replacement,
                              }) ?? snapshot);
                        lastUnmountedComposerSnapshotRef.current = recovered;
                        props.onComposerRecovery?.(recovered, "unmount");
                      }}
                      mentionCandidates={mentionCandidates}
                      imageUnsupported={imageUnsupported}
                      isFlow={isFlow}
                      sending={clientOperation.kind === "sending"}
                      clientOperationBusy={clientOperationBusy}
                      compactingContext={compactingContext}
                      hasPendingQueuedMessage={pendingQueuedMessages.length > 0}
                      executionActive={executionActive}
                      interruptible={interruptible}
                      interrupting={interrupting}
                      recoveryAvailable={recoveryAvailable}
                      awaitingRequest={awaitingRequestId !== null}
                      onSubmit={() => void send()}
                      onInterrupt={() => void interrupt()}
                      onRecover={() => void retryRecovery()}
                      onError={(error) => setOptionsError(missionError(error))}
                      onAttachmentLimit={() =>
                        setOptionsError(t("attachmentLimit", { ns: "missions" }))
                      }
                      onAttachmentsAccepted={() => setOptionsError(null)}
                      toolbarOptions={
                        <>
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
                        </>
                      }
                      contextWindowControl={
                        chat?.contextWindow === undefined ? null : (
                          <ContextWindowControl
                            state={chat.contextWindow}
                            compacting={compactingContext}
                            onCompact={() => void compactContext()}
                          />
                        )
                      }
                    />
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
          <MissionWorkGrid
            records={workRecords}
            mentionCandidates={mentionCandidates}
            onSelect={(recordId) => {
              selectedWorkTriggerRef.current = null;
              selectWorkRecord(recordId);
            }}
          />
        )}
      </div>
      {selectedWorkRecord === undefined ? null : (
        <MissionWorkDrawer
          record={selectedWorkRecord}
          inputSenderName={selectedWorkInputSenderName}
          mentionCandidates={mentionCandidates}
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
