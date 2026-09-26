import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import {
  CheckCircle,
  Circle,
  MagnifyingGlass,
  Plus,
  PushPin,
  SpinnerGap,
  Trash,
} from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { type MissionSummary } from "../../../../shared/contracts/index.ts";
import { i18n } from "../../i18n/index.ts";
import { formatMissionDateTime } from "../../lib/mission-time.ts";
import type { MissionListSource } from "./missions-page-state.tsx";
import { missionStatusLabel } from "./mission-page-utils.ts";

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

export function MissionDetailSkeleton(props: {
  readonly label: string;
  readonly title?: string | undefined;
}) {
  return (
    <div
      className="mission-detail-loading"
      role="status"
      aria-label={props.label}
      aria-live="polite"
    >
      <div className="mission-detail-loading-content" aria-hidden="true">
        <header>
          {props.title === undefined ? null : <h1>{props.title}</h1>}
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

export function MissionRail(props: {
  readonly missions: readonly MissionSummary[];
  readonly source: MissionListSource;
  readonly search: string;
  readonly pinnedMissionIds: readonly string[];
  readonly unreadMissionOutputIds: readonly string[];
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
  const unreadMissionOutputIdSet = useMemo(
    () => new Set(props.unreadMissionOutputIds),
    [props.unreadMissionOutputIds],
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
          pinnedMissionIds={pinnedMissionIdSet}
          unreadMissionOutputIds={unreadMissionOutputIdSet}
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
        pinnedMissionIds={pinnedMissionIdSet}
        unreadMissionOutputIds={unreadMissionOutputIdSet}
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
        pinnedMissionIds={pinnedMissionIdSet}
        unreadMissionOutputIds={unreadMissionOutputIdSet}
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

export type MissionRowIndicator = "failed" | "interrupted" | "unread";

export function resolveMissionRowIndicator(
  mission: MissionSummary,
  hasUnreadOutput: boolean,
): MissionRowIndicator | null {
  if (mission.execution?.status === "failed") return "failed";
  if (mission.execution?.status === "cancelled") return "interrupted";
  return hasUnreadOutput ? "unread" : null;
}

export const MISSION_ROW_PREVIEW_HOVER_DELAY_MS = 500;

const MISSION_ROW_PREVIEW_GAP = 8;

const MISSION_ROW_PREVIEW_VIEWPORT_MARGIN = 12;

type MissionRowPreviewPlacement = "right" | "left" | "bottom" | "top";

export interface MissionRowPreviewRect {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface MissionRowPreviewPosition {
  readonly left: number;
  readonly top: number;
  readonly placement: MissionRowPreviewPlacement;
}

export function clampMissionRowPreview(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function positionMissionRowPreview(input: {
  readonly anchor: MissionRowPreviewRect;
  readonly card: Pick<MissionRowPreviewRect, "width" | "height">;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly gap?: number | undefined;
  readonly margin?: number | undefined;
}): MissionRowPreviewPosition {
  const gap = input.gap ?? MISSION_ROW_PREVIEW_GAP;
  const margin = input.margin ?? MISSION_ROW_PREVIEW_VIEWPORT_MARGIN;
  const available: Record<MissionRowPreviewPlacement, number> = {
    right: input.viewport.width - margin - input.anchor.right - gap,
    left: input.anchor.left - margin - gap,
    bottom: input.viewport.height - margin - input.anchor.bottom - gap,
    top: input.anchor.top - margin - gap,
  };
  const required: Record<MissionRowPreviewPlacement, number> = {
    right: input.card.width,
    left: input.card.width,
    bottom: input.card.height,
    top: input.card.height,
  };
  const preferred: readonly MissionRowPreviewPlacement[] = ["right", "left", "bottom", "top"];
  const placement =
    preferred.find((candidate) => available[candidate] >= required[candidate]) ??
    preferred.reduce((best, candidate) =>
      available[candidate] > available[best] ? candidate : best,
    );

  let left = input.anchor.right + gap;
  let top = input.anchor.top + (input.anchor.height - input.card.height) / 2;
  if (placement === "left") left = input.anchor.left - gap - input.card.width;
  if (placement === "bottom") {
    left = input.anchor.left + (input.anchor.width - input.card.width) / 2;
    top = input.anchor.bottom + gap;
  }
  if (placement === "top") {
    left = input.anchor.left + (input.anchor.width - input.card.width) / 2;
    top = input.anchor.top - gap - input.card.height;
  }

  return {
    placement,
    left: clampMissionRowPreview(left, margin, input.viewport.width - margin - input.card.width),
    top: clampMissionRowPreview(top, margin, input.viewport.height - margin - input.card.height),
  };
}

export const useMissionRowPreviewLayoutEffect =
  typeof document === "undefined" ? useEffect : useLayoutEffect;

function MissionRowPreviewCard(props: {
  readonly anchorRef: RefObject<HTMLDivElement | null>;
  readonly id: string;
  readonly mission: MissionSummary;
  readonly open: boolean;
}) {
  const { t } = useTranslation("missions");
  const cardRef = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<MissionRowPreviewPosition | null>(null);

  const updatePosition = useCallback(() => {
    const anchor = props.anchorRef.current?.getBoundingClientRect();
    const card = cardRef.current?.getBoundingClientRect();
    if (anchor === undefined || card === undefined) return;
    setPosition(
      positionMissionRowPreview({
        anchor,
        card,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }),
    );
  }, [props.anchorRef]);

  useMissionRowPreviewLayoutEffect(() => {
    if (props.open) updatePosition();
  }, [props.open, updatePosition]);

  useEffect(() => {
    if (!props.open) {
      setPosition(null);
      return;
    }
    const reposition = () => updatePosition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(reposition);
    if (props.anchorRef.current !== null) observer?.observe(props.anchorRef.current);
    if (cardRef.current !== null) observer?.observe(cardRef.current);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      observer?.disconnect();
    };
  }, [props.anchorRef, props.open, updatePosition]);

  if (!props.open) return null;
  const content = (
    <aside
      className={position === null ? "mission-row-preview" : "mission-row-preview is-positioned"}
      data-placement={position?.placement}
      id={props.id}
      ref={cardRef}
      role="tooltip"
      style={
        position === null
          ? undefined
          : ({ left: position.left, top: position.top } satisfies CSSProperties)
      }
    >
      <strong>{props.mission.title}</strong>
      <dl>
        <div>
          <dt>{t("missionPreviewExecutor")}</dt>
          <dd className="is-single-line" title={props.mission.executor.name}>
            {props.mission.executor.name}
          </dd>
        </div>
        <div>
          <dt>{t("missionPreviewStatus")}</dt>
          <dd>{missionStatusLabel(props.mission)}</dd>
        </div>
        <div>
          <dt>{t("missionPreviewWorkspace")}</dt>
          <dd className="is-single-line" title={props.mission.workspace.basename}>
            {props.mission.workspace.basename}
          </dd>
        </div>
        <div>
          <dt>{t("missionPreviewUpdated")}</dt>
          <dd>
            <time dateTime={props.mission.updatedAt}>
              {formatMissionDateTime(props.mission.updatedAt)}
            </time>
          </dd>
        </div>
      </dl>
    </aside>
  );
  return typeof document === "undefined" ? content : createPortal(content, document.body);
}

export function MissionRailRow(props: {
  readonly mission: MissionSummary;
  readonly completed: boolean;
  readonly pinned: boolean;
  readonly unread: boolean;
  readonly selected: boolean;
  readonly onOpen: (mission: MissionSummary) => void;
  readonly onTogglePin: (mission: MissionSummary) => void;
  readonly onMarkComplete: (mission: MissionSummary) => void | Promise<void>;
  readonly onDelete: (mission: MissionSummary) => void;
}) {
  const previewId = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [previewOpen, setPreviewOpen] = useState(false);
  const indicator = resolveMissionRowIndicator(props.mission, props.unread);
  const running = props.mission.execution?.status === "running";

  const hidePreview = useCallback(() => {
    if (showTimerRef.current !== undefined) clearTimeout(showTimerRef.current);
    showTimerRef.current = undefined;
    setPreviewOpen(false);
  }, []);
  const showPreview = useCallback(() => {
    if (showTimerRef.current !== undefined) clearTimeout(showTimerRef.current);
    showTimerRef.current = undefined;
    setPreviewOpen(true);
  }, []);
  const schedulePreview = useCallback(() => {
    if (showTimerRef.current !== undefined) clearTimeout(showTimerRef.current);
    showTimerRef.current = setTimeout(showPreview, MISSION_ROW_PREVIEW_HOVER_DELAY_MS);
  }, [showPreview]);

  useEffect(
    () => () => {
      if (showTimerRef.current !== undefined) clearTimeout(showTimerRef.current);
    },
    [],
  );

  const handleBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget !== null && event.currentTarget.contains(event.relatedTarget as Node)) {
      return;
    }
    hidePreview();
  };
  const handleFocus = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.matches(":focus-visible")) {
      showPreview();
    }
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    hidePreview();
  };

  return (
    <div
      className={[
        "mission-row",
        props.selected ? "is-active" : "",
        props.pinned ? "is-pinned" : "",
        props.completed ? "is-completed" : "",
        running ? "has-loading" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={rowRef}
      onBlur={handleBlur}
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
      onMouseDown={hidePreview}
      onMouseEnter={schedulePreview}
      onMouseLeave={hidePreview}
    >
      <button
        aria-describedby={previewOpen ? previewId : undefined}
        aria-label={i18n.t("missionRowAccessibleLabel", {
          ns: "missions",
          title: props.mission.title,
          status: missionStatusLabel(props.mission),
        })}
        className="mission-row-open"
        type="button"
        onClick={() => props.onOpen(props.mission)}
      >
        <span className="mission-status-slot" aria-hidden="true">
          {indicator === null ? null : (
            <Circle className={`mission-status-dot is-${indicator}`} size={8} weight="fill" />
          )}
        </span>
        <strong>{props.mission.title}</strong>
      </button>
      {running ? (
        <span className="mission-row-loading" aria-hidden="true">
          <SpinnerGap size={14} />
        </span>
      ) : null}
      <div className="mission-row-actions">
        {!props.completed ? (
          <>
            <button
              className="mission-row-icon-action"
              type="button"
              title={
                props.pinned
                  ? i18n.t("unpinMission", { ns: "missions" })
                  : i18n.t("pinMission", { ns: "missions" })
              }
              aria-label={i18n.t(props.pinned ? "unpinNamed" : "pinNamed", {
                ns: "missions",
                title: props.mission.title,
              })}
              aria-pressed={props.pinned}
              onClick={() => props.onTogglePin(props.mission)}
            >
              <PushPin size={18} weight={props.pinned ? "fill" : "regular"} aria-hidden="true" />
            </button>
            <button
              className="mission-row-icon-action"
              type="button"
              title={i18n.t("markComplete", { ns: "missions" })}
              aria-label={i18n.t("markCompleteNamed", {
                ns: "missions",
                title: props.mission.title,
              })}
              onClick={() => void props.onMarkComplete(props.mission)}
            >
              <CheckCircle size={18} aria-hidden="true" />
            </button>
          </>
        ) : (
          <button
            className="mission-row-icon-action is-danger"
            type="button"
            title={i18n.t("deleteMission", { ns: "missions" })}
            aria-label={i18n.t("deleteNamed", {
              ns: "missions",
              title: props.mission.title,
            })}
            onClick={() => props.onDelete(props.mission)}
          >
            <Trash size={18} aria-hidden="true" />
          </button>
        )}
      </div>
      <MissionRowPreviewCard
        anchorRef={rowRef}
        id={previewId}
        mission={props.mission}
        open={previewOpen}
      />
    </div>
  );
}

function MissionRailGroup(props: {
  readonly label: string;
  readonly emptyLabel: string;
  readonly variant?: "default" | "completed";
  readonly missions: readonly MissionSummary[];
  readonly hiddenCount: number;
  readonly pinnedMissionIds: ReadonlySet<string>;
  readonly unreadMissionOutputIds: ReadonlySet<string>;
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
            const isActiveMission = mission.lifecycleStatus === "active";
            const isPinned = isActiveMission && props.pinnedMissionIds.has(mission.id);
            return (
              <MissionRailRow
                key={mission.id}
                completed={completed}
                mission={mission}
                pinned={isPinned}
                selected={mission.id === props.selectedMissionId}
                unread={props.unreadMissionOutputIds.has(mission.id)}
                onDelete={props.onDelete}
                onMarkComplete={props.onMarkComplete}
                onOpen={props.onOpen}
                onTogglePin={props.onTogglePin}
              />
            );
          })}
          {props.hiddenCount > 0 ? (
            <button className="mission-rail-load-more" type="button" onClick={props.onLoadMore}>
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
