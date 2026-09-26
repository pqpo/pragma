import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle, Database, SpinnerGap, WarningCircle, X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import {
  type MissionContextWindowState,
  type DesktopMissionMemoryActivity,
} from "../../../../shared/contracts/index.ts";
import { i18n } from "../../i18n/index.ts";
import { formatTokens } from "../../lib/usage-format.ts";

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

export function MissionUsageHint(props: {
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

export function MissionErrorBanner(props: {
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
