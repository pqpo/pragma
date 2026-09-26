import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ExpertAvatar } from "../../components/ExpertAvatar.tsx";
import { ProfiledExpertAvatar } from "../../components/ProfiledExpertAvatar.tsx";
import {
  type MissionWorkRecord,
  type ExpertMentionCandidate,
} from "../../../../shared/contracts/index.ts";
import { formatExpertMentionDisplayText } from "./mission-chat-presentation.tsx";
import { MISSION_WORK_RECORD_PAGE_SIZE } from "./mission-view-constants.ts";
import {
  clampMissionRowPreview,
  useMissionRowPreviewLayoutEffect,
  type MissionRowPreviewPosition,
  type MissionRowPreviewRect,
} from "./mission-rail.tsx";
import { missionWorkRecordTitle, workRecordDepth, workStatusLabel } from "./mission-page-utils.ts";

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

export function expertIdFromRef(ref: string): string {
  return ref.startsWith("expert:") ? ref.slice("expert:".length) : ref;
}

export function teamParticipantWorkRecords(
  records: readonly MissionWorkRecord[],
  members: readonly ExpertMentionCandidate[],
): MissionWorkRecord[] {
  const memberIds = new Set(members.map((member) => expertIdFromRef(member.ref)));
  return records
    .filter(
      (record) =>
        record.kind !== "root" &&
        record.executorId !== undefined &&
        memberIds.has(record.executorId),
    )
    .toSorted((left, right) => {
      const updated = right.updatedAt.localeCompare(left.updatedAt);
      if (updated !== 0) return updated;
      const activity = Number(right.status === "running") - Number(left.status === "running");
      if (activity !== 0) return activity;
      const created = right.createdAt.localeCompare(left.createdAt);
      return created === 0 ? left.recordId.localeCompare(right.recordId) : created;
    });
}

export const MISSION_TEAM_PARTICIPANT_PREVIEW_HOVER_DELAY_MS = 200;

const MISSION_TEAM_PARTICIPANT_PREVIEW_GAP = 10;

const MISSION_TEAM_PARTICIPANT_PREVIEW_MARGIN = 12;

export function positionMissionTeamParticipantPreview(input: {
  readonly anchor: MissionRowPreviewRect;
  readonly card: Pick<MissionRowPreviewRect, "width" | "height">;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly gap?: number | undefined;
  readonly margin?: number | undefined;
}): Pick<MissionRowPreviewPosition, "left" | "top"> {
  const gap = input.gap ?? MISSION_TEAM_PARTICIPANT_PREVIEW_GAP;
  const margin = input.margin ?? MISSION_TEAM_PARTICIPANT_PREVIEW_MARGIN;
  return {
    left: clampMissionRowPreview(
      input.anchor.left + (input.anchor.width - input.card.width) / 2,
      margin,
      input.viewport.width - margin - input.card.width,
    ),
    top: clampMissionRowPreview(
      input.anchor.top - gap - input.card.height,
      margin,
      input.viewport.height - margin - input.card.height,
    ),
  };
}

