import {
  PragmaScheduleAutomationConfigSchema,
  type PragmaScheduleTrigger,
} from "@pragma/interpreter/ast";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { AutomationSummary } from "../../../../shared/contracts/index.ts";
import { StudioCatalogCard } from "./StudioCatalogCard.tsx";

function formatTimestamp(value: string, locale: string, timezone?: string): string | undefined {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  try {
    return new Intl.DateTimeFormat(locale, {
      year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
      timeZoneName: "short",
    }).format(date);
  } catch {
    return undefined;
  }
}

export function automationScheduleSummary(
  trigger: PragmaScheduleTrigger,
  locale: string,
  t: TFunction<"studio">,
): string {
  if (trigger.kind === "once") {
    return t("automationCardOnce", {
      time: formatTimestamp(trigger.at, locale) ?? t("automationScheduleUnavailable"),
    });
  }
  if (trigger.kind === "interval") {
    return t("automationCardInterval", {
      interval: new Intl.NumberFormat(locale, {
        style: "unit",
        unit: trigger.unit.slice(0, -1),
        unitDisplay: "long",
      }).format(trigger.every),
    });
  }
  if (trigger.kind === "cron") return `Cron ${trigger.expression} · ${trigger.timezone}`;
  const frequency =
    trigger.frequency === "weekly"
      ? (trigger.weekdays ?? [])
          .map((day) => t(`weekday.${day}`))
          .join(t("flowParticipantSeparator"))
      : trigger.frequency === "monthly"
        ? t("automationCardMonthly", { day: trigger.dayOfMonth })
        : t(`scheduleFrequency.${trigger.frequency}`);
  return `${frequency} ${trigger.time} · ${trigger.timezone}`;
}

export function AutomationCatalogCard(props: {
  readonly automation: AutomationSummary;
  readonly executorName: string;
  readonly onOpen: () => void;
}) {
  const { t, i18n } = useTranslation("studio");
  const { automation } = props;
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const config = PragmaScheduleAutomationConfigSchema.safeParse(automation.resource.spec.config);
  const trigger =
    automation.resource.spec.adapter === "pragma.automation.schedule@v1" && config.success
      ? config.data.trigger
      : undefined;
  const schedule =
    trigger === undefined
      ? t("automationScheduleUnavailable")
      : automationScheduleSummary(trigger, locale, t);
  const timezone =
    trigger?.kind === "calendar" || trigger?.kind === "cron" ? trigger.timezone : undefined;
  const nextRun = automation.status === "scheduled" ? automation.nextRunAt : undefined;
  const timestamp = nextRun ?? automation.lastRun?.scheduledFor;
  const timeLabel =
    timestamp === undefined ? undefined : formatTimestamp(timestamp, locale, timezone);
  return (
    <StudioCatalogCard
      name={automation.resource.metadata.name}
      description={automation.resource.metadata.description}
      badge={
        automation.status === "scheduled" ? undefined : (
          <span
            className={`automation-card-state${automation.status === "needs_attention" ? " is-error" : ""}`}
            title={automation.diagnostic}
          >
            {t(`automationStatus.${automation.status}`)}
          </span>
        )
      }
      summary={
        <span className="automation-card-facts">
          <span title={props.executorName}>
            {t("automationCardExecutor", { name: props.executorName })}
          </span>
          <span title={schedule}>{schedule}</span>
          {automation.lastRun?.status === "failed" ? (
            <span className="automation-card-run-error" title={automation.lastRun.error}>
              {t("automationCardLastFailed")}
            </span>
          ) : null}
          {automation.queueDepth > 0 ? (
            <span>{t("automationCardQueued", { count: automation.queueDepth })}</span>
          ) : null}
        </span>
      }
      footer={
        timeLabel !== undefined && timestamp !== undefined ? (
          <span className="automation-card-time">
            <span>{nextRun === undefined ? t("automationCardLastTriggered") : t("nextRun")}</span>
            <time dateTime={timestamp} title={timeLabel}>
              {timeLabel}
            </time>
          </span>
        ) : automation.status === "scheduled" ? (
          <span>{t("notScheduled")}</span>
        ) : undefined
      }
      onOpen={props.onOpen}
    />
  );
}
