import { ArrowLeft, Clock, PencilSimple, Play, Trash } from "@phosphor-icons/react";
import { PragmaScheduleAutomationConfigSchema } from "@pragma/interpreter/ast";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type {
  AutomationSummary,
  DesktopToolPermissionMode,
  MissionExecutorOption,
} from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { StudioConfirmationDialog } from "./StudioDialog.tsx";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";

export function AutomationDetailFragment(props: {
  readonly automation: AutomationSummary;
  readonly executors: readonly MissionExecutorOption[];
  readonly onBack: () => void;
  readonly onEdit: () => void;
  readonly onRun: () => Promise<void>;
  readonly onDelete: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation("studio");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const { automation } = props;
  const scheduleConfig = PragmaScheduleAutomationConfigSchema.safeParse(
    automation.resource.spec.config,
  );
  const trigger =
    automation.resource.spec.adapter === "pragma.automation.schedule@v1" && scheduleConfig.success
      ? scheduleConfig.data.trigger
      : undefined;
  const routeInput = automation.resource.spec.route.input;
  const executor = props.executors.find(
    (candidate) => candidate.ref === automation.resource.spec.route.executor.ref,
  );
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const canRun =
    trigger !== undefined && automation.binding !== undefined && automation.resource.spec.enabled;

  const runNow = async () => {
    if (!canRun || running) return;
    setRunning(true);
    setError(null);
    setRunNotice(null);
    try {
      await props.onRun();
      setRunNotice(t("automationRunQueued"));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunning(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await props.onDelete();
    } catch (cause) {
      setDeleteOpen(false);
      setError(errorMessage(cause));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <StudioScreenFrame
        className="automation-detail"
        labelledBy="automation-detail-name"
        header={
          <button className="back-link" type="button" onClick={props.onBack}>
            <ArrowLeft size={18} aria-hidden="true" />
            {t("backIntegrations")}
          </button>
        }
      >
        <header className="automation-detail-header">
          <span className="automation-detail-icon" aria-hidden="true">
            <Clock size={38} />
          </span>
          <div className="automation-detail-title">
            <div>
              <h1 id="automation-detail-name">{automation.resource.metadata.name}</h1>
              <span className={`automation-status is-${automation.status}`}>
                {t(`automationStatus.${automation.status}`)}
              </span>
            </div>
            <p>{automation.resource.metadata.description}</p>
            <code>{automation.ref}</code>
          </div>
          <div className="detail-actions">
            {trigger === undefined ? null : (
              <>
                <button
                  className="primary-button"
                  type="button"
                  disabled={!canRun || running}
                  onClick={() => void runNow()}
                >
                  <Play size={17} aria-hidden="true" />
                  {running ? t("runningAutomation") : t("runAutomationNow")}
                </button>
                <button className="secondary-button" type="button" onClick={props.onEdit}>
                  <PencilSimple size={17} aria-hidden="true" />
                  {t("editAutomation")}
                </button>
              </>
            )}
            <button className="danger-button" type="button" onClick={() => setDeleteOpen(true)}>
              <Trash size={17} aria-hidden="true" />
              {t("deleteResourceAction")}
            </button>
          </div>
        </header>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {runNotice ? (
          <p className="automation-detail-run-notice" role="status">
            {runNotice}
          </p>
        ) : null}
        {automation.diagnostic ? (
          <p className="automation-detail-diagnostic" role="status">
            {automation.diagnostic}
          </p>
        ) : null}

        <section className="automation-detail-summary" aria-label={t("automationOverview")}>
          <DetailFact label={t("status")}>{t(`automationStatus.${automation.status}`)}</DetailFact>
          <DetailFact label={t("nextRun")}>
            {automation.nextRunAt === undefined
              ? t("notScheduled")
              : formatDateTime(automation.nextRunAt, locale)}
          </DetailFact>
          <DetailFact label={t("queueDepth")}>{automation.queueDepth}</DetailFact>
        </section>

        <div className="automation-detail-content">
          <DetailSection
            title={trigger === undefined ? t("connectionConfiguration") : t("schedulePolicy")}
          >
            <DetailList>
              <DetailRow label={t("automationAdapter")}>
                <code>{automation.resource.spec.adapter}</code>
              </DetailRow>
              {trigger === undefined ? null : (
                <DetailRow label={t("triggerType")}>{triggerKindLabel(trigger.kind, t)}</DetailRow>
              )}
              {trigger?.kind === "once" ? (
                <DetailRow label={t("runAt")}>{formatDateTime(trigger.at, locale)}</DetailRow>
              ) : null}
              {trigger?.kind === "interval" ? (
                <>
                  <DetailRow label={t("every")}>
                    {trigger.every} {t(`scheduleUnit.${trigger.unit}`)}
                  </DetailRow>
                  <DetailRow label={t("anchorAt")}>
                    {formatDateTime(trigger.anchorAt, locale)}
                  </DetailRow>
                </>
              ) : null}
              {trigger?.kind === "calendar" ? (
                <>
                  <DetailRow label={t("frequency")}>
                    {t(`scheduleFrequency.${trigger.frequency}`)}
                  </DetailRow>
                  {trigger.frequency === "weekly" ? (
                    <DetailRow label={t("weekdays")}>
                      {(trigger.weekdays ?? [])
                        .map((weekday) => t(`weekday.${weekday}`))
                        .join(", ")}
                    </DetailRow>
                  ) : null}
                  {trigger.frequency === "monthly" ? (
                    <DetailRow label={t("dayOfMonth")}>{trigger.dayOfMonth}</DetailRow>
                  ) : null}
                  <DetailRow label={t("time")}>{trigger.time}</DetailRow>
                </>
              ) : null}
              {trigger?.kind === "cron" ? (
                <DetailRow label={t("scheduleCron")}>
                  <code>{trigger.expression}</code>
                </DetailRow>
              ) : null}
              {trigger?.kind === "calendar" || trigger?.kind === "cron" ? (
                <DetailRow label={t("timezone")}>{trigger.timezone}</DetailRow>
              ) : null}
              {trigger !== undefined && trigger.kind !== "once" ? (
                <>
                  {trigger.window?.startsAt ? (
                    <DetailRow label={t("activeFrom")}>
                      {formatDateTime(trigger.window.startsAt, locale)}
                    </DetailRow>
                  ) : null}
                  {trigger.window?.endsAt ? (
                    <DetailRow label={t("activeUntil")}>
                      {formatDateTime(trigger.window.endsAt, locale)}
                    </DetailRow>
                  ) : null}
                </>
              ) : null}
            </DetailList>
            {trigger === undefined ? (
              <div className="automation-detail-input">
                <small>{t("automationConfiguration")}</small>
                <pre>{JSON.stringify(automation.resource.spec.config, null, 2)}</pre>
              </div>
            ) : null}
          </DetailSection>

          <DetailSection title={t("automationTarget")}>
            <DetailList>
              <DetailRow label={t("executor")}>
                <strong>{executor?.name ?? automation.resource.spec.route.executor.ref}</strong>
                {executor === undefined ? null : <code>{executor.ref}</code>}
              </DetailRow>
              <DetailRow label={t("sessionPolicy")}>
                {automation.resource.spec.interaction.mode === "reuse-session"
                  ? t("reuseMission")
                  : t("newMissionEveryRun")}
              </DetailRow>
            </DetailList>
            <div className="automation-detail-input">
              <small>{routeInput.kind === "prompt" ? t("prompt") : t("flowInput")}</small>
              {routeInput.kind === "prompt" ? (
                <p>{routeInput.value}</p>
              ) : (
                <pre>{JSON.stringify(routeInput.value, null, 2)}</pre>
              )}
            </div>
          </DetailSection>

          <DetailSection title={t("executionEnvironment")}>
            <DetailList>
              <DetailRow label={t("workspace")}>
                <code>{automation.binding?.workspace.path ?? t("notConfigured")}</code>
              </DetailRow>
              <DetailRow label={t("toolPermissions")}>
                {permissionLabel(automation.binding?.toolPermissionMode, t)}
              </DetailRow>
              {automation.missionId ? (
                <DetailRow label={t("continuityMission")}>
                  <code>{automation.missionId}</code>
                </DetailRow>
              ) : null}
            </DetailList>
          </DetailSection>

          <DetailSection title={t("lastRun")}>
            {automation.lastRun === undefined ? (
              <p className="automation-detail-empty-copy">{t("notRunYet")}</p>
            ) : (
              <DetailList>
                <DetailRow label={t("status")}>
                  {t(`automationRunStatus.${automation.lastRun.status}`)}
                </DetailRow>
                <DetailRow label={t("scheduledFor")}>
                  {formatDateTime(automation.lastRun.scheduledFor, locale)}
                </DetailRow>
                {automation.lastRun.missionId ? (
                  <DetailRow label={t("mission")}>
                    <code>{automation.lastRun.missionId}</code>
                  </DetailRow>
                ) : null}
                {automation.lastRun.error ? (
                  <DetailRow label={t("error")}>
                    <span className="automation-detail-run-error">{automation.lastRun.error}</span>
                  </DetailRow>
                ) : null}
              </DetailList>
            )}
          </DetailSection>
        </div>
      </StudioScreenFrame>

      {deleteOpen ? (
        <StudioConfirmationDialog
          title={t("deleteResourceAction")}
          description={t("deleteAutomationConfirm")}
          confirmLabel={t("deleteResourceAction")}
          cancelLabel={t("cancel")}
          busyLabel={t("saving")}
          busy={deleting}
          action="delete"
          onCancel={() => setDeleteOpen(false)}
          onConfirm={() => void remove()}
        />
      ) : null}
    </>
  );
}

function DetailSection(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="automation-detail-section">
      <h2>{props.title}</h2>
      {props.children}
    </section>
  );
}

function DetailFact(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <small>{props.label}</small>
      <strong>{props.children}</strong>
    </div>
  );
}

function DetailList(props: { readonly children: ReactNode }) {
  return <dl className="automation-detail-list">{props.children}</dl>;
}

function DetailRow(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

function formatDateTime(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale);
}

function triggerKindLabel(kind: string, t: (key: string) => string): string {
  if (kind === "once") return t("scheduleOnce");
  if (kind === "interval") return t("scheduleInterval");
  if (kind === "calendar") return t("scheduleCalendar");
  return t("scheduleCron");
}

function permissionLabel(
  permission: DesktopToolPermissionMode | undefined,
  t: (key: string) => string,
): string {
  if (permission === "auto-approve") return t("autoApprove");
  if (permission === "full-access") return t("fullAccess");
  if (permission === "request-approval") return t("requestApproval");
  return t("notConfigured");
}
