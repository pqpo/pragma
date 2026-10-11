import {
  ArrowClockwise,
  ArrowLeft,
  Check,
  ClockCounterClockwise,
  FunnelSimple,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ManagedSkillRevisionJob,
  SkillRevisionDraft,
} from "@pragma/built-in-agents/contracts";

import type {
  Capability,
  SkillRevisionReview,
  SkillManualRevisionRecord,
} from "../../../../shared/contracts/index.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { errorMessage } from "../../lib/errors.ts";
import {
  SkillManualRevisionDetailFragment,
  SkillManualRevisionRow,
} from "./SkillManualRevisionFragment.tsx";
import { SkillRevisionChangeViewer } from "./SkillRevisionChangeViewer.tsx";
import { StudioConfirmationDialog } from "./StudioDialog.tsx";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

export type SkillRevisionEntry = {
  readonly job: ManagedSkillRevisionJob;
  readonly draft: SkillRevisionDraft;
};

export function filterSkillRevisionEntries(
  entries: readonly SkillRevisionEntry[],
  stateFilter: string,
  capabilityFilter = "",
): readonly SkillRevisionEntry[] {
  return entries.filter(({ job, draft }) => {
    const matchesCapability = capabilityFilter === "" || draft.capabilityId === capabilityFilter;
    const matchesState =
      stateFilter === "" ||
      (stateFilter === "actionable"
        ? ["pending_review", "needs_rebase", "needs_attention"].includes(job.state)
        : job.state === stateFilter);
    return matchesCapability && matchesState;
  });
}

export type SkillRevisionHistoryEntry =
  | { readonly kind: "task"; readonly entry: SkillRevisionEntry }
  | { readonly kind: "manual"; readonly record: SkillManualRevisionRecord };
export function skillRevisionHistoryEntries(
  entries: readonly SkillRevisionEntry[],
  records: readonly SkillManualRevisionRecord[],
  stateFilter = "",
  capabilityFilter = "",
): readonly SkillRevisionHistoryEntry[] {
  const tasks: SkillRevisionHistoryEntry[] = filterSkillRevisionEntries(
    entries,
    stateFilter,
    capabilityFilter,
  ).map((entry) => ({ kind: "task", entry }));
  const manual: SkillRevisionHistoryEntry[] = records
    .filter(
      (record) =>
        (capabilityFilter === "" || record.capabilityId === capabilityFilter) &&
        (stateFilter === "" || stateFilter === "manual" || stateFilter === "completed"),
    )
    .map((record) => ({ kind: "manual", record }));
  const timestamp = (entry: SkillRevisionHistoryEntry) =>
    entry.kind === "manual" ? entry.record.createdAt : entry.entry.job.updatedAt;
  return [...tasks, ...manual].toSorted((left, right) =>
    timestamp(right).localeCompare(timestamp(left)),
  );
}

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
      entry.draft.state === "needs_rebase" ||
      entry.job.error?.code === "skill_revision_validation_required");
  return { canContinue, canRetry: !canContinue };
}

export function canDeleteSkillRevisionJob(state: ManagedSkillRevisionJob["state"]): boolean {
  // A revision task is removable regardless of its current lifecycle state.
  // The service takes care of marking related jobs as discarded before moving
  // the draft to trash.
  void state;
  return true;
}