export function MissionTeamParticipantPreviewCard(props: {
  readonly anchorRef: RefObject<HTMLButtonElement | null>;
  readonly id: string;
  readonly record: MissionWorkRecord;
  readonly callOrder?: number | undefined;
  readonly open: boolean;
}) {
  const { t } = useTranslation("missions");
  const cardRef = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<Pick<MissionRowPreviewPosition, "left" | "top"> | null>(
    null,
  );
  const title = missionWorkRecordTitle(props.record);
  const status = workStatusLabel(props.record.status, props.record.waitReason);

  const updatePosition = useCallback(() => {
    const anchor = props.anchorRef.current?.getBoundingClientRect();
    const card = cardRef.current?.getBoundingClientRect();
    if (anchor === undefined || card === undefined) return;
    setPosition(
      positionMissionTeamParticipantPreview({
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
      className={
        position === null
          ? "mission-team-participant-preview"
          : "mission-team-participant-preview is-positioned"
      }
      id={props.id}
      ref={cardRef}
      role="tooltip"
      style={
        position === null
          ? undefined
          : ({ left: position.left, top: position.top } satisfies CSSProperties)
      }
    >
      <header>
        <ExpertAvatar avatarId={props.record.avatarId} size="xs" />
        <strong>{title}</strong>
      </header>
      <dl>
        <div>
          <dt>{t("expertPreviewStatus")}</dt>
          <dd className="mission-team-participant-preview-status">
            <span className={`mission-work-status is-${props.record.status}`} aria-hidden="true" />
            {status}
          </dd>
        </div>
        {props.callOrder === undefined ? null : (
          <div>
            <dt>{t("expertPreviewCallOrder")}</dt>
            <dd>{t("workCallOrder", { number: props.callOrder })}</dd>
          </div>
        )}
        <div>
          <dt>{t("expertPreviewTopic")}</dt>
          <dd className="mission-team-participant-preview-topic">{props.record.summary}</dd>
        </div>
      </dl>
    </aside>
  );
  return typeof document === "undefined" ? content : createPortal(content, document.body);
}

function MissionTeamParticipantItem(props: {
  readonly record: MissionWorkRecord;
  readonly callOrder?: number | undefined;
  readonly onSelect: (recordId: string, trigger: HTMLButtonElement) => void;
}) {
  const { t } = useTranslation("missions");
  const previewId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [previewOpen, setPreviewOpen] = useState(false);
  const title = missionWorkRecordTitle(props.record);
  const status = workStatusLabel(props.record.status, props.record.waitReason);
  const callOrderLabel =
    props.callOrder === undefined ? undefined : t("workCallOrder", { number: props.callOrder });
  const accessibleLabel = [title, status, callOrderLabel, props.record.summary]
    .filter(Boolean)
    .join(", ");

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
    showTimerRef.current = setTimeout(showPreview, MISSION_TEAM_PARTICIPANT_PREVIEW_HOVER_DELAY_MS);
  }, [showPreview]);

  useEffect(
    () => () => {
      if (showTimerRef.current !== undefined) clearTimeout(showTimerRef.current);
    },
    [],
  );

  return (
    <span role="listitem">
      <button
        ref={buttonRef}
        className={`mission-team-participant is-${props.record.status}`}
        type="button"
        aria-describedby={previewOpen ? previewId : undefined}
        aria-label={accessibleLabel}
        onBlur={hidePreview}
        onClick={(event) => props.onSelect(props.record.recordId, event.currentTarget)}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) showPreview();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") hidePreview();
        }}
        onMouseDown={hidePreview}
        onMouseEnter={schedulePreview}
        onMouseLeave={hidePreview}
      >
        <ExpertAvatar
          avatarId={props.record.avatarId}
          className="mission-team-participant-avatar"
          size="xs"
        />
        <span className={`mission-work-status is-${props.record.status}`} aria-hidden="true" />
      </button>
      <MissionTeamParticipantPreviewCard
        anchorRef={buttonRef}
        callOrder={props.callOrder}
        id={previewId}
        open={previewOpen}
        record={props.record}
      />
    </span>
  );
}

export function MissionTeamParticipantList(props: {
  readonly records: readonly MissionWorkRecord[];
  readonly allRecords: readonly MissionWorkRecord[];
  readonly onOpenWork: () => void;
  readonly onSelect: (recordId: string, trigger: HTMLButtonElement) => void;
}) {
  const { t } = useTranslation("missions");
  const callOrder = useMemo(() => missionWorkCallOrder(props.allRecords), [props.allRecords]);
  return (
    <section className="mission-team-participant-list" aria-label={t("participatingExperts")}>
      <div role="list">
        {props.records.map((record) => {
          const order = callOrder.get(record.recordId);
          return (
            <MissionTeamParticipantItem
              key={record.recordId}
              callOrder={order}
              record={record}
              onSelect={props.onSelect}
            />
          );
        })}
        <span className="mission-team-participant-work-link" role="listitem">
          <button type="button" aria-label={t("openExpertWork")} onClick={props.onOpenWork}>
            <CaretRight size={13} weight="bold" aria-hidden="true" />
          </button>
        </span>
      </div>
    </section>
  );
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
  readonly mentionCandidates?: readonly ExpertMentionCandidate[] | undefined;
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
                      <p className="mission-work-card-summary">
                        {formatExpertMentionDisplayText(
                          record.summary,
                          props.mentionCandidates,
                          t("mentionUnavailable"),
                        )}
                      </p>
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
