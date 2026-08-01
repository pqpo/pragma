import {
  memo,
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
import { flushSync } from "react-dom";

import {
  ArrowCounterClockwise,
  CaretDown,
  CheckCircle,
  Folder,
  GitBranch,
  MagnifyingGlass,
  PaperPlaneTilt,
  Plus,
  Play,
  PushPin,
  StopCircle,
  SpinnerGap,
  TerminalWindow,
  Toolbox,
  Trash,
  User,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import type { HumanInteractionResponse } from "@pragma/shared";

import { ConfirmationDialog } from "../../components/Dialog.tsx";
import {
  type Mission,
  type MissionChatEntry,
  type MissionChatPatch,
  type MissionChatSnapshot,
  type MissionChatUpdate,
  type MissionContextWindowState,
  type MissionHumanInteraction,
  type MissionSummary,
  type MissionWorkConversationSnapshot,
  type MissionWorkRecord,
  type DesktopRuntimeModel,
  type DesktopToolPermissionMode,
  type MissionModelOverride,
  type PragmaDesktopAPI,
} from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { i18n } from "../../i18n/index.ts";
import { shouldSubmitComposerOnEnter } from "../../lib/composer-keyboard.ts";
import { formatMissionDateTime, formatMissionTime } from "../../lib/mission-time.ts";
import { runtimeDisplayName, type RuntimeDisplayIdentity } from "../../lib/runtime-display.ts";
import { formatTokens } from "../../lib/usage-format.ts";
import { ToolPermissionSelect } from "../../components/ToolPermissionSelect.tsx";
import { MissionModelOverrideControls } from "../../components/MissionModelOverrideControls.tsx";
import { MarkdownContent } from "../../components/MarkdownContent.tsx";
import {
  pruneMissionDrafts,
  readMissionDraft,
  writeMissionDraft,
} from "../../lib/mission-draft.ts";
import {
  readPinnedMissionIds,
  readLastOpenedMissionId,
  selectPreferredMissionId,
  togglePinnedMissionId,
  writePinnedMissionIds,
  writeLastOpenedMissionId,
} from "../../lib/mission-preference.ts";

export function MissionsPage(props: {
  readonly initialMission?: Mission | undefined;
  readonly autoRunInitialMission?: boolean | undefined;
  readonly onCreate: () => void;
  readonly onConfigureModels?: (() => void) | undefined;
  readonly onEditExpert?: ((expertRef?: string | undefined) => void) | undefined;
}) {
  const { t } = useTranslation(["missions", "common"]);
  const [missions, setMissions] = useState<readonly MissionSummary[]>([]);
  const [selectedMission, setSelectedMission] = useState<Mission | null>(
    props.initialMission ?? null,
  );
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(
    props.initialMission?.id ?? null,
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
  const selectedMissionIdRef = useRef<string | null>(props.initialMission?.id ?? null);
  const initialRunStartedRef = useRef(false);
  const removedMissionIdsRef = useRef(new Set<string>());

  const replaceMission = useCallback((updated: Mission) => {
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
    setMissions((current) => upsertMissionSummary(current, missionToSummary(updated)));
  }, []);

  const updatePinnedMissionIds = useCallback((update: (current: readonly string[]) => string[]) => {
    setPinnedMissionIds((current) => {
      const next = update(current);
      writePinnedMissionIds(typeof window === "undefined" ? undefined : window.localStorage, next);
      return next;
    });
  }, []);

  const openMission = useCallback((id: string) => {
    selectedMissionIdRef.current = id;
    setSelectedMissionId(id);
    setSelectedMission(null);
    setError(null);
    writeLastOpenedMissionId(typeof window === "undefined" ? undefined : window.localStorage, id);
    const api = desktopApi();
    if (api === undefined) return;
    void api
      .getMission(id)
      .then((mission) => {
        if (selectedMissionIdRef.current === id) setSelectedMission(mission);
      })
      .catch((loadError: unknown) => {
        if (selectedMissionIdRef.current === id) setError(errorMessage(loadError));
      });
  }, []);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) return;
    return api.subscribeMissionUpdates((update) => {
      if (update.kind === "upsert") {
        if (removedMissionIdsRef.current.has(update.mission.id)) return;
        replaceMission(update.mission);
        return;
      }
      writeMissionDraft(
        typeof window === "undefined" ? undefined : window.localStorage,
        update.missionId,
        "",
      );
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
        setError(errorMessage(runError));
      });
  }, [props.autoRunInitialMission, props.initialMission?.id, replaceMission]);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) return;
    let cancelled = false;
    void api
      .listMissions()
      .then((storedMissions) => {
        if (cancelled) return;
        setMissions((current) =>
          storedMissions
            .filter((mission) => !removedMissionIdsRef.current.has(mission.id))
            .reduce((merged, mission) => upsertMissionSummary(merged, mission), [...current]),
        );
        pruneMissionDrafts(
          typeof window === "undefined" ? undefined : window.localStorage,
          new Set(
            storedMissions
              .filter((mission) => mission.lifecycleStatus === "active")
              .map((mission) => mission.id),
          ),
        );
        if (selectedMissionIdRef.current !== null) return;
        const lastOpenedId = readLastOpenedMissionId(
          typeof window === "undefined" ? undefined : window.localStorage,
        );
        const preferredId = selectPreferredMissionId(storedMissions, lastOpenedId);
        if (preferredId !== null) openMission(preferredId);
        else {
          writeLastOpenedMissionId(
            typeof window === "undefined" ? undefined : window.localStorage,
            null,
          );
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, [openMission]);

  const visibleMissions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (query === "") return missions;
    return missions.filter((mission) =>
      [mission.title, mission.workspace.basename, mission.executor.name].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    );
  }, [missions, search]);
  return (
    <section className="missions-page">
      <MissionRail
        missions={visibleMissions}
        search={search}
        now={now}
        pinnedMissionIds={pinnedMissionIds}
        selectedMissionId={selectedMissionId}
        onSearch={setSearch}
        onCreate={props.onCreate}
        onOpen={(summary) => openMission(summary.id)}
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
            setError(errorMessage(actionError));
          }
        }}
        onDelete={setDeleteCandidate}
      />

      <div className="mission-main">
        {selectedMission !== null ? (
          <MissionDetailFragment
            mission={selectedMission}
            initialThinkingRequestId={
              initialRunRequest?.missionId === selectedMission.id
                ? initialRunRequest.requestId
                : undefined
            }
            onConfigureModels={props.onConfigureModels}
            onEditExpert={props.onEditExpert}
            error={error}
            onDismissError={() => setError(null)}
            onSend={async (content, requestId) => {
              const api = desktopApi();
              if (api === undefined) return;
              try {
                replaceMission(
                  await api.sendMissionMessage({
                    id: selectedMission.id,
                    content,
                    requestId,
                  }),
                );
                setError(null);
              } catch (sendError) {
                setError(errorMessage(sendError));
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
                setError(errorMessage(runError));
              }
            }}
            onInterrupt={async () => {
              const api = desktopApi();
              if (api === undefined) return;
              try {
                replaceMission(await api.interruptMission(selectedMission.id));
                setError(null);
              } catch (interruptError) {
                setError(errorMessage(interruptError));
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
                setError(errorMessage(optionsError));
                throw optionsError;
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
                setError(errorMessage(actionError));
              }
            }}
          />
        ) : (
          <div className="mission-empty-detail">
            <h1>{t("notFound", { ns: "missions" })}</h1>
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
                  const fallback = storedMissions[0];
                  if (fallback === undefined) {
                    writeLastOpenedMissionId(window.localStorage, null);
                  } else {
                    openMission(fallback.id);
                  }
                }
                setDeleteCandidate(null);
                setError(null);
              })
              .catch((deleteError: unknown) => {
                setError(errorMessage(deleteError));
                setDeleteCandidate(null);
              })
              .finally(() => setDeleting(false));
          }}
        />
      ) : null}
    </section>
  );
}