export function canRetrySkillRevisionJob(
  state: ManagedSkillRevisionJob["state"],
  errorCode?: string,
): boolean {
  return (
    (state === "needs_attention" || state === "rejected") &&
    errorCode !== "skill_revision_base_changed"
  );
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
      {canRetrySkillRevisionJob(props.jobState, props.errorCode) &&
      (props.jobState !== "needs_attention" || attentionActions.canRetry) ? (
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
  readonly onRebase: () => void;
}) {
  const { t, i18n } = useTranslation("studio");
  const { job, draft } = props.entry;
  const [review, setReview] = useState<SkillRevisionReview>();
  const [reviewError, setReviewError] = useState<string>();
  useEffect(() => {
    const api = desktopApi();
    let active = true;
    setReview(undefined);
    setReviewError(undefined);
    if (api !== undefined)
      void api
        .getSkillRevisionReview(job.id)
        .then((value) => {
          if (active) setReview(value);
        })
        .catch((cause) => {
          if (active) setReviewError(errorMessage(cause));
        });
    return () => {
      active = false;
    };
  }, [job.id, job.revision]);
  const loadFile = useCallback(
    async (path: string) => {
      const api = desktopApi();
      if (api === undefined) throw new Error(t("revisionDiffUnavailable"));
      return await api.getSkillRevisionReviewFile({ jobId: job.id, path });
    },
    [job.id, t],
  );
  const attentionActions = skillRevisionAttentionActions(props.entry, props.canOpenMission);
  const needsRebase = job.state === "needs_rebase";
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
              {canRetrySkillRevisionJob(job.state, job.error?.code) &&
              (job.state !== "needs_attention" || attentionActions.canRetry) ? (
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
          {needsRebase ? (
            <aside
              className="revision-rebase-guidance"
              aria-labelledby="skill-revision-rebase-guidance-title"
            >
              <WarningCircle
                className="revision-rebase-guidance-icon"
                size={22}
                aria-hidden="true"
              />
              <div className="revision-rebase-guidance-body">
                <h2 id="skill-revision-rebase-guidance-title">
                  {t("skillRevisionNeedsRebaseTitle")}
                </h2>
                <p>{t("skillRevisionNeedsRebaseDescription")}</p>
                {job.missionId !== undefined && props.canOpenMission ? (
                  <>
                    <ol>
                      <li>{t("skillRevisionNeedsRebaseStepOpenMission")}</li>
                      <li>{t("skillRevisionNeedsRebaseStepReopen")}</li>
                      <li>
                        {t("skillRevisionNeedsRebaseStepAskAgent", {
                          prompt: t("skillRevisionNeedsRebasePrompt"),
                        })}
                      </li>
                      <li>{t("skillRevisionNeedsRebaseStepReview")}</li>
                    </ol>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={props.busy}
                      onClick={props.onRebase}
                    >
                      {t("openSkillRevisionMissionToRebase")}
                    </button>
                  </>
                ) : (
                  <p className="revision-rebase-guidance-fallback">
                    {t("skillRevisionNeedsRebaseNoMission")}
                  </p>
                )}
              </div>
            </aside>
          ) : null}
        </header>
      }
    >
      <SkillRevisionChangeViewer
        key={job.id}
        operations={review?.operations ?? []}
        loading={review === undefined}
        request={job.request.prompt}
        summary={draft.summary ?? t("skillRevisionSummaryUnavailable")}
        summaryError={job.error?.message}
        error={props.error ?? reviewError}
        loadFile={loadFile}
      />
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
  const [manualRecords, setManualRecords] = useState<readonly SkillManualRevisionRecord[]>([]);
  const [selectedRecordKey, setSelectedRecordKey] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<SkillRevisionEntry>();
  const [selectedJobId, setSelectedJobId] = useState<string>();
  const [capabilityFilter, setCapabilityFilter] = useState(props.capabilityId ?? "");
  const [stateFilter, setStateFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const load = useCallback(async () => {
    const api = desktopApi();
    if (api === undefined) return;
    setLoading(true);
    try {
      const [jobsResult, recordsResult] = await Promise.allSettled([
        api.listSkillRevisionJobs(),
        api.listSkillManualRevisions(),
      ]);
      if (jobsResult.status === "fulfilled") {
        setEntries(jobsResult.value);
        props.onCountChanged?.(activeSkillRevisionTaskCount(jobsResult.value));
      }
      if (recordsResult.status === "fulfilled") setManualRecords(recordsResult.value);
      const failed = [jobsResult, recordsResult].find((result) => result.status === "rejected");
      setError(failed?.status === "rejected" ? errorMessage(failed.reason) : undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [props.capabilityId, props.onCountChanged]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    setCapabilityFilter(props.capabilityId ?? "");
  }, [props.capabilityId]);
  const skillCapabilities = useMemo(
    () => props.capabilities.filter((capability) => capability.definition.kind === "skill"),
    [props.capabilities],
  );

  const filteredEntries = useMemo(
    () => skillRevisionHistoryEntries(entries, manualRecords, stateFilter, capabilityFilter),
    [entries, manualRecords, stateFilter, capabilityFilter],
  );
  const pageCount = Math.max(1, Math.ceil(filteredEntries.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageEntries = filteredEntries.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  useEffect(() => {
    setPage(currentPage);
  }, [currentPage]);
  useEffect(() => {
    setPage(1);
  }, [capabilityFilter, stateFilter, pageSize]);

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

  const selectedRecord = manualRecords.find(
    (record) => `${record.capabilityId}:${record.revision}` === selectedRecordKey,
  );
  if (selectedRecord !== undefined)
    return (
      <SkillManualRevisionDetailFragment
        key={selectedRecordKey}
        record={selectedRecord}
        capability={props.capabilities.find(
          (capability) => capability.manifest.id === selectedRecord.capabilityId,
        )}
        onBack={() => setSelectedRecordKey(undefined)}
      />
    );
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
        onRebase={() =>
          props.onOpenMission?.(selectedEntry.job.missionId!, t("skillRevisionNeedsRebasePrompt"))
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
                {t("skillRevisionHistoryCount", { count: entries.length + manualRecords.length })}
              </span>
            </div>
          </div>
          <SelectMenu
            className="revision-task-select"
            ariaLabel={t("revisionSkillFilter")}
            value={capabilityFilter}
            icon={<FunnelSimple size={15} aria-hidden="true" />}
            align="end"
            options={[
              { value: "", label: t("allSkills") },
              ...skillCapabilities.map((capability) => ({
                value: capability.manifest.id,
                label: capability.manifest.name,
              })),
            ]}
            onChange={setCapabilityFilter}
          />
        </header>
      }
    >
      <div className="revision-task-content">
        {entries.length + manualRecords.length > 0 ? (
          <div className="revision-task-toolbar">
            <SelectMenu
              ariaLabel={t("revisionStatusFilter")}
              value={stateFilter}
              onChange={setStateFilter}
              options={[
                { value: "", label: t("revisionAllStates") },
                { value: "actionable", label: t("revisionActionable") },
                { value: "manual", label: t("skillManualRevisionTitle") },
                ...[
                  "editing",
                  "running",
                  "pending_review",
                  "publishing",
                  "completed",
                  "rejected",
                  "needs_rebase",
                  "needs_attention",
                  "superseded",
                ].map((value) => ({ value, label: t(`revisionState.${value}`) })),
              ]}
            />
          </div>
        ) : null}
        {loading ? <p className="directory-empty">{t("loadingSkillRevisions")}</p> : null}
        {!loading && entries.length + manualRecords.length === 0 ? (
          <SkillRevisionEmptyState />
        ) : null}
        {!loading && entries.length + manualRecords.length > 0 && filteredEntries.length === 0 ? (
          <div className="revision-task-empty">
            <ClockCounterClockwise size={28} aria-hidden="true" />
            <h3>{t("revisionNoMatches")}</h3>
            <p>{t("revisionNoMatchesDescription")}</p>
            <button className="secondary-button" type="button" onClick={() => setStateFilter("")}>
              {t("revisionClearFilters")}
            </button>
          </div>
        ) : null}
        {!loading && filteredEntries.length > 0 ? (
          <div className="revision-task-table">
            <div className="revision-task-list-header" aria-hidden="true">
              <span>{t("revisionTaskColumn")}</span>
              <span>{t("status")}</span>
              <span>{t("revisionUpdatedAt")}</span>
              <span>{t("actions")}</span>
            </div>
            <div className="revision-task-list" role="list" aria-label={t("skillRevisions")}>
              {pageEntries.map((historyEntry) => {
                if (historyEntry.kind === "manual")
                  return (
                    <SkillManualRevisionRow
                      key={`${historyEntry.record.capabilityId}:${historyEntry.record.revision}`}
                      record={historyEntry.record}
                      capability={props.capabilities.find(
                        (capability) => capability.manifest.id === historyEntry.record.capabilityId,
                      )}
                      onOpen={() =>
                        setSelectedRecordKey(
                          `${historyEntry.record.capabilityId}:${historyEntry.record.revision}`,
                        )
                      }
                    />
                  );
                const entry = historyEntry.entry;
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
        {filteredEntries.length > 0 ? (
          <nav className="revision-task-pagination" aria-label={t("revisionPagination")}>
            <span>
              {t("revisionPageRange", {
                start: (currentPage - 1) * pageSize + 1,
                end: Math.min(currentPage * pageSize, filteredEntries.length),
                count: filteredEntries.length,
              })}
            </span>
            <SelectMenu
              ariaLabel={t("revisionPageSize")}
              value={String(pageSize)}
              onChange={(value) => setPageSize(Number(value))}
              options={[20, 50, 100].map((value) => ({
                value: String(value),
                label: t("revisionPerPage", { count: value }),
              }))}
            />
            <button
              className="secondary-button"
              type="button"
              disabled={currentPage <= 1}
              onClick={() => setPage(currentPage - 1)}
            >
              {t("revisionPreviousPage")}
            </button>
            <span>
              {currentPage} / {pageCount}
            </span>
            <button
              className="secondary-button"
              type="button"
              disabled={currentPage >= pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              {t("revisionNextPage")}
            </button>
          </nav>
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
