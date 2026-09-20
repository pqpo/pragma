import {
  ArrowClockwise,
  ArrowLeft,
  Check,
  ClockCounterClockwise,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ManagedSkillRevisionJob,
  SkillRevisionDraft,
} from "@pragma/built-in-agents/contracts";

import type { Capability } from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { StudioConfirmationDialog } from "./StudioDialog.tsx";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

export type SkillRevisionEntry = {
  readonly job: ManagedSkillRevisionJob;
  readonly draft: SkillRevisionDraft;
};

export function activeSkillRevisionTaskCount(
  entries: readonly { readonly job: Pick<ManagedSkillRevisionJob, "state"> }[],
): number {
  return entries.filter(({ job }) => !["completed", "rejected", "superseded"].includes(job.state))
    .length;
}

export function skillRevisionAttentionActions(
  entry: {
    readonly job: Pick<ManagedSkillRevisionJob, "error" | "missionId">;
    readonly draft: Pick<SkillRevisionDraft, "state">;
  },
  canOpenMission: boolean,
): { readonly canContinue: boolean; readonly canRetry: boolean } {
  const canContinue =
    canOpenMission &&
    entry.job.missionId !== undefined &&
    (entry.draft.state === "editing" ||
      entry.job.error?.code === "skill_revision_validation_required");
  return { canContinue, canRetry: !canContinue };
}

export function canDeleteSkillRevisionJob(state: ManagedSkillRevisionJob["state"]): boolean {
  return ["completed", "rejected", "needs_attention", "superseded"].includes(state);
}

export function SkillRevisionEmptyState() {
  const { t } = useTranslation("studio");

  return (
    <div className="revision-task-empty">
      <ClockCounterClockwise size={28} aria-hidden="true" />
      <h3>{t("noSkillRevisions")}</h3>
      <p>{t("noSkillRevisionsDescription")}</p>
    </div>
  );
}