function MissionRail(props: {
  readonly missions: readonly MissionSummary[];
  readonly search: string;
  readonly now: number;
  readonly pinnedMissionIds: readonly string[];
  readonly selectedMissionId: string | null;
  readonly onSearch: (value: string) => void;
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
        <h1>{t("title")}</h1>
        <button className="mission-new-button" type="button" onClick={props.onCreate}>
          <Plus size={18} aria-hidden="true" />
          {t("newMission")}
        </button>
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
        emptyLabel={t("noActive")}
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
        emptyLabel={t("noCompleted")}
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

interface LocalMissionUserMessage {
  readonly id: string;
  readonly content: string;
  readonly createdAt: string;
  readonly status: "pending" | "failed";
}

export interface LocalMissionContextOperation {
  readonly id: string;
  readonly createdAt: string;
  readonly status: "running" | "succeeded" | "skipped" | "failed";
  readonly error?: string | undefined;
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

export type MissionClientOperationState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "sending" | "saving_options" | "compacting" | "restoring";
      readonly token: string;
    };

export function claimMissionClientOperation(
  current: MissionClientOperationState,
  kind: Exclude<MissionClientOperationState["kind"], "idle">,
  token: string,
): MissionClientOperationState | null {
  return current.kind === "idle" ? { kind, token } : null;
}

export function releaseMissionClientOperation(
  current: MissionClientOperationState,
  token: string,
): MissionClientOperationState {
  return current.kind !== "idle" && current.token === token ? { kind: "idle" } : current;
}

type MissionConversationEntry =
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

export function MissionDetailFragment(props: {
  readonly mission: Mission;
  readonly initialThinkingRequestId?: string | undefined;
  readonly error?: string | null | undefined;
  readonly onDismissError?: (() => void) | undefined;
  readonly onRun?: () => void | Promise<void>;
  readonly onInterrupt?: () => void | Promise<void>;
  readonly onSend?: (content: string, requestId: string) => void | Promise<void>;
  readonly onOptionsChange?:
    | ((options: {
        readonly toolPermissionMode: DesktopToolPermissionMode;
        readonly modelOverride?: MissionModelOverride | undefined;
      }) => void | Promise<void>)
    | undefined;
  readonly onHumanResponded?: () => void | Promise<void>;
  readonly onLifecycleChange?: () => void | Promise<void>;
  readonly onConfigureModels?: (() => void) | undefined;
  readonly onEditExpert?: ((expertRef?: string | undefined) => void) | undefined;
}) {
  const { t } = useTranslation(["missions", "common"]);
  const [tab, setTab] = useState<"chat" | "work">("chat");
  const [workspaceAvailable, setWorkspaceAvailable] = useState<boolean | null>(null);
  const [chat, setChat] = useState<MissionChatSnapshot | null>(null);
  const [workRecords, setWorkRecords] = useState<readonly MissionWorkRecord[]>([]);
  const [workConversation, setWorkConversation] = useState<MissionWorkConversationSnapshot | null>(
    null,
  );
  const [workConversationLoading, setWorkConversationLoading] = useState(false);
  const [selectedWorkKey, setSelectedWorkKey] = useState<string | null>(null);
  const [workError, setWorkError] = useState<string | null>(null);
  const [workRefreshRevision, setWorkRefreshRevision] = useState(0);
  const [draft, setDraft] = useState(() =>
    props.mission.lifecycleStatus === "active"
      ? readMissionDraft(
          typeof window === "undefined" ? undefined : window.localStorage,
          props.mission.id,
        )
      : "",
  );
  const [optimisticMessages, setOptimisticMessages] = useState<LocalMissionUserMessage[]>([]);
  const [contextOperations, setContextOperations] = useState<LocalMissionContextOperation[]>([]);
  const [awaitingRequestId, setAwaitingRequestId] = useState<string | null>(null);
  const [clientOperation, setClientOperation] = useState<MissionClientOperationState>({
    kind: "idle",
  });
  const [models, setModels] = useState<readonly DesktopRuntimeModel[]>([]);
  const [runtimeIdentity, setRuntimeIdentity] = useState<RuntimeDisplayIdentity>();
  const [modelsLoading, setModelsLoading] = useState(false);
  const [defaultModelSelection, setDefaultModelSelection] = useState<MissionModelOverride>();
  const [modelResetRequired, setModelResetRequired] = useState(false);
  const modelRuntimeIdRef = useRef<string | undefined>(undefined);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [toolPermissionMode, setToolPermissionMode] = useState<DesktopToolPermissionMode>(
    props.mission.toolPermissionMode,
  );
  const [modelOverride, setModelOverride] = useState<MissionModelOverride | undefined>(
    props.mission.modelOverride,
  );
  const [interrupting, setInterrupting] = useState(false);
  const [responding, setResponding] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [humanQuestionIndex, setHumanQuestionIndex] = useState(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [humanNotes, setHumanNotes] = useState<Record<string, string>>({});
  const [humanAnswers, setHumanAnswers] = useState<
    Record<string, Record<string, string | readonly string[]>>
  >({});
  const isTeam = props.mission.executor.kind === "team";
  const isFlow = props.mission.executor.kind === "flow";
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const draftMissionIdRef = useRef<string | null>(props.mission.id);
  const chatRef = useRef<MissionChatSnapshot | null>(null);
  const receivedFirstTokensRef = useRef(new Set<string>());
  const paintedFirstTokensRef = useRef(new Set<string>());
  const pendingFirstTokenPaintsRef = useRef(new Map<string, { readonly receivedAt: number }>());
  const firstTokenPaintFramesRef = useRef(new Map<string, number[]>());
  const clientOperationRef = useRef<MissionClientOperationState>({ kind: "idle" });
  const autoRestoreExecutionRef = useRef<string | null>(null);
  const followLatestRef = useRef(true);
  const prependScrollHeightRef = useRef<number | null>(null);
  const updateChat = useCallback((update: SetStateAction<MissionChatSnapshot | null>) => {
    const next = typeof update === "function" ? update(chatRef.current) : update;
    chatRef.current = next;
    setChat(next);
  }, []);
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
    draftMissionIdRef.current = null;
    setDraft(
      props.mission.lifecycleStatus === "active"
        ? readMissionDraft(
            typeof window === "undefined" ? undefined : window.localStorage,
            props.mission.id,
          )
        : "",
    );
    setOptimisticMessages([]);
    setContextOperations([]);
    setAwaitingRequestId(null);
    setOptionsError(null);
    clientOperationRef.current = { kind: "idle" };
    setClientOperation(clientOperationRef.current);
    setSelectedWorkKey(null);
    setWorkRecords([]);
    setWorkConversation(null);
    setWorkError(null);
    autoRestoreExecutionRef.current = null;
  }, [props.mission.id]);

  useEffect(() => {
    if (draftMissionIdRef.current === null) {
      draftMissionIdRef.current = props.mission.id;
      return;
    }
    if (draftMissionIdRef.current !== props.mission.id) return;
    writeMissionDraft(
      typeof window === "undefined" ? undefined : window.localStorage,
      props.mission.id,
      draft,
    );
  }, [draft, props.mission.id]);

  useEffect(() => {
    if (props.mission.lifecycleStatus !== "completed") return;
    setDraft("");
    writeMissionDraft(
      typeof window === "undefined" ? undefined : window.localStorage,
      props.mission.id,
      "",
    );
  }, [props.mission.id, props.mission.lifecycleStatus]);

  useEffect(() => {
    if (optionsSaving) return;
    setToolPermissionMode(props.mission.toolPermissionMode);
    setModelOverride(props.mission.modelOverride);
  }, [optionsSaving, props.mission.modelOverride, props.mission.toolPermissionMode]);

  useEffect(() => {
    const api = desktopApi();
    setModels([]);
    setRuntimeIdentity(undefined);
    setDefaultModelSelection(undefined);
    setOptionsError(null);
    setModelResetRequired(false);
    modelRuntimeIdRef.current = undefined;
    if (api === undefined || isFlow) return;
    let cancelled = false;
    const loadModelOptions = (showLoading: boolean) => {
      if (showLoading) setModelsLoading(true);
      void api
        .getMissionModelOptions(props.mission.executor.ref, props.mission.id)
        .then((result) => {
          if (cancelled) return;
          modelRuntimeIdRef.current = result.runtime.id;
          setRuntimeIdentity(result.runtime);
          setModels(result.models);
          setDefaultModelSelection(result.defaultSelection);
          setModelResetRequired(result.status === "reset_required");
          setOptionsError(null);
        })
        .catch((loadError: unknown) => {
          if (!cancelled) setOptionsError(errorMessage(loadError));
        })
        .finally(() => {
          if (!cancelled && showLoading) setModelsLoading(false);
        });
    };
    const unsubscribe = api.subscribeRuntimeModelCatalog((runtimeId) => {
      if (modelRuntimeIdRef.current === undefined || modelRuntimeIdRef.current === runtimeId) {
        loadModelOptions(false);
      }
    });
    loadModelOptions(true);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isFlow, props.mission.executor.ref, props.mission.id]);

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
    const api = desktopApi();
    updateChat(null);
    setHistoryError(null);
    setHumanQuestionIndex(0);
    followLatestRef.current = true;
    setShowJumpToLatest(false);
    if (api === undefined) return;
    let cancelled = false;
    let refreshing = false;
    let refreshQueued = false;
    let frame: number | undefined;
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: MissionChatUpdate[] = [];
    receivedFirstTokensRef.current.clear();
    paintedFirstTokensRef.current.clear();
    pendingFirstTokenPaintsRef.current.clear();
    for (const frames of firstTokenPaintFramesRef.current.values()) {
      for (const paintFrame of frames) cancelAnimationFrame(paintFrame);
    }
    firstTokenPaintFramesRef.current.clear();

    const drainPending = (
      base: MissionChatSnapshot,
    ): { readonly snapshot: MissionChatSnapshot; readonly needsRefresh: boolean } => {
      const updates = pending.toSorted((left, right) => left.revision - right.revision);
      pending = [];
      let snapshot = base;
      for (let index = 0; index < updates.length; index += 1) {
        const update = updates[index]!;
        if (update.revision <= snapshot.revision) continue;
        if (update.revision !== snapshot.revision + 1 || update.kind === "invalidate") {
          pending.push(...updates.slice(index));
          return { snapshot, needsRefresh: true };
        }
        const next = applyMissionChatPatches(snapshot, update.patches, update.revision);
        if (next === null) {
          pending.push(...updates.slice(index));
          return { snapshot, needsRefresh: true };
        }
        snapshot = next;
      }
      return { snapshot, needsRefresh: false };
    };

    const flush = (): void => {
      frame = undefined;
      if (hiddenTimer !== undefined) {
        clearTimeout(hiddenTimer);
        hiddenTimer = undefined;
      }
      if (cancelled || chatRef.current === null || pending.length === 0) return;
      const drained = drainPending(chatRef.current);
      updateChat(drained.snapshot);
      if (drained.needsRefresh) void refresh();
    };

    const scheduleFlush = (): void => {
      if (frame !== undefined || hiddenTimer !== undefined || cancelled) return;
      if (document.visibilityState === "hidden") {
        hiddenTimer = setTimeout(flush, 100);
      } else {
        frame = requestAnimationFrame(flush);
      }
    };

    const flushVisibleFirstPatch = (): void => {
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
        frame = undefined;
      }
      if (hiddenTimer !== undefined) {
        clearTimeout(hiddenTimer);
        hiddenTimer = undefined;
      }
      flushSync(flush);
    };

    const refresh = async (): Promise<void> => {
      if (refreshing) {
        refreshQueued = true;
        return;
      }
      refreshing = true;
      try {
        const snapshot = await api.getMissionChat({ id: props.mission.id, limit: 50 });
        if (!cancelled) {
          pending = pending.filter((update) => update.revision > snapshot.revision);
          const merged = mergeLatestChatPage(chatRef.current, snapshot);
          const drained = drainPending(merged);
          updateChat(drained.snapshot);
          if (drained.needsRefresh) refreshQueued = true;
        }
      } catch (loadError) {
        if (!cancelled) console.error("Failed to refresh Mission chat.", loadError);
      } finally {
        refreshing = false;
        if (refreshQueued && !cancelled) {
          refreshQueued = false;
          void refresh();
        }
      }
    };
    const unsubscribe = api.subscribeMissionChat(props.mission.id, (update) => {
      pending.push(update);
      const executionId = firstVisiblePatchExecutionId(update, chatRef.current);
      if (executionId !== undefined && !receivedFirstTokensRef.current.has(executionId)) {
        receivedFirstTokensRef.current.add(executionId);
        const receivedAt = performance.now();
        pendingFirstTokenPaintsRef.current.set(executionId, { receivedAt });
        api.reportRendererLog({
          level: "info",
          event: "mission.first_ui_token_received",
          message: "Renderer received the first UI-visible Mission token",
          missionId: props.mission.id,
          executionId,
        });
        if (document.visibilityState !== "hidden" && chatRef.current !== null) {
          flushVisibleFirstPatch();
          return;
        }
      }
      scheduleFlush();
    });
    void refresh().catch(() => undefined);
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
    };
  }, [props.mission.id, updateChat]);

  useLayoutEffect(() => {
    const api = desktopApi();
    const container = scrollRef.current;
    if (api === undefined || container === null || document.visibilityState === "hidden") return;
    const renderedExecutions = new Set(
      [...container.querySelectorAll<HTMLElement>("[data-mission-execution-id]")]
        .map((element) => element.dataset.missionExecutionId)
        .filter((executionId): executionId is string => executionId !== undefined),
    );
    for (const [executionId, pendingPaint] of pendingFirstTokenPaintsRef.current) {
      if (
        paintedFirstTokensRef.current.has(executionId) ||
        firstTokenPaintFramesRef.current.has(executionId) ||
        !renderedExecutions.has(executionId)
      ) {
        continue;
      }
      const frames: number[] = [];
      const paintFrame = requestAnimationFrame(() => {
        const confirmationFrame = requestAnimationFrame(() => {
          if (
            document.visibilityState === "hidden" ||
            ![...container.querySelectorAll<HTMLElement>("[data-mission-execution-id]")].some(
              (element) => element.dataset.missionExecutionId === executionId,
            )
          ) {
            firstTokenPaintFramesRef.current.delete(executionId);
            return;
          }
          paintedFirstTokensRef.current.add(executionId);
          pendingFirstTokenPaintsRef.current.delete(executionId);
          firstTokenPaintFramesRef.current.delete(executionId);
          api.reportRendererLog({
            level: "info",
            event: "mission.first_ui_token_painted",
            message: "Renderer painted the first UI-visible Mission token",
            missionId: props.mission.id,
            executionId,
            elapsedMs: Math.round((performance.now() - pendingPaint.receivedAt) * 100) / 100,
          });
        });
        frames.push(confirmationFrame);
      });
      frames.push(paintFrame);
      firstTokenPaintFramesRef.current.set(executionId, frames);
    }
  }, [chat?.revision, props.mission.id]);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined || tab !== "work" || props.mission.execution === undefined) {
      setWorkRecords([]);
      setWorkConversation(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const snapshot = await api.getMissionWork(props.mission.id);
        if (cancelled) return;
        setWorkError(null);
        setWorkRecords(snapshot.records);
        if (selectedWorkKey !== null) {
          setWorkConversationLoading(true);
          const conversation = await api.getMissionWorkConversation({
            id: props.mission.id,
            recordId: selectedWorkKey,
            limit: 100,
          });
          if (!cancelled) {
            setWorkConversation((current) =>
              current === null || current.recordId !== conversation.recordId
                ? conversation
                : {
                    ...conversation,
                    entries: uniqueChatEntries([...current.entries, ...conversation.entries]),
                    nextBeforeCursor: current.nextBeforeCursor,
                  },
            );
          }
        }
      } catch (loadError) {
        if (!cancelled) {
          console.error("Failed to refresh Mission work history.", loadError);
          setWorkError(errorMessage(loadError));
        }
      } finally {
        if (!cancelled) setWorkConversationLoading(false);
      }
    };
    const scheduleRefresh = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 50);
    };
    const unsubscribe = api.subscribeMissionWork(props.mission.id, scheduleRefresh);
    void refresh();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
    };
  }, [props.mission.id, props.mission.execution?.id, selectedWorkKey, tab, workRefreshRevision]);

  const beginClientOperation = (
    kind: Exclude<MissionClientOperationState["kind"], "idle">,
  ): string | undefined => {
    const token = crypto.randomUUID();
    const claimed = claimMissionClientOperation(clientOperationRef.current, kind, token);
    if (claimed === null) return undefined;
    clientOperationRef.current = claimed;
    setClientOperation(claimed);
    return token;
  };

  const finishClientOperation = (token: string): void => {
    const released = releaseMissionClientOperation(clientOperationRef.current, token);
    if (released === clientOperationRef.current) return;
    clientOperationRef.current = released;
    setClientOperation(released);
  };

  const send = async () => {
    const content = draft.trim();
    if (content === "" || executionActive || isFlow) return;
    const operationToken = beginClientOperation("sending");
    if (operationToken === undefined) return;
    const requestId = crypto.randomUUID();
    const optimistic: LocalMissionUserMessage = {
      id: requestId,
      content,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    setDraft("");
    setOptimisticMessages((current) => [...current, optimistic]);
    setAwaitingRequestId(requestId);
    followLatestRef.current = true;
    try {
      await props.onSend?.(content, requestId);
    } catch {
      const api = desktopApi();
      const snapshot =
        api === undefined
          ? undefined
          : await api.getMissionChat({ id: props.mission.id, limit: 50 }).catch(() => undefined);
      if (snapshot !== undefined) updateChat((current) => mergeLatestChatPage(current, snapshot));
      const persisted = snapshot?.entries.some((entry) => entry.id === requestId) ?? false;
      setOptimisticMessages((current) =>
        persisted
          ? current.filter((message) => message.id !== requestId)
          : current.map((message) =>
              message.id === requestId ? { ...message, status: "failed" } : message,
            ),
      );
      setAwaitingRequestId(null);
    } finally {
      finishClientOperation(operationToken);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  const saveOptions = async (
    nextToolPermissionMode: DesktopToolPermissionMode,
    nextModelOverride: MissionModelOverride | undefined,
  ) => {
    if (controlsDisabled) return;
    const operationToken = beginClientOperation("saving_options");
    if (operationToken === undefined) return;
    const previousToolPermissionMode = toolPermissionMode;
    const previousModelOverride = modelOverride;
    setToolPermissionMode(nextToolPermissionMode);
    setModelOverride(nextModelOverride);
    try {
      await props.onOptionsChange?.({
        toolPermissionMode: nextToolPermissionMode,
        ...(nextModelOverride === undefined ? {} : { modelOverride: nextModelOverride }),
      });
      setOptionsError(null);
    } catch {
      setToolPermissionMode(previousToolPermissionMode);
      setModelOverride(previousModelOverride);
    } finally {
      finishClientOperation(operationToken);
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

  const compactContext = async (retryOperationId?: string) => {
    const api = desktopApi();
    if (api === undefined || chat?.contextWindow?.canCompact !== true) return;
    const operationToken = beginClientOperation("compacting");
    if (operationToken === undefined) return;
    const operationId = retryOperationId ?? crypto.randomUUID();
    setContextOperations((current) =>
      startMissionContextOperation(current, {
        id: operationId,
        createdAt: new Date().toISOString(),
        retry: retryOperationId !== undefined,
      }),
    );
    followLatestRef.current = true;
    try {
      const result = await api.compactMissionContext(props.mission.id);
      updateChat((current) =>
        current === null ? current : { ...current, contextWindow: result.contextWindow },
      );
      setContextOperations((current) =>
        current.map((operation) =>
          operation.id === operationId
            ? {
                ...operation,
                status: result.outcome === "compacted" ? "succeeded" : "skipped",
              }
            : operation,
        ),
      );
    } catch (compactError) {
      setContextOperations((current) =>
        current.map((operation) =>
          operation.id === operationId
            ? { ...operation, status: "failed", error: errorMessage(compactError) }
            : operation,
        ),
      );
    } finally {
      finishClientOperation(operationToken);
    }
  };

  const respond = async (
    interaction: MissionHumanInteraction,
    response: HumanInteractionResponse,
  ) => {
    const api = desktopApi();
    if (api === undefined || responding) return;
    setResponding(true);
    try {
      await api.respondToMissionHumanInteraction({
        missionId: props.mission.id,
        interactionId: interaction.interactionId,
        requestId: crypto.randomUUID(),
        response,
      });
      updateChat((current) =>
        current === null
          ? current
          : {
              ...current,
              pendingInteractions: current.pendingInteractions.filter(
                (item) => item.interactionId !== interaction.interactionId,
              ),
            },
      );
      setHumanQuestionIndex(0);
      setHumanNotes((current) => {
        const next = { ...current };
        delete next[interaction.interactionId];
        return next;
      });
      setHumanAnswers((current) => {
        const next = { ...current };
        delete next[interaction.interactionId];
        return next;
      });
      await props.onHumanResponded?.();
    } finally {
      setResponding(false);
    }
  };

  const displayEntries = chat?.entries ?? [];
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
  const selectedWorkRecord = useMemo(
    () => workRecords.find((record) => record.recordId === selectedWorkKey),
    [selectedWorkKey, workRecords],
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

  useEffect(() => {
    if (durableEntryIds.size === 0) return;
    setOptimisticMessages((current) =>
      current.filter((message) => !durableEntryIds.has(message.id)),
    );
  }, [durableEntryIds]);

  useEffect(() => {
    if (awaitingRequestId === null || chat === null) return;
    if (shouldClearMissionThinkingPlaceholder(chat, awaitingRequestId)) {
      setAwaitingRequestId(null);
    }
  }, [awaitingRequestId, chat]);

  useEffect(() => {
    if (selectedWorkKey === null) return;
    if (selectedWorkRecord === undefined) setSelectedWorkKey(null);
  }, [selectedWorkKey, selectedWorkRecord]);

  useEffect(() => {
    if (selectedWorkRecord === undefined) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedWorkKey(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selectedWorkRecord]);

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
    const api = desktopApi();
    const beforeSequence = chat?.page.nextBeforeSequence;
    if (api === undefined || beforeSequence === undefined || loadingEarlier) return;
    setLoadingEarlier(true);
    setHistoryError(null);
    const element = scrollRef.current;
    prependScrollHeightRef.current = element?.scrollHeight ?? null;
    followLatestRef.current = false;
    try {
      const earlier = await api.getMissionChat({
        id: props.mission.id,
        beforeSequence,
        limit: 50,
      });
      updateChat((current) => (current === null ? earlier : prependChatPage(current, earlier)));
    } catch (loadError) {
      setHistoryError(errorMessage(loadError));
    } finally {
      setLoadingEarlier(false);
    }
  };

  const loadEarlierWorkConversation = async (): Promise<void> => {
    const api = desktopApi();
    if (
      api === undefined ||
      selectedWorkRecord === undefined ||
      workConversation?.nextBeforeCursor === undefined ||
      workConversationLoading
    ) {
      return;
    }
    setWorkConversationLoading(true);
    try {
      const earlier = await api.getMissionWorkConversation({
        id: props.mission.id,
        recordId: selectedWorkRecord.recordId,
        beforeCursor: workConversation.nextBeforeCursor,
        limit: 100,
      });
      setWorkConversation((current) =>
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
      setWorkConversationLoading(false);
    }
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
      element.scrollTop = element.scrollHeight;
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
  ]);

  return (
    <section className="mission-detail">
      <header className="mission-detail-header">
        <div>
          <h1 title={props.mission.title}>{props.mission.title}</h1>
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
          </p>
        </div>
        <div className="mission-header-actions">
          {props.mission.lifecycleStatus === "active" &&
          (props.mission.execution === undefined ||
            (!executionActive && isFlow) ||
            (executionActive && !interruptible)) ? (
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
          <button
            className="secondary-button"
            type="button"
            disabled={clientOperationBusy}
            onClick={() => void props.onLifecycleChange?.()}
          >
            {props.mission.lifecycleStatus === "active" ? (
              <>
                <CheckCircle size={17} aria-hidden="true" />
                {t("markComplete", { ns: "missions" })}
              </>
            ) : (
              <>
                <ArrowCounterClockwise size={17} aria-hidden="true" />
                {t("reopen", { ns: "missions" })}
              </>
            )}
          </button>
        </div>
      </header>
      <div
        className="mission-detail-tabs"
        role="tablist"
        aria-label={t("detailViews", { ns: "missions" })}
      >
        <button
          className={tab === "chat" ? "is-active" : ""}
          type="button"
          role="tab"
          aria-selected={tab === "chat"}
          onClick={() => setTab("chat")}
        >
          {isTeam ? t("teamChannel", { ns: "missions" }) : t("chat", { ns: "missions" })}
        </button>
        <button
          className={tab === "work" ? "is-active" : ""}
          type="button"
          role="tab"
          aria-selected={tab === "work"}
          onClick={() => setTab("work")}
        >
          {t("work", { ns: "missions" })}
        </button>
      </div>
      <div className="mission-detail-body">
        {tab !== "chat" && presentedError !== null && presentedError !== undefined ? (
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
        {tab === "chat" ? (
          <div className="mission-chat-shell">
            <div
              className="mission-chat-scroll"
              ref={scrollRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                const nearBottom =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 72;
                followLatestRef.current = nearBottom;
                if (nearBottom) setShowJumpToLatest(false);
              }}
            >
              <div className="mission-chat-list">
                {chat?.page.nextBeforeSequence !== undefined ? (
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
                      key={block.item.entry.id}
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
                      paintExecutionId={block.item.entry.executionId ?? chat?.execution?.id}
                    />
                  );
                })}
                {showThinkingPlaceholder ? (
                  <MissionThinkingPlaceholder executorName={props.mission.executor.name} />
                ) : null}
              </div>
              {showJumpToLatest ? (
                <button
                  className="mission-jump-latest"
                  type="button"
                  onClick={() => {
                    const element = scrollRef.current;
                    if (element !== null) element.scrollTop = element.scrollHeight;
                    followLatestRef.current = true;
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
              {missionFooterTip(props.mission, chat) ? (
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
              {modelResetRequired ? (
                <small className="mission-chat-footer-tip mission-model-reset-note" role="status">
                  <span>{t("modelConfigurationResetRequired", { ns: "missions" })}</span>
                  <button className="text-button" type="button" onClick={props.onConfigureModels}>
                    {t("configureModels", { ns: "missions" })}
                  </button>
                </small>
              ) : null}
              {interactions[0] !== undefined ? (
                <MissionHumanComposer
                  interaction={interactions[0]}
                  answers={humanAnswers[interactions[0].interactionId] ?? {}}
                  notes={humanNotes[interactions[0].interactionId] ?? ""}
                  questionIndex={humanQuestionIndex}
                  interactionPosition={{ current: 1, total: interactions.length }}
                  responding={responding}
                  interruptible={interruptible}
                  interrupting={interrupting}
                  onQuestionIndex={setHumanQuestionIndex}
                  onAnswer={(question, value) =>
                    setHumanAnswer(setHumanAnswers, interactions[0]!.interactionId, question, value)
                  }
                  onNotes={(value) =>
                    setHumanNotes((current) => ({
                      ...current,
                      [interactions[0]!.interactionId]: value,
                    }))
                  }
                  onRespond={(response) => void respond(interactions[0]!, response)}
                  onInterrupt={() => void interrupt()}
                />
              ) : (
                <>
                  <MissionUsageHint
                    missionId={props.mission.id}
                    executionActive={executionActive}
                  />
                  <div className="mission-chat-composer" aria-busy={clientOperationBusy}>
                    <textarea
                      ref={textareaRef}
                      rows={1}
                      value={draft}
                      disabled={
                        isFlow ||
                        clientOperationBusy ||
                        compactingContext ||
                        executionActive ||
                        props.mission.lifecycleStatus === "completed"
                      }
                      placeholder={
                        compactingContext
                          ? t("contextCompactionInputDisabled", { ns: "missions" })
                          : executionActive
                            ? interruptible
                              ? t("executorWorking", {
                                  ns: "missions",
                                  name: props.mission.executor.name,
                                })
                              : t("resumeToManage", { ns: "missions" })
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
                      onKeyDown={(event) => {
                        if (shouldSubmitComposerOnEnter(event.nativeEvent)) {
                          event.preventDefault();
                          void send();
                        }
                      }}
                    />
                    <div className="mission-chat-composer-toolbar">
                      <div className="mission-chat-options" aria-label={t("missionOptions")}>
                        {!isFlow ? (
                          <MissionModelOverrideControls
                            models={models}
                            loading={modelsLoading}
                            disabled={controlsDisabled}
                            value={modelOverride}
                            defaultValue={defaultModelSelection}
                            onChange={(value) => void saveOptions(toolPermissionMode, value)}
                          />
                        ) : null}
                        <ToolPermissionSelect
                          value={toolPermissionMode}
                          disabled={controlsDisabled}
                          title={
                            executionActive
                              ? t("optionsAvailableNextTurn", { ns: "missions" })
                              : t("permissionOverride", { ns: "missions" })
                          }
                          onChange={(value) => void saveOptions(value, modelOverride)}
                        />
                      </div>
                      <div className="mission-chat-actions">
                        {chat?.contextWindow === undefined ? null : (
                          <ContextWindowControl
                            state={chat.contextWindow}
                            compacting={compactingContext}
                            onCompact={() => void compactContext()}
                          />
                        )}
                        {executionActive ? (
                          <button
                            className="is-interrupt"
                            type="button"
                            aria-label={t("interrupt", { ns: "missions" })}
                            title={
                              interruptible
                                ? t("interrupt", { ns: "missions" })
                                : t("resumeBeforeInterrupt", { ns: "missions" })
                            }
                            disabled={!interruptible || interrupting}
                            onClick={() => void interrupt()}
                          >
                            <StopCircle size={19} weight="fill" aria-hidden="true" />
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
                            <PaperPlaneTilt size={18} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        ) : workError !== null && workRecords.length === 0 ? (
          <div className="mission-work-empty" role="alert">
            <WarningCircle size={31} weight="thin" aria-hidden="true" />
            <h2>{t("workHistoryUnavailable", { ns: "missions" })}</h2>
            <p>{workError}</p>
            <button
              className="mission-load-earlier"
              type="button"
              onClick={() => setWorkRefreshRevision((current) => current + 1)}
            >
              {t("actions.retry", { ns: "common" })}
            </button>
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
          <div className="mission-work-list" aria-label={t("executionWork", { ns: "missions" })}>
            <header>
              <h2>{t("executionMap", { ns: "missions" })}</h2>
              <p>{t("executionMapDescription", { ns: "missions" })}</p>
            </header>
            <ol>
              {workRecords.map((record) => (
                <li
                  key={record.recordId}
                  style={
                    {
                      "--mission-work-depth": workRecordDepth(record, workRecords),
                    } as CSSProperties
                  }
                >
                  <button
                    type="button"
                    onClick={() => {
                      setWorkConversation(null);
                      setSelectedWorkKey(record.recordId);
                    }}
                  >
                    <span
                      className={`mission-work-status is-${record.status}`}
                      aria-hidden="true"
                    />
                    <div>
                      <strong>{missionWorkRecordTitle(record)}</strong>
                      <small>
                        {record.kind} · {workStatusLabel(record.status)}
                        {record.tasks.length > 1
                          ? ` · ${t("conversationTurns", {
                              ns: "missions",
                              count: record.tasks.length,
                            })}`
                          : ""}
                      </small>
                      <p>{record.summary}</p>
                    </div>
                    <CaretDown size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
          </div>
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
          onClose={() => setSelectedWorkKey(null)}
        />
      )}
    </section>
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

function LocalMissionUserMessageView(props: { readonly message: LocalMissionUserMessage }) {
  const { t } = useTranslation("missions");
  return (
    <div
      className={
        props.message.status === "failed"
          ? "mission-user-message is-local is-failed"
          : "mission-user-message is-local"
      }
    >
      <div>
        <MissionMessageContent source={props.message.content} />
        {props.message.status === "failed" ? <small>{t("messageSendFailed")}</small> : null}
      </div>
    </div>
  );
}

export function MissionContextOperationEntry(props: {
  readonly operation:
    | LocalMissionContextOperation
    | Extract<MissionChatEntry, { kind: "context_operation" }>;
  readonly retryDisabled?: boolean | undefined;
  readonly onRetry?: (() => void) | undefined;
}) {
  const { t } = useTranslation(["missions", "common"]);
  const failed = props.operation.status === "failed";
  return (
    <div
      className={`mission-context-operation is-${props.operation.status}`}
      role={failed ? "alert" : "status"}
      aria-live="polite"
    >
      {props.operation.status === "running" ? (
        <SpinnerGap className="spin" size={17} aria-hidden="true" />
      ) : failed ? (
        <WarningCircle size={17} weight="fill" aria-hidden="true" />
      ) : (
        <CheckCircle size={17} weight="fill" aria-hidden="true" />
      )}
      <span>
        <strong>
          {props.operation.status === "running"
            ? t("contextCompactionStarted", { ns: "missions" })
            : failed
              ? t("contextCompactionFailed", { ns: "missions" })
              : props.operation.status === "skipped"
                ? t("contextCompactionNotNeeded", { ns: "missions" })
                : t("contextCompactionCompleted", { ns: "missions" })}
        </strong>
        {props.operation.error === undefined ? null : <small>{props.operation.error}</small>}
      </span>
      {failed && props.onRetry !== undefined ? (
        <button type="button" disabled={props.retryDisabled} onClick={props.onRetry}>
          {t("actions.retry", { ns: "common" })}
        </button>
      ) : null}
    </div>
  );
}

function MissionThinkingPlaceholder(props: { readonly executorName: string }) {
  const { t } = useTranslation("missions");
  return (
    <div className="mission-assistant-message mission-thinking-placeholder" aria-live="polite">
      <p>
        <SpinnerGap size={17} aria-hidden="true" />
        {t("thinkingActive", { name: props.executorName })}
      </p>
    </div>
  );
}

const MissionChatEntryView = memo(function MissionChatEntryView(props: {
  readonly entry: MissionChatEntry;
  readonly userLabel?: string | undefined;
  readonly paintExecutionId?: string | undefined;
}) {
  if (props.entry.kind === "user") {
    return (
      <div className="mission-user-message">
        <div>
          {props.userLabel === undefined ? null : (
            <small className="mission-message-sender">{props.userLabel}</small>
          )}
          <MissionMessageContent source={props.entry.content} />
        </div>
      </div>
    );
  }
  if (props.entry.kind === "thinking") {
    return <MissionThinkingEntry entry={props.entry} paintExecutionId={props.paintExecutionId} />;
  }
  if (props.entry.kind === "tool") {
    return <MissionToolCallEntry entry={props.entry} />;
  }
  if (props.entry.kind === "agent_activity") {
    return <MissionAgentActivityEntry entry={props.entry} />;
  }
  if (props.entry.kind === "context_operation") {
    return <MissionContextOperationEntry operation={props.entry} retryDisabled={false} />;
  }
  return (
    <div className="mission-assistant-message" data-mission-execution-id={props.paintExecutionId}>
      <MissionMessageContent source={props.entry.content} />
    </div>
  );
});

function MissionAgentActivityEntry(props: {
  readonly entry: Extract<MissionChatEntry, { kind: "agent_activity" }>;
}) {
  const { t } = useTranslation("missions");
  const status =
    props.entry.phase === "started"
      ? t("statusRunning")
      : props.entry.phase === "completed"
        ? t("statusCompleted")
        : t("statusFailed");
  const target = props.entry.label ?? props.entry.targetSessionIds.at(0);
  return (
    <div className={`mission-chat-activity mission-agent-activity is-${props.entry.phase}`}>
      <UsersThree size={17} aria-hidden="true" />
      <span>
        {t(`agentAction.${props.entry.action}`)}
        {target === undefined ? null : <small>{target}</small>}
      </span>
      <small>{status}</small>
      {props.entry.error === undefined ? null : <p role="alert">{props.entry.error}</p>}
    </div>
  );
}

export function MissionThinkingEntry(props: {
  readonly entry: Extract<MissionChatEntry, { kind: "thinking" }>;
  readonly paintExecutionId?: string | undefined;
}) {
  const { t } = useTranslation("missions");
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const streaming = props.entry.streaming === true;
  const showsFullContent = streaming || expanded;

  return (
    <div
      className={`mission-thinking-entry${showsFullContent ? " is-expanded" : ""}${
        streaming ? " is-streaming" : ""
      }`}
      data-mission-execution-id={props.paintExecutionId ?? props.entry.executionId}
      aria-live={streaming ? "polite" : undefined}
    >
      <p id={contentId}>{props.entry.content}</p>
      {streaming ? null : (
        <button
          type="button"
          aria-controls={contentId}
          aria-expanded={expanded}
          aria-label={expanded ? t("collapseThinking") : t("expandThinking")}
          title={expanded ? t("collapseThinking") : t("expandThinking")}
          onClick={() => setExpanded((current) => !current)}
        >
          <CaretDown size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function MissionToolCallBlock(props: {
  readonly collapsed: boolean;
  readonly entries: readonly Extract<MissionChatEntry, { kind: "tool" }>[];
}) {
  const { t } = useTranslation("missions");
  if (props.entries.length === 1) return <MissionToolCallEntry entry={props.entries[0]!} />;
  if (!props.collapsed) {
    return (
      <div className="mission-tool-run">
        {props.entries.map((entry) => (
          <MissionToolCallEntry entry={entry} key={entry.id} />
        ))}
      </div>
    );
  }
  const status = toolGroupStatus(props.entries);
  return (
    <details className={`mission-chat-activity mission-tool-entry mission-tool-group is-${status}`}>
      <summary>
        <Toolbox size={16} aria-hidden="true" />
        <span>{t("toolCalls", { count: props.entries.length })}</span>
        <small>{toolStatusLabel(status)}</small>
        <CaretDown size={14} aria-hidden="true" />
      </summary>
      <div className="mission-tool-group-items">
        {props.entries.map((entry) => (
          <MissionToolCallEntry entry={entry} key={entry.id} />
        ))}
      </div>
    </details>
  );
}

function MissionToolCallEntry(props: {
  readonly entry: Extract<MissionChatEntry, { kind: "tool" }>;
}) {
  const { t } = useTranslation("missions");
  const className = `mission-chat-activity mission-tool-entry is-${props.entry.status}`;
  const hasDetails =
    props.entry.inputPreview !== undefined ||
    props.entry.outputPreview !== undefined ||
    props.entry.error !== undefined;
  const row = (
    <>
      <Toolbox size={16} aria-hidden="true" />
      <span>{props.entry.toolName}</span>
      <small>{toolStatusLabel(props.entry.status)}</small>
    </>
  );
  if (!hasDetails) {
    return (
      <div className={`${className} mission-tool-static-row`}>
        {row}
        <span aria-hidden="true" />
      </div>
    );
  }
  return (
    <details className={className}>
      <summary>
        {row}
        <CaretDown size={14} aria-hidden="true" />
      </summary>
      <div className="mission-tool-entry-details">
        {props.entry.inputPreview !== undefined ? (
          <section>
            <strong>{t("input")}</strong>
            <pre>{props.entry.inputPreview}</pre>
          </section>
        ) : null}
        {props.entry.outputPreview !== undefined ? (
          <section>
            <strong>{t("output")}</strong>
            <pre>{props.entry.outputPreview}</pre>
          </section>
        ) : null}
        {props.entry.error !== undefined ? <p role="alert">{props.entry.error}</p> : null}
      </div>
    </details>
  );
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
              {workStatusLabel(props.record.status)} ·{" "}
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

const MissionMessageContent = memo(function MissionMessageContent(props: {
  readonly source: string;
}) {
  return (
    <div className="mission-markdown">
      <MarkdownContent source={props.source} codeBlockControls />
    </div>
  );
});

type MissionHumanQuestion = NonNullable<MissionHumanInteraction["request"]["questions"]>[number];

function MissionHumanComposer(props: {
  readonly interaction: MissionHumanInteraction;
  readonly answers: Readonly<Record<string, string | readonly string[]>>;
  readonly notes: string;
  readonly questionIndex: number;
  readonly interactionPosition: { readonly current: number; readonly total: number };
  readonly responding: boolean;
  readonly interruptible: boolean;
  readonly interrupting: boolean;
  readonly onQuestionIndex: (index: number) => void;
  readonly onAnswer: (question: string, value: string | readonly string[]) => void;
  readonly onNotes: (value: string) => void;
  readonly onRespond: (response: HumanInteractionResponse) => void;
  readonly onInterrupt: () => void;
}) {
  const { t } = useTranslation(["missions", "common"]);
  const request = props.interaction.request;
  const questions = request.questions ?? [];
  const index = Math.min(props.questionIndex, Math.max(questions.length - 1, 0));
  const question = questions[index];
  const answer = question === undefined ? undefined : props.answers[question.question];
  const answerValid = question === undefined ? true : humanAnswerValid(question, answer);
  const choiceOnly =
    questions.length > 0 && questions.every((candidate) => candidate.kind !== "text");

  return (
    <section className="mission-human-composer" aria-labelledby="mission-human-title">
      <header>
        <div>
          <small>
            {t("userInputPosition", {
              ns: "missions",
              current: props.interactionPosition.current,
              total: props.interactionPosition.total,
            })}
          </small>
          <strong id="mission-human-title">
            {request.title ?? t("humanInputRequired", { ns: "missions" })}
          </strong>
          <p>{request.prompt ?? t("humanReview", { ns: "missions" })}</p>
        </div>
        <button
          className="mission-human-interrupt"
          type="button"
          disabled={!props.interruptible || props.interrupting}
          onClick={props.onInterrupt}
        >
          <StopCircle size={17} weight="fill" aria-hidden="true" />
          {t("interrupt", { ns: "missions" })}
        </button>
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
            {questions.length === 1 ? (
              <small>{question.header}</small>
            ) : (
              <small>
                {t("questionPosition", {
                  ns: "missions",
                  current: index + 1,
                  total: questions.length,
                  header: question.header,
                })}
              </small>
            )}
            <strong>{question.question}</strong>
            <HumanQuestionInput question={question} answer={answer} onAnswer={props.onAnswer} />
          </div>
          {choiceOnly ? null : (
            <textarea
              value={props.notes}
              onChange={(event) => props.onNotes(event.target.value)}
              placeholder={t("optionalNotes", { ns: "missions" })}
            />
          )}
          <footer>
            <button
              type="button"
              disabled={index === 0 || props.responding}
              onClick={() => props.onQuestionIndex(index - 1)}
            >
              {t("actions.back", { ns: "common" })}
            </button>
            {index < questions.length - 1 ? (
              <button
                className="primary-button"
                type="button"
                disabled={!answerValid || props.responding}
                onClick={() => props.onQuestionIndex(index + 1)}
              >
                {t("actions.next", { ns: "common" })}
              </button>
            ) : (
              <button
                className="primary-button"
                type="button"
                disabled={!answerValid || props.responding}
                onClick={() =>
                  props.onRespond({
                    answers: props.answers,
                    notes: props.notes,
                  })
                }
              >
                {props.responding
                  ? t("submitting", { ns: "missions" })
                  : t("submitResponse", { ns: "missions" })}
              </button>
            )}
          </footer>
        </>
      )}
    </section>
  );
}

function HumanQuestionInput(props: {
  readonly question: MissionHumanQuestion;
  readonly answer: string | readonly string[] | undefined;
  readonly onAnswer: (question: string, value: string | readonly string[]) => void;
}) {
  if (props.question.kind === "text") {
    return (
      <textarea
        value={typeof props.answer === "string" ? props.answer : ""}
        onChange={(event) => props.onAnswer(props.question.question, event.target.value)}
        autoFocus
      />
    );
  }
  if (props.question.kind === "single_choice") {
    return (
      <div className="mission-human-options">
        {props.question.options.map((option) => (
          <button
            className={props.answer === option.label ? "is-selected" : ""}
            type="button"
            key={option.label}
            onClick={() => props.onAnswer(props.question.question, option.label)}
          >
            <strong>{option.label}</strong>
            {option.description === "" ? null : <small>{option.description}</small>}
          </button>
        ))}
      </div>
    );
  }
  const selected = Array.isArray(props.answer) ? props.answer : [];
  return (
    <div className="mission-human-options is-multiple">
      {props.question.options.map((option) => (
        <label key={option.label}>
          <input
            type="checkbox"
            checked={selected.includes(option.label)}
            onChange={(event) =>
              props.onAnswer(
                props.question.question,
                event.target.checked
                  ? [...selected, option.label]
                  : selected.filter((value) => value !== option.label),
              )
            }
          />
          <span>
            <strong>{option.label}</strong>
            {option.description === "" ? null : <small>{option.description}</small>}
          </span>
        </label>
      ))}
    </div>
  );
}

function humanAnswerValid(
  question: MissionHumanQuestion,
  answer: string | readonly string[] | undefined,
): boolean {
  if (question.kind === "multiple_choice") return Array.isArray(answer) && answer.length > 0;
  return typeof answer === "string" && answer.trim() !== "";
}

function entryContentLength(entry: MissionChatEntry): number {
  if (entry.kind === "tool") {
    return (entry.inputPreview?.length ?? 0) + (entry.outputPreview?.length ?? 0);
  }
  if (entry.kind === "agent_activity") return entry.label?.length ?? 0;
  if (entry.kind === "context_operation") return entry.error?.length ?? 0;
  return entry.content.length;
}

export function groupMissionConversationEntries(
  entries: readonly MissionConversationEntry[],
): MissionConversationBlock[] {
  const blocks: MissionConversationBlock[] = [];
  let pendingTools: Extract<MissionChatEntry, { kind: "tool" }>[] = [];
  const flushTools = (collapsed: boolean): void => {
    if (pendingTools.length === 0) return;
    blocks.push({ type: "tools", entries: pendingTools, collapsed });
    pendingTools = [];
  };

  for (const item of entries) {
    if (item.type === "durable" && item.entry.kind === "tool") {
      pendingTools.push(item.entry);
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
      const existingIndex = entries.findIndex((entry) => entry.id === patch.entry.id);
      if (existingIndex === -1) entries.push({ ...patch.entry });
      else {
        const existing = entries[existingIndex]!;
        entries[existingIndex] = {
          ...patch.entry,
          ...(patch.entry.timelineSequence === undefined && existing.timelineSequence !== undefined
            ? { timelineSequence: existing.timelineSequence }
            : {}),
          ...(patch.entry.executorName === undefined && existing.executorName !== undefined
            ? { executorName: existing.executorName }
            : {}),
        };
      }
      continue;
    }
    const index = entries.findIndex((entry) => entry.id === patch.entryId);
    if (index === -1) return null;
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

function firstVisiblePatchExecutionId(
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

function truncateChatStream(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function mergeLatestChatPage(
  current: MissionChatSnapshot | null,
  latest: MissionChatSnapshot,
): MissionChatSnapshot {
  if (current === null) return latest;
  const latestOldest = latest.page.oldestSequence;
  const retainedOlder =
    latestOldest === undefined
      ? []
      : current.entries.filter(
          (entry) => entry.timelineSequence !== undefined && entry.timelineSequence < latestOldest,
        );
  return { ...latest, entries: uniqueChatEntries([...retainedOlder, ...latest.entries]) };
}

function prependChatPage(
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
      ...(earlier.page.nextBeforeSequence === undefined
        ? {}
        : { nextBeforeSequence: earlier.page.nextBeforeSequence }),
    },
  };
}

function uniqueChatEntries(entries: readonly MissionChatEntry[]): MissionChatEntry[] {
  const byId = new Map<string, MissionChatEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
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

function toolStatusLabel(status: Extract<MissionChatEntry, { kind: "tool" }>["status"]): string {
  switch (status) {
    case "running":
      return i18n.t("statusRunning", { ns: "missions" });
    case "approval_required":
      return i18n.t("statusApproval", { ns: "missions" });
    case "succeeded":
      return i18n.t("statusCompleted", { ns: "missions" });
    case "failed":
      return i18n.t("statusFailed", { ns: "missions" });
  }
}

function toolGroupStatus(
  entries: readonly Extract<MissionChatEntry, { kind: "tool" }>[],
): Extract<MissionChatEntry, { kind: "tool" }>["status"] {
  if (entries.some((entry) => entry.status === "approval_required")) return "approval_required";
  if (entries.some((entry) => entry.status === "running")) return "running";
  if (entries.some((entry) => entry.status === "failed")) return "failed";
  return "succeeded";
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

function workStatusLabel(status: MissionWorkRecord["status"]): string {
  switch (status) {
    case "queued":
      return i18n.t("statusQueued", { ns: "missions" });
    case "running":
      return i18n.t("statusWorking", { ns: "missions" });
    case "waiting":
      return i18n.t("statusNeedsInput", { ns: "missions" });
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
      return i18n.t("statusNeedsInput", { ns: "missions" });
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

function missionToSummary(mission: Mission): MissionSummary {
  return {
    id: mission.id,
    title: mission.title,
    workspace: { basename: mission.workspace.basename },
    executor: { kind: mission.executor.kind, name: mission.executor.name },
    ...(mission.execution === undefined ? {} : { execution: { status: mission.execution.status } }),
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
  value: string | readonly string[],
): void {
  update((current) => ({
    ...current,
    [interactionId]: { ...current[interactionId], [question]: value },
  }));
}

function desktopApi(): PragmaDesktopAPI | undefined {
  return typeof window === "undefined" ? undefined : window.pragmaDesktop;
}
