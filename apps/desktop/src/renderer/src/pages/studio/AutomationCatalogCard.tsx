import { PragmaScheduleAutomationConfigSchema } from "@pragma/interpreter/ast";
import { useTranslation } from "react-i18next";
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

export function AutomationCatalogCard(props: {
  readonly automation: AutomationSummary;
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