export function SkillRevisionTaskActions(props: {
  readonly jobState: ManagedSkillRevisionJob["state"];
  readonly draftState: SkillRevisionDraft["state"];
  readonly missionId?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly busy: boolean;
  readonly canOpenMission: boolean;
  readonly onRetry: () => void;
  readonly onDelete: () => void;
}) {
  const { t } = useTranslation("studio");
  const attentionActions = skillRevisionAttentionActions(
    {
      job: {
        ...(props.missionId === undefined ? {} : { missionId: props.missionId }),
        ...(props.errorCode === undefined
          ? {}
          : { error: { code: props.errorCode, message: props.errorCode } }),
      },
      draft: { state: props.draftState },
    },
    props.canOpenMission,
  );

  return (
    <div className="revision-task-actions">
      {(props.jobState === "needs_attention" && attentionActions.canRetry) ||
      props.jobState === "rejected" ? (
        <button
          className="revision-task-icon-button"
          type="button"
          aria-label={t("retryRevision")}
          title={t("retryRevision")}
          disabled={props.busy}
          onClick={props.onRetry}
        >
          <ArrowClockwise size={16} aria-hidden="true" />
        </button>
      ) : null}
      {canDeleteSkillRevisionJob(props.jobState) ? (
        <button
          className="revision-task-icon-button is-danger"
          type="button"
          aria-label={t("deleteRevisionTask")}
          title={t("deleteRevisionTask")}
          disabled={props.busy}
          onClick={props.onDelete}
        >
          <Trash size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function SkillRevisionDetailFragment(props: {
  readonly entry: SkillRevisionEntry;
  readonly busy: boolean;
  readonly error?: string | undefined;
  readonly canOpenMission: boolean;
  readonly onBack: () => void;
  readonly onApprove: () => void;
  readonly onReject: () => void;
  readonly onRetry: () => void;
  readonly onContinue: () => void;
}) {
  const { t, i18n } = useTranslation("studio");
  const { job, draft } = props.entry;
  const attentionActions = skillRevisionAttentionActions(props.entry, props.canOpenMission);
  const revisionMetadata = `${draft.name} · ${
    draft.operation === "create"
      ? t("publishesAsRevisionOne")
      : t("baseRevision", { count: draft.baseRevision })
  } · ${formatRevisionTimestamp(job.updatedAt, i18n.language)}`;

  return (
    <StudioScreenFrame
      className="context-store-revision-detail skill-revision-detail"
      labelledBy="skill-revision-detail-title"
      header={
        <header className="revision-diff-heading">
          <button className="back-link" type="button" onClick={props.onBack}>
            <ArrowLeft size={18} aria-hidden="true" />
            {t("backRevisionTasks")}
          </button>
          <div className="revision-diff-title-row">
            <div>
              <h1 id="skill-revision-detail-title">{t("revisionResult")}</h1>
              <p>{revisionMetadata}</p>
            </div>
            <div className="revision-diff-actions">
              <span className={`revision-task-state is-${job.state}`}>
                {t(`revisionState.${job.state}`)}
              </span>
              {job.state === "pending_review" ? (
                <>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={props.busy}
                    onClick={props.onApprove}
                  >
                    <Check size={15} aria-hidden="true" />
                    {t("approveAndPublish")}
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={props.busy}
                    onClick={props.onReject}
                  >
                    <X size={15} aria-hidden="true" />
                    {t("rejectRevision")}
                  </button>
                </>
              ) : null}
              {(job.state === "needs_attention" && attentionActions.canRetry) ||
              job.state === "rejected" ? (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={props.busy}
                  onClick={props.onRetry}
                >
                  <ArrowClockwise size={15} aria-hidden="true" />
                  {t("retryRevision")}
                </button>
              ) : null}
              {job.state === "needs_attention" && attentionActions.canContinue ? (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={props.busy}
                  onClick={props.onContinue}
                >
                  {t("continueSkillRevision")}
                </button>
              ) : null}
            </div>
          </div>
        </header>
      }
    >
      <div className="revision-diff-content">
        <div className="skill-revision-review">
          <section>
            <span>{t("skillRevisionRequest")}</span>
            <p>{job.request.prompt}</p>
          </section>
          <section>
            <span>{t("skillRevisionSummary")}</span>
            <p>{draft.summary ?? t("skillRevisionSummaryUnavailable")}</p>
          </section>
          {job.error ? (
            <section className="is-error">
              <span>{t("skillRevisionAttention")}</span>
              <p>{job.error.message}</p>
            </section>
          ) : null}
        </div>
        {props.error ? (
          <p className="form-error" role="alert">
            {props.error}
          </p>
        ) : null}
      </div>
    </StudioScreenFrame>
  );
}

export function SkillRevisionFragment(props: {
  readonly capabilities: readonly Capability[];
  readonly capabilityId?: string | undefined;
  readonly onCountChanged?: ((count: number) => void) | undefined;
  readonly onPublished?: (() => Promise<void>) | undefined;
  readonly onOpenMission?: ((missionId: string, composerDraft?: string) => void) | undefined;
  readonly onBack: () => void;
}) {
  const { t, i18n } = useTranslation("studio");
  const [entries, setEntries] = useState<readonly SkillRevisionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<SkillRevisionEntry>();
  const [selectedJobId, setSelectedJobId] = useState<string>();
  const load = useCallback(async () => {
    const api = desktopApi();
    if (api === undefined) return;
    setLoading(true);
    try {
      const nextEntries = await api.listSkillRevisionJobs(props.capabilityId);
      setEntries(nextEntries);
      props.onCountChanged?.(activeSkillRevisionTaskCount(nextEntries));
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [props.capabilityId, props.onCountChanged]);

  useEffect(() => void load(), [load]);

  const act = async (
    entry: SkillRevisionEntry,
    action: "approve" | "reject" | "retry" | "delete",
  ) => {
    const api = desktopApi();
    if (api === undefined) return;
    setBusyId(entry.job.id);
    try {
      const input = { jobId: entry.job.id, expectedRevision: entry.job.revision };
      if (action === "approve") await api.approveSkillRevision(input);
      else if (action === "reject") await api.rejectSkillRevision(input);
      else if (action === "retry") await api.retrySkillRevision(input);
      else await api.deleteSkillRevision(input);
      if (action === "approve") await props.onPublished?.();
      if (action === "delete") {
        setPendingDelete(undefined);
        setSelectedJobId(undefined);
      }
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(undefined);
    }
  };

  const selectedEntry = entries.find((entry) => entry.job.id === selectedJobId);
  if (selectedEntry !== undefined) {
    return (
      <SkillRevisionDetailFragment
        entry={selectedEntry}
        busy={busyId === selectedEntry.job.id}
        error={error}
        canOpenMission={props.onOpenMission !== undefined}
        onBack={() => setSelectedJobId(undefined)}
        onApprove={() => void act(selectedEntry, "approve")}
        onReject={() => void act(selectedEntry, "reject")}
        onRetry={() => void act(selectedEntry, "retry")}
        onContinue={() =>
          props.onOpenMission?.(selectedEntry.job.missionId!, t("skillRevisionContinuePrompt"))
        }
      />
    );
  }

  return (
    <StudioScreenFrame
      className="context-store-revisions skill-revision-page"
      labelledBy="skill-revisions-heading"
      header={
        <header className="studio-heading revision-task-heading">
          <div className="revision-task-heading-copy">
            <button className="back-link" type="button" onClick={props.onBack}>
              <ArrowLeft size={18} aria-hidden="true" /> {t("backCapabilities")}
            </button>
            <div>
              <div>
                <h1 id="skill-revisions-heading">{t("skillRevisions")}</h1>
                <p>{t("skillRevisionsDescription")}</p>
              </div>
              <span className="revision-task-count">
                {t("revisionTaskCount", { count: entries.length })}
              </span>
            </div>
          </div>
        </header>
      }
    >
      <div className="revision-task-content">
        {loading ? <p className="directory-empty">{t("loadingSkillRevisions")}</p> : null}
        {!loading && entries.length === 0 ? <SkillRevisionEmptyState /> : null}
        {entries.length > 0 ? (
          <div className="revision-task-table">
            <div className="revision-task-list-header" aria-hidden="true">
              <span>{t("revisionTaskColumn")}</span>
              <span>{t("status")}</span>
              <span>{t("revisionUpdatedAt")}</span>
              <span>{t("actions")}</span>
            </div>
            <div className="revision-task-list" role="list" aria-label={t("skillRevisions")}>
              {entries.map((entry) => {
                const capability = props.capabilities.find(
                  (item) => item.manifest.id === entry.draft.capabilityId,
                );
                const busy = busyId === entry.job.id;
                return (
                  <article className="revision-task-row" role="listitem" key={entry.job.id}>
                    <button
                      className="revision-task-open"
                      type="button"
                      aria-label={t("viewRevisionChanges")}
                      onClick={() => setSelectedJobId(entry.job.id)}
                    >
                      <span className="revision-task-summary">
                        <strong title={entry.job.request.prompt}>{entry.job.request.prompt}</strong>
                        <small>
                          {capability?.manifest.name ?? entry.draft.name} ·{` `}
                          {entry.draft.operation === "create"
                            ? t("newSkillRevision")
                            : t("baseRevision", { count: entry.draft.baseRevision })}
                          {entry.draft.summary ? ` · ${entry.draft.summary}` : ""}
                        </small>
                      </span>
                      <span className="revision-task-result">
                        <span className={`revision-task-state is-${entry.job.state}`}>
                          {t(`revisionState.${entry.job.state}`)}
                        </span>
                        {entry.job.error ? (
                          <span className="form-error" role="alert" title={entry.job.error.message}>
                            {entry.job.error.message}
                          </span>
                        ) : null}
                      </span>
                      <time
                        className="revision-task-updated"
                        dateTime={entry.job.updatedAt}
                        title={formatRevisionTimestamp(entry.job.updatedAt, i18n.language)}
                      >
                        {formatRevisionTimestamp(entry.job.updatedAt, i18n.language)}
                      </time>
                    </button>
                    <SkillRevisionTaskActions
                      jobState={entry.job.state}
                      draftState={entry.draft.state}
                      missionId={entry.job.missionId}
                      errorCode={entry.job.error?.code}
                      busy={busy}
                      canOpenMission={props.onOpenMission !== undefined}
                      onRetry={() => void act(entry, "retry")}
                      onDelete={() => setPendingDelete(entry)}
                    />
                  </article>
                );
              })}
            </div>
          </div>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      {pendingDelete ? (
        <StudioConfirmationDialog
          className="revision-task-delete-dialog"
          title={t("deleteSkillRevisionTaskTitle")}
          description={t("deleteSkillRevisionTaskDescription", {
            name: pendingDelete.job.request.prompt,
          })}
          cancelLabel={t("cancel")}
          confirmLabel={t("deleteRevisionTask")}
          busyLabel={t("deleting")}
          busy={busyId === pendingDelete.job.id}
          onCancel={() => setPendingDelete(undefined)}
          onConfirm={() => void act(pendingDelete, "delete")}
          action="delete"
        />
      ) : null}
    </StudioScreenFrame>
  );
}

function formatRevisionTimestamp(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
