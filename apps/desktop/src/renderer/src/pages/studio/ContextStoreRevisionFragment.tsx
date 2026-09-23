import {
  ArrowClockwise,
  ArrowLeft,
  Check,
  ClockCounterClockwise,
  FileText,
  FunnelSimple,
  Plus,
  Trash,
  X,
  WarningCircle,
} from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  ContextStore,
  ContextStoreChangeSet,
  ContextStoreDraft,
  ContextStoreRevisionRecord,
  ContextStoreRevisionDiff,
  ContextStoreRevisionJob,
} from "../../../../shared/contracts/index.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { localizedContextStoreRevisionError } from "../../lib/context-store-revision-errors.ts";
import { StudioConfirmationDialog } from "./StudioDialog.tsx";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

import {
  filterRevisionEntries,
  isDraftAwaitingConfirmation,
  revisionEntries,
  revisionPage,
  snapshotDiffItems,
} from "./context-store-revision-model.ts";

type RevisionOperation =
  | {
      readonly operation: "upsert";
      readonly id: string;
      readonly content: string;
      readonly previousContent?: string | undefined;
    }
  | {
      readonly operation: "delete";
      readonly id: string;
      readonly previousContent?: string | undefined;
    };
type RevisionDiffSelection =
  | { readonly kind: "request" }
  | { readonly kind: "summary" }
  | { readonly kind: "operation"; readonly index: number };

export interface RevisionDiffLine {
  readonly kind: "context" | "addition" | "deletion";
  readonly content: string;
  readonly oldLine?: number | undefined;
  readonly newLine?: number | undefined;
}

export function buildRevisionLineDiff(before: string, after: string): readonly RevisionDiffLine[] {
  const previous = splitLines(before);
  const next = splitLines(after);
  if (previous.length > 400 || next.length > 400) return buildLargeLineDiff(previous, next);

  const matrix = Array.from(
    { length: previous.length + 1 },
    () => new Uint32Array(next.length + 1),
  );
  for (let oldIndex = previous.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = next.length - 1; newIndex >= 0; newIndex -= 1) {
      matrix[oldIndex]![newIndex] =
        previous[oldIndex] === next[newIndex]
          ? matrix[oldIndex + 1]![newIndex + 1]! + 1
          : Math.max(matrix[oldIndex + 1]![newIndex]!, matrix[oldIndex]![newIndex + 1]!);
    }
  }

  const lines: RevisionDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < previous.length || newIndex < next.length) {
    if (
      oldIndex < previous.length &&
      newIndex < next.length &&
      previous[oldIndex] === next[newIndex]
    ) {
      lines.push({
        kind: "context",
        content: previous[oldIndex]!,
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      oldIndex < previous.length &&
      (newIndex === next.length ||
        matrix[oldIndex + 1]![newIndex]! >= matrix[oldIndex]![newIndex + 1]!)
    ) {
      lines.push({ kind: "deletion", content: previous[oldIndex]!, oldLine: oldIndex + 1 });
      oldIndex += 1;
    } else {
      lines.push({ kind: "addition", content: next[newIndex]!, newLine: newIndex + 1 });
      newIndex += 1;
    }
  }
  return lines;
}

export function ContextStoreRevisionFragment(props: {
  readonly stores: readonly ContextStore[];
  readonly initialStoreId?: string | undefined;
  readonly onCountChanged?: ((count: number) => void) | undefined;
  readonly onPublished?: (() => Promise<void>) | undefined;
  readonly onOpenMission?: ((missionId: string, composerDraft?: string) => void) | undefined;
  readonly onBack: () => void;
}) {
  const { t, i18n } = useTranslation("studio");
  const translateRevisionError = (key: string, options?: Record<string, unknown>) =>
    options === undefined ? t(key) : t(key, options);
  const [storeId, setStoreId] = useState(props.initialStoreId ?? "");
  const [jobs, setJobs] = useState<readonly ContextStoreRevisionJob[]>([]);
  const [drafts, setDrafts] = useState<readonly ContextStoreDraft[]>([]);
  const [revisionRecords, setRevisionRecords] = useState<readonly ContextStoreRevisionRecord[]>([]);
  const [stateFilter, setStateFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selectedRecord, setSelectedRecord] = useState<ContextStoreRevisionRecord | null>(null);
  const loadGeneration = useRef(0);
  const activeStoreId = useRef<string | null>(storeId);
  useLayoutEffect(() => {
    activeStoreId.current = storeId;
    return () => {
      activeStoreId.current = null;
    };
  }, [storeId]);
  const scrollPosition = useRef(0);
  const frameScrollPosition = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ContextStoreRevisionJob | null>(null);
  const [pendingRecordDelete, setPendingRecordDelete] = useState<ContextStoreRevisionRecord | null>(
    null,
  );
  const [pendingDiscard, setPendingDiscard] = useState<ContextStoreDraft | null>(null);

  const load = async () => {
    const api = desktopApi();
    if (api === undefined || activeStoreId.current !== storeId) return;
    const generation = ++loadGeneration.current;
    const [jobsResult, allJobsResult, draftsResult, recordsResult] = await Promise.allSettled([
      api.listContextStoreRevisions(storeId === "" ? {} : { storeId }),
      storeId === "" ? undefined : api.listContextStoreRevisions(),
      api.listContextStoreDrafts(storeId === "" ? {} : { storeId }),
      api.listContextStoreRevisionRecords(storeId === "" ? {} : { storeId }),
    ]);
    if (generation !== loadGeneration.current || activeStoreId.current !== storeId) return;
    if (jobsResult.status === "fulfilled") {
      setJobs(jobsResult.value);
      const globalJobs =
        storeId === ""
          ? jobsResult.value
          : allJobsResult.status === "fulfilled"
            ? allJobsResult.value
            : undefined;
      if (globalJobs !== undefined) {
        props.onCountChanged?.(
          globalJobs.filter((job) => !["merged", "rejected"].includes(job.state)).length,
        );
      }
    }
    if (draftsResult.status === "fulfilled") setDrafts(draftsResult.value);
    if (recordsResult.status === "fulfilled") setRevisionRecords(recordsResult.value);
    const failed = [jobsResult, allJobsResult, draftsResult, recordsResult].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    setError(
      failed === undefined
        ? null
        : localizedContextStoreRevisionError(failed.reason, translateRevisionError),
    );
  };

  useEffect(() => {
    setStoreId(props.initialStoreId ?? "");
  }, [props.initialStoreId]);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      await load();
      if (active) timer = window.setTimeout(() => void poll(), 2_000);
    };
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
      loadGeneration.current += 1;
    };
  }, [storeId]);

  const act = async (
    job: ContextStoreRevisionJob,
    action: "approve" | "reject" | "retry" | "delete",
  ) => {
    const api = desktopApi();
    if (api === undefined) return;
    setBusy(job.id);
    try {
      const input = { jobId: job.id, expectedRevision: job.revision };
      if (action === "approve") await api.approveContextStoreRevision(input);
      else if (action === "reject") await api.rejectContextStoreRevision(input);
      else if (action === "retry") await api.retryContextStoreRevision(input);
      else await api.deleteContextStoreRevision(input);
      if (action === "approve") await props.onPublished?.();
      if (activeStoreId.current !== storeId) return;
      if (action === "delete") {
        setSelectedJobId(null);
        setPendingDelete(null);
      }
      await load();
    } catch (caught) {
      if (activeStoreId.current === storeId) {
        setError(localizedContextStoreRevisionError(caught, translateRevisionError));
      }
    } finally {
      setBusy((current) => (current === job.id ? null : current));
    }
  };

  const discard = async (draft: ContextStoreDraft) => {
    const api = desktopApi();
    if (api === undefined) return;
    const actionId = `discard:${draft.id}`;
    setBusy(actionId);
    try {
      await api.discardContextStoreDraft({
        draftId: draft.id,
        expectedRevision: draft.revision,
      });
      if (activeStoreId.current !== storeId) return;
      setPendingDiscard(null);
      setSelectedJobId(null);
      await load();
    } catch (caught) {
      if (activeStoreId.current === storeId) {
        setError(localizedContextStoreRevisionError(caught, translateRevisionError));
      }
    } finally {
      setBusy((current) => (current === actionId ? null : current));
    }
  };

  const deleteRecord = async (record: ContextStoreRevisionRecord) => {
    const api = desktopApi();
    if (api === undefined) return;
    const actionId = `record:${record.storeId}:${record.revision}`;
    setBusy(actionId);
    try {
      await api.deleteContextStoreRevisionRecord({
        storeId: record.storeId,
        revision: record.revision,
        snapshotHash: record.snapshotHash,
      });
      if (activeStoreId.current !== storeId) return;
      setPendingRecordDelete(null);
      setSelectedRecord(null);
      await load();
    } catch (caught) {
      if (activeStoreId.current === storeId) {
        setError(localizedContextStoreRevisionError(caught, translateRevisionError));
      }
    } finally {
      setBusy((current) => (current === actionId ? null : current));
    }
  };

  const entries = useMemo(
    () => filterRevisionEntries(revisionEntries(jobs, revisionRecords), "", "", storeId),
    [jobs, revisionRecords, storeId],
  );
  const filtered = useMemo(
    () => filterRevisionEntries(entries, stateFilter, sourceFilter),
    [entries, stateFilter, sourceFilter],
  );
  const unlinkedDrafts = useMemo(
    () =>
      drafts.filter(
        (draft) => draft.state !== "merged" && !jobs.some((job) => job.draftId === draft.id),
      ),
    [drafts, jobs],
  );
  const { items: pageItems, currentPage, pageCount } = revisionPage(filtered, page, pageSize);
  useEffect(() => {
    setPage(currentPage);
  }, [currentPage]);
  useEffect(() => {
    setPage(1);
    scrollPosition.current = 0;
    listRef.current?.scrollTo?.(0, 0);
  }, [storeId, stateFilter, sourceFilter, pageSize]);
  useEffect(() => {
    if (selectedJobId === null && selectedRecord === null && listRef.current !== null) {
      listRef.current.scrollTop = scrollPosition.current;
      const frame = listRef.current.closest(".context-store-revisions");
      if (frame !== null) frame.scrollTop = frameScrollPosition.current;
    }
  }, [selectedJobId, selectedRecord]);
  const rememberScroll = () => {
    scrollPosition.current = listRef.current?.scrollTop ?? 0;
    frameScrollPosition.current =
      listRef.current?.closest(".context-store-revisions")?.scrollTop ?? 0;
  };
  const openJob = (id: string) => {
    rememberScroll();
    setSelectedJobId(id);
  };
  const openRecord = (record: ContextStoreRevisionRecord) => {
    rememberScroll();
    setSelectedRecord(record);
  };
  const selectedJob = jobs.find((job) => job.id === selectedJobId);
  const selectedDraft = drafts.find((draft) => draft.id === selectedJob?.draftId);
  if (selectedRecord !== null)
    return (
      <ContextStoreManualRevisionDiffFragment
        record={selectedRecord}
        store={props.stores.find((store) => store.id === selectedRecord.storeId)}
        onBack={() => setSelectedRecord(null)}
      />
    );
  if (selectedJob !== undefined && selectedDraft !== undefined) {
    return (
      <ContextStoreRevisionDiffFragment
        job={selectedJob}
        draft={selectedDraft}
        store={props.stores.find((store) => store.id === selectedJob.request.storeId)}
        busy={busy === selectedJob.id}
        error={error}
        onBack={() => setSelectedJobId(null)}
        onApprove={() => void act(selectedJob, "approve")}
        onReject={() => void act(selectedJob, "reject")}
        onRetry={() => void act(selectedJob, "retry")}
        onOpenMission={props.onOpenMission}
      />
    );
  }

  return (
    <StudioScreenFrame
      className="context-store-revisions"
      labelledBy="context-store-revisions-title"
      header={
        <header className="studio-heading revision-task-heading">
          <div className="revision-task-heading-copy">
            <button className="back-link" type="button" onClick={props.onBack}>
              <ArrowLeft size={18} aria-hidden="true" />
              {t("backKnowledgeBases")}
            </button>
            <div>
              <div>
                <h1 id="context-store-revisions-title">{t("contextStoreRevisions")}</h1>
                <p>{t("contextStoreRevisionsDescription")}</p>
              </div>
              <span className="revision-task-count">
                {t("revisionTaskCount", { count: entries.length })}
              </span>
            </div>
          </div>
          <SelectMenu
            className="revision-task-select"
            ariaLabel={t("revisionStoreFilter")}
            value={storeId}
            icon={<FunnelSimple size={15} aria-hidden="true" />}
            align="end"
            options={[
              { value: "", label: t("allKnowledgeBases") },
              ...props.stores.map((store) => ({ value: store.id, label: store.name })),
            ]}
            onChange={setStoreId}
          />
        </header>
      }
    >
      <div className="revision-task-content">
        <div className="revision-task-toolbar">
          <SelectMenu
            ariaLabel={t("revisionStatusFilter")}
            value={stateFilter}
            onChange={setStateFilter}
            options={[
              { value: "", label: t("revisionAllStates") },
              { value: "actionable", label: t("revisionActionable") },
              ...[
                "editing",
                "awaiting_confirmation",
                "running",
                "pending_review",
                "merging",
                "merged",
                "rejected",
                "needs_rebase",
                "needs_attention",
              ].map((value) => ({
                value,
                label:
                  value === "awaiting_confirmation"
                    ? t("revisionDraftAwaitingConfirmation")
                    : value === "needs_attention"
                      ? t("revisionErrors")
                      : value === "merged"
                        ? t("revisionApplied")
                        : t(`revisionState.${value}`),
              })),
            ]}
          />
          <SelectMenu
            ariaLabel={t("revisionSourceFilter")}
            value={sourceFilter}
            onChange={setSourceFilter}
            options={[
              { value: "", label: t("revisionAllSources") },
              ...["manual", "user", "memory-learning", "expert-reflection"].map((value) => ({
                value,
                label: t(`revisionSource.${value}`),
              })),
            ]}
          />
        </div>
        {unlinkedDrafts.length > 0 ? (
          <section
            className={`revision-orphan-drafts${filtered.length === 0 ? " is-only" : ""}`}
            aria-labelledby="revision-orphan-drafts-title"
          >
            <div className="revision-orphan-drafts-heading">
              <div>
                <h2 id="revision-orphan-drafts-title">{t("unlinkedRevisionDraftsTitle")}</h2>
                <p>{t("unlinkedRevisionDraftsDescription")}</p>
              </div>
              <span className="revision-task-count">{unlinkedDrafts.length}</span>
            </div>
            <div className="revision-orphan-draft-list" role="list">
              {unlinkedDrafts.map((draft) => {
                const store = props.stores.find((candidate) => candidate.id === draft.storeId);
                const storeName =
                  store?.name ?? draft.resourceName ?? t("unavailableKnowledgeBase");
                return (
                  <article className="revision-orphan-draft-row" role="listitem" key={draft.id}>
                    <span className="revision-task-summary">
                      <strong title={draft.name}>{draft.name}</strong>
                      <small>
                        {storeName} · {t(`revisionState.${draft.state}`)} · {t("revisionUpdatedAt")}{" "}
                        {formatRevisionTimestamp(draft.updatedAt, i18n.language)}
                      </small>
                    </span>
                    <div className="revision-task-actions">
                      <button
                        className="revision-task-icon-button is-danger"
                        type="button"
                        aria-label={t("discardRevisionDraft")}
                        title={t("discardRevisionDraft")}
                        disabled={busy !== null}
                        onClick={() => setPendingDiscard(draft)}
                      >
                        <Trash size={16} aria-hidden="true" />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}
        {filtered.length === 0 && (unlinkedDrafts.length === 0 || entries.length > 0) ? (
          <div className="revision-task-empty">
            <ClockCounterClockwise size={28} aria-hidden="true" />
            <h3>{t(entries.length === 0 ? "noStoreRevisionTasks" : "revisionNoMatches")}</h3>
            <p>
              {t(
                entries.length === 0
                  ? "noStoreRevisionTasksDescription"
                  : "revisionNoMatchesDescription",
              )}
            </p>
            {entries.length > 0 || storeId !== "" || stateFilter !== "" || sourceFilter !== "" ? (
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setStoreId("");
                  setStateFilter("");
                  setSourceFilter("");
                }}
              >
                {t("revisionClearFilters")}
              </button>
            ) : null}
          </div>
        ) : filtered.length > 0 ? (
          <div className="revision-task-table" ref={listRef}>
            <div className="revision-task-list-header" aria-hidden="true">
              <span>{t("revisionTaskColumn")}</span>
              <span>{t("status")}</span>
              <span>{t("revisionUpdatedAt")}</span>
              <span>{t("actions")}</span>
            </div>
            <div className="revision-task-list" role="list">
              {pageItems.map((entry) => {
                if (entry.kind === "manual")
                  return (
                    <ContextStoreManualRevisionRow
                      key={entry.key}
                      record={entry.record}
                      store={props.stores.find(
                        (candidate) => candidate.id === entry.record.storeId,
                      )}
                      busy={busy === `record:${entry.record.storeId}:${entry.record.revision}`}
                      onOpen={() => openRecord(entry.record)}
                      onDelete={() => setPendingRecordDelete(entry.record)}
                    />
                  );
                const job = entry.job;
                const store = props.stores.find(
                  (candidate) => candidate.id === job.request.storeId,
                );
                const draft = drafts.find((candidate) => candidate.id === job.draftId);
                const canOpen = draft !== undefined;
                const awaitingConfirmation = isDraftAwaitingConfirmation(job);
                const openLabel =
                  job.state === "needs_rebase"
                    ? t("handleRevisionRebase")
                    : t("viewRevisionChanges");
                return (
                  <article className="revision-task-row" role="listitem" key={job.id}>
                    <button
                      className="revision-task-open"
                      type="button"
                      disabled={!canOpen}
                      aria-label={canOpen ? openLabel : undefined}
                      onClick={() => canOpen && openJob(job.id)}
                    >
                      <span className="revision-task-summary">
                        <strong title={job.request.prompt}>{job.request.prompt}</strong>
                        <small
                          title={
                            store?.name ?? draft?.resourceName ?? t("unavailableKnowledgeBase")
                          }
                        >
                          {store?.name ?? draft?.resourceName ?? t("unavailableKnowledgeBase")} ·{" "}
                          {draft?.operation === "create"
                            ? `${t("newKnowledgeBaseRevision")} · `
                            : ""}
                          {t(`revisionSource.${job.request.source}`)}
                        </small>
                      </span>
                      <span className="revision-task-result">
                        <span
                          className={`revision-task-state is-${job.state}`}
                          title={
                            awaitingConfirmation
                              ? t("revisionDraftAwaitingConfirmation")
                              : t(`revisionState.${job.state}`)
                          }
                        >
                          {awaitingConfirmation
                            ? t("revisionDraftAwaitingConfirmation")
                            : t(`revisionState.${job.state}`)}
                        </span>
                        {job.error !== undefined && !awaitingConfirmation ? (
                          <span
                            className="form-error"
                            role="alert"
                            title={localizedContextStoreRevisionError(
                              job.error,
                              translateRevisionError,
                            )}
                          >
                            {localizedContextStoreRevisionError(job.error, translateRevisionError)}
                          </span>
                        ) : null}
                      </span>
                      <time
                        className="revision-task-updated"
                        dateTime={job.updatedAt}
                        title={formatRevisionTimestamp(job.updatedAt, i18n.language)}
                      >
                        {formatRevisionTimestamp(job.updatedAt, i18n.language)}
                      </time>
                    </button>
                    <ContextStoreRevisionTaskActions
                      job={job}
                      draft={draft}
                      busy={busy}
                      onRetry={() => void act(job, "retry")}
                      onDiscard={setPendingDiscard}
                      onDelete={() => setPendingDelete(job)}
                    />
                  </article>
                );
              })}
            </div>
          </div>
        ) : null}
        <nav className="revision-task-pagination" aria-label={t("revisionPagination")}>
          <span>
            {t("revisionPageRange", {
              start: filtered.length === 0 ? 0 : (currentPage - 1) * pageSize + 1,
              end: Math.min(currentPage * pageSize, filtered.length),
              count: filtered.length,
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
            onClick={() => {
              setPage(currentPage - 1);
              listRef.current?.scrollTo?.(0, 0);
            }}
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
            onClick={() => {
              setPage(currentPage + 1);
              listRef.current?.scrollTo?.(0, 0);
            }}
          >
            {t("revisionNextPage")}
          </button>
        </nav>
        {error !== null ? <p className="form-error">{error}</p> : null}
      </div>
      {pendingDelete !== null ? (
        <StudioConfirmationDialog
          className="revision-task-delete-dialog"
          title={t("deleteRevisionTaskTitle")}
          description={t("deleteRevisionTaskDescription", {
            name: pendingDelete.request.prompt,
          })}
          cancelLabel={t("cancel")}
          confirmLabel={t("deleteRevisionTask")}
          busyLabel={t("deleting")}
          busy={busy === pendingDelete.id}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void act(pendingDelete, "delete")}
          action="delete"
        />
      ) : null}
      {pendingRecordDelete !== null ? (
        <StudioConfirmationDialog
          className="revision-task-delete-dialog"
          title={t("deleteRevisionRecordTitle")}
          description={t("deleteRevisionRecordDescription", {
            name: pendingRecordDelete.summary,
          })}
          cancelLabel={t("cancel")}
          confirmLabel={t("deleteRevisionRecord")}
          busyLabel={t("deleting")}
          busy={busy === `record:${pendingRecordDelete.storeId}:${pendingRecordDelete.revision}`}
          onCancel={() => setPendingRecordDelete(null)}
          onConfirm={() => void deleteRecord(pendingRecordDelete)}
          action="delete"
        />
      ) : null}
      {pendingDiscard !== null ? (
        <StudioConfirmationDialog
          className="revision-task-delete-dialog"
          title={t("discardRevisionDraftTitle")}
          description={t("discardRevisionDraftDescription", { name: pendingDiscard.name })}
          cancelLabel={t("cancel")}
          confirmLabel={t("discardRevisionDraft")}
          busyLabel={t("deleting")}
          busy={busy === `discard:${pendingDiscard.id}`}
          onCancel={() => setPendingDiscard(null)}
          onConfirm={() => void discard(pendingDiscard)}
          action="delete"
        />
      ) : null}
    </StudioScreenFrame>
  );
}

export function ContextStoreManualRevisionRow(props: {
  readonly record: ContextStoreRevisionRecord;
  readonly onOpen: () => void;
  readonly onDelete: () => void;
  readonly busy?: boolean | undefined;
  readonly store: ContextStore | undefined;
}) {
  const { t, i18n } = useTranslation("studio");
  return (
    <article className="revision-task-row" role="listitem">
      <button
        className="revision-task-open"
        type="button"
        onClick={props.onOpen}
        aria-label={t("viewRevisionChanges")}
      >
        <span className="revision-task-summary">
          <strong>{props.record.summary}</strong>
          <small>
            {props.store?.name ?? t("unavailableKnowledgeBase")} ·{` `}
            {t("knowledgeRevisionNumber", { count: props.record.revision })}
          </small>
        </span>
        <span className="revision-task-result">
          <span className="revision-task-state is-manual">{t("revisionSource.manual")}</span>
        </span>
        <time
          className="revision-task-updated"
          dateTime={props.record.createdAt}
          title={formatRevisionTimestamp(props.record.createdAt, i18n.language)}
        >
          {formatRevisionTimestamp(props.record.createdAt, i18n.language)}
        </time>
      </button>
      <div className="revision-task-actions">
        <button
          className="revision-task-icon-button is-danger"
          type="button"
          aria-label={t("deleteRevisionRecord")}
          title={t("deleteRevisionRecord")}
          disabled={props.busy}
          onClick={props.onDelete}
        >
          <Trash size={16} aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}

export function ContextStoreRevisionTaskActions(props: {
  readonly job: ContextStoreRevisionJob;
  readonly draft: ContextStoreDraft | undefined;
  readonly busy: string | null;
  readonly onRetry: () => void;
  readonly onDiscard: (draft: ContextStoreDraft) => void;
  readonly onDelete: () => void;
}) {
  const { t } = useTranslation("studio");
  const awaitingConfirmation = isDraftAwaitingConfirmation(props.job);
  const discardableDraft =
    props.draft !== undefined && props.draft.state !== "merged" ? props.draft : undefined;
  const canRetry =
    (props.job.state === "needs_attention" && !awaitingConfirmation) ||
    props.job.state === "rejected";

  return (
    <div className="revision-task-actions">
      {canRetry ? (
        <button
          className="revision-task-icon-button"
          type="button"
          aria-label={t("retryRevision")}
          title={t("retryRevision")}
          disabled={props.busy === props.job.id}
          onClick={props.onRetry}
        >
          <ArrowClockwise size={16} aria-hidden="true" />
        </button>
      ) : null}
      {discardableDraft !== undefined ? (
        <button
          className="revision-task-icon-button is-danger"
          type="button"
          aria-label={t("discardRevisionDraft")}
          title={t("discardRevisionDraft")}
          disabled={props.busy !== null}
          onClick={() => props.onDiscard(discardableDraft)}
        >
          <Trash size={16} aria-hidden="true" />
        </button>
      ) : (
        <button
          className="revision-task-icon-button is-danger"
          type="button"
          aria-label={t("deleteRevisionTask")}
          title={t("deleteRevisionTask")}
          disabled={props.busy === props.job.id}
          onClick={props.onDelete}
        >
          <Trash size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function ContextStoreRevisionDiffFragment(props: {
  readonly job: ContextStoreRevisionJob;
  readonly draft: ContextStoreDraft;
  readonly store?: ContextStore | undefined;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onBack: () => void;
  readonly onApprove: () => void;
  readonly onReject: () => void;
  readonly onRetry: () => void;
  readonly onOpenMission?: ((missionId: string, composerDraft?: string) => void) | undefined;
}) {
  const { t, i18n } = useTranslation("studio");
  const [selection, setSelection] = useState<RevisionDiffSelection>({ kind: "summary" });
  const [reviewChangeSet, setReviewChangeSet] = useState<ContextStoreChangeSet>();
  useEffect(() => {
    const api = desktopApi();
    let active = true;
    setReviewChangeSet(undefined);
    if (api === undefined) {
      return () => {
        active = false;
      };
    }
    void api
      .getContextStoreDraftChangeSet(props.draft.id)
      .then((changeSet) => {
        if (active) setReviewChangeSet(changeSet);
      })
      .catch(() => {
        if (active) setReviewChangeSet(undefined);
      });
    return () => {
      active = false;
    };
  }, [props.draft.id, props.draft.revision]);
  const operations = useMemo(
    () => draftOverlayOperations(props.draft, reviewChangeSet),
    [props.draft, reviewChangeSet],
  );
  const operation =
    selection.kind === "operation" ? (operations[selection.index] ?? operations[0]) : undefined;
  const diff = useMemo(
    () => (operation === undefined ? [] : operationDiff(operation)),
    [operation],
  );
  const additions = diff.filter((line) => line.kind === "addition").length;
  const deletions = diff.filter((line) => line.kind === "deletion").length;
  const awaitingConfirmation = isDraftAwaitingConfirmation(props.job);
  const revisionMetadata = `${props.store?.name ?? props.draft.resourceName ?? props.job.request.storeId} · ${
    props.draft.operation === "create"
      ? t("publishesAsRevisionOne")
      : t("baseRevision", { count: props.draft.baseRevision })
  } · ${formatRevisionTimestamp(props.job.updatedAt, i18n.language)}`;

  return (
    <StudioScreenFrame
      className="context-store-revision-detail"
      labelledBy="context-store-revision-detail-title"
      header={
        <header className="revision-diff-heading">
          <button className="back-link" type="button" onClick={props.onBack}>
            <ArrowLeft size={18} aria-hidden="true" />
            {t("backRevisionTasks")}
          </button>
          <div className="revision-diff-title-row">
            <div>
              <h1 id="context-store-revision-detail-title">{t("revisionResult")}</h1>
              <p>{revisionMetadata}</p>
              {props.job.request.provenance === undefined ? null : (
                <p>
                  {props.job.request.provenance.teamId === undefined
                    ? t("revisionExpertProvenance", {
                        expertId: props.job.request.provenance.expertId,
                        executionId: props.job.request.provenance.executionId,
                      })
                    : t("revisionReflectionProvenance", {
                        teamId: props.job.request.provenance.teamId,
                        expertId: props.job.request.provenance.expertId,
                        executionId: props.job.request.provenance.executionId,
                      })}
                </p>
              )}
            </div>
            <div className="revision-diff-actions">
              <span className={`revision-task-state is-${props.job.state}`}>
                {awaitingConfirmation
                  ? t("revisionDraftAwaitingConfirmation")
                  : t(`revisionState.${props.job.state}`)}
              </span>
              {props.job.state === "pending_review" ? (
                <>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={props.busy}
                    onClick={props.onApprove}
                  >
                    <Check size={15} aria-hidden="true" />
                    {t("approveRevision")}
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
              {(props.job.state === "needs_attention" && !awaitingConfirmation) ||
              props.job.state === "rejected" ? (
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
              {props.job.state !== "needs_rebase" &&
              !awaitingConfirmation &&
              props.job.missionId !== undefined &&
              props.onOpenMission !== undefined ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => props.onOpenMission?.(props.job.missionId!)}
                >
                  {t("openRevisionMission")}
                </button>
              ) : null}
            </div>
          </div>
          {props.job.state === "needs_rebase" ? (
            <aside
              className="revision-rebase-guidance"
              aria-labelledby="revision-rebase-guidance-title"
            >
              <WarningCircle
                className="revision-rebase-guidance-icon"
                size={22}
                aria-hidden="true"
              />
              <div className="revision-rebase-guidance-body">
                <h2 id="revision-rebase-guidance-title">{t("revisionNeedsRebaseTitle")}</h2>
                <p>{t("revisionNeedsRebaseDescription")}</p>
                {props.job.missionId !== undefined && props.onOpenMission !== undefined ? (
                  <>
                    <ol>
                      <li>{t("revisionNeedsRebaseStepOpenMission")}</li>
                      <li>{t("revisionNeedsRebaseStepReopen")}</li>
                      <li>
                        {t("revisionNeedsRebaseStepAskAgent", {
                          prompt: t("revisionNeedsRebasePrompt"),
                        })}
                      </li>
                      <li>{t("revisionNeedsRebaseStepReview")}</li>
                    </ol>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={props.busy}
                      onClick={() =>
                        props.onOpenMission?.(props.job.missionId!, t("revisionNeedsRebasePrompt"))
                      }
                    >
                      {t("openRevisionMissionToRebase")}
                    </button>
                  </>
                ) : (
                  <p className="revision-rebase-guidance-fallback">
                    {t("revisionNeedsRebaseNoMission")}
                  </p>
                )}
              </div>
            </aside>
          ) : null}
          {awaitingConfirmation ? (
            <aside className="revision-rebase-guidance is-draft-paused">
              <FileText className="revision-rebase-guidance-icon" size={22} aria-hidden="true" />
              <div className="revision-rebase-guidance-body">
                <h2>{t("revisionDraftAwaitingConfirmationTitle")}</h2>
                <p>{t("revisionDraftAwaitingConfirmationDescription")}</p>
                {props.job.missionId !== undefined && props.onOpenMission !== undefined ? (
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={props.busy}
                    onClick={() => props.onOpenMission?.(props.job.missionId!)}
                  >
                    {t("openRevisionMissionToContinue")}
                  </button>
                ) : null}
              </div>
            </aside>
          ) : null}
        </header>
      }
    >
      <div className="revision-diff-content">
        <div className="revision-diff-workspace">
          <aside className="revision-diff-files" aria-label={t("revisionReviewContents")}>
            <div className="revision-diff-files-heading">
              <span>{t("revisionReviewContents")}</span>
            </div>
            <nav>
              <button
                className={selection.kind === "summary" ? "is-active" : undefined}
                type="button"
                onClick={() => setSelection({ kind: "summary" })}
              >
                <FileText size={17} aria-hidden="true" />
                <span>
                  <strong>{t("revisionSummaryFile")}</strong>
                  <small>{t("revisionSummaryFileLabel")}</small>
                </span>
              </button>
              <button
                className={selection.kind === "request" ? "is-active" : undefined}
                type="button"
                onClick={() => setSelection({ kind: "request" })}
              >
                <FileText size={17} aria-hidden="true" />
                <span>
                  <strong>{t("revisionRequestFile")}</strong>
                  <small>{t("revisionRequestFileLabel")}</small>
                </span>
              </button>
              <div className="revision-diff-file-group-label">
                {t("filesChanged", { count: operations.length })}
              </div>
              {operations.map((candidate, index) => (
                <button
                  className={
                    selection.kind === "operation" && selection.index === index
                      ? "is-active"
                      : undefined
                  }
                  type="button"
                  key={`${candidate.operation}:${candidate.id}:${index}`}
                  onClick={() => setSelection({ kind: "operation", index })}
                >
                  {operationIcon(candidate)}
                  <span>
                    <strong>{operationPath(candidate)}</strong>
                    <small>{t(`revisionOperation.${candidate.operation}`)}</small>
                  </span>
                </button>
              ))}
            </nav>
          </aside>
          <section className="revision-diff-view" aria-label={t("revisionDiff")}>
            <header>
              <div className="revision-diff-view-heading">
                <FileText size={16} aria-hidden="true" />
                <span>
                  <strong>
                    {selection.kind === "request"
                      ? t("revisionRequestFile")
                      : selection.kind === "summary"
                        ? t("revisionSummaryFile")
                        : operation === undefined
                          ? ""
                          : operationPath(operation)}
                  </strong>
                  {selection.kind === "request" ? (
                    <small>{t("revisionRequestDocumentDescription")}</small>
                  ) : selection.kind === "summary" ? (
                    <small>{t("revisionSummaryDocumentDescription")}</small>
                  ) : null}
                </span>
              </div>
              {operation === undefined ? null : (
                <span className="revision-diff-stats">
                  <b>+{additions}</b>
                  <i>−{deletions}</i>
                </span>
              )}
            </header>
            <div className="revision-diff-scroll-area">
              {selection.kind === "request" ? (
                <article className="revision-review-document">
                  <p>{props.job.request.prompt}</p>
                </article>
              ) : selection.kind === "summary" ? (
                <article className="revision-review-document">
                  <p>{props.draft.summary ?? props.draft.name}</p>
                </article>
              ) : operation === undefined ? null : reviewChangeSet === undefined ||
                (operation.operation === "delete" && operation.previousContent === undefined) ? (
                <div className="revision-diff-unavailable">
                  <p>{t("revisionDiffUnavailable")}</p>
                </div>
              ) : (
                <RevisionDiffCode lines={diff} />
              )}
            </div>
          </section>
        </div>
        {props.error !== null ? <p className="form-error">{props.error}</p> : null}
      </div>
    </StudioScreenFrame>
  );
}

function operationDiff(operation: RevisionOperation): readonly RevisionDiffLine[] {
  if (operation.operation === "delete") {
    return buildRevisionLineDiff(operation.previousContent ?? "", "");
  }
  return buildRevisionLineDiff(operation.previousContent ?? "", operation.content);
}

function operationPath(operation: RevisionOperation): string {
  return operation.id;
}

function operationIcon(operation: RevisionOperation) {
  if (operation.operation === "delete") return <Trash size={15} aria-hidden="true" />;
  if (operation.previousContent === undefined) return <Plus size={15} aria-hidden="true" />;
  return <FileText size={15} aria-hidden="true" />;
}

export function draftOverlayOperations(
  draft: ContextStoreDraft,
  reviewChangeSet?: ContextStoreChangeSet,
): readonly RevisionOperation[] {
  const reviewedById = new Map(
    (reviewChangeSet?.operations ?? [])
      .filter((operation) => operation.operation !== "rename")
      .map((operation) => [operation.id, operation] as const),
  );
  return [
    ...draft.overlay.files.map((file) => ({
      operation: "upsert" as const,
      id: file.id,
      content: file.content,
      previousContent: reviewedById.get(file.id)?.previousContent,
    })),
    ...draft.overlay.deletedFiles.map((id) => ({
      operation: "delete" as const,
      id,
      previousContent: reviewedById.get(id)?.previousContent,
    })),
  ];
}

function splitLines(value: string): readonly string[] {
  return value === "" ? [] : value.replace(/\r\n?/gu, "\n").split("\n");
}

function buildLargeLineDiff(
  previous: readonly string[],
  next: readonly string[],
): readonly RevisionDiffLine[] {
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
  ) {
    suffix += 1;
  }
  return [
    ...previous.slice(0, prefix).map((content, index) => ({
      kind: "context" as const,
      content,
      oldLine: index + 1,
      newLine: index + 1,
    })),
    ...previous.slice(prefix, previous.length - suffix).map((content, index) => ({
      kind: "deletion" as const,
      content,
      oldLine: prefix + index + 1,
    })),
    ...next.slice(prefix, next.length - suffix).map((content, index) => ({
      kind: "addition" as const,
      content,
      newLine: prefix + index + 1,
    })),
    ...previous.slice(previous.length - suffix).map((content, index) => ({
      kind: "context" as const,
      content,
      oldLine: previous.length - suffix + index + 1,
      newLine: next.length - suffix + index + 1,
    })),
  ];
}

function formatRevisionTimestamp(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function RevisionDiffCode({ lines }: { readonly lines: readonly RevisionDiffLine[] }) {
  return (
    <div className="revision-diff-code" role="table">
      {lines.map((line, index) => (
        <div
          className={`revision-diff-line is-${line.kind}`}
          role="row"
          key={`${line.kind}:${index}`}
        >
          <span role="cell">{line.oldLine ?? ""}</span>
          <span role="cell">{line.newLine ?? ""}</span>
          <b aria-hidden="true">
            {line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : ""}
          </b>
          <code role="cell">{line.content || " "}</code>
        </div>
      ))}
    </div>
  );
}

export function ContextStoreManualRevisionDiffFragment(props: {
  readonly record: ContextStoreRevisionRecord;
  readonly store: ContextStore | undefined;
  readonly onBack: () => void;
}) {
  const { t, i18n } = useTranslation("studio");
  const [snapshots, setSnapshots] = useState<ContextStoreRevisionDiff>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string>();
  useEffect(() => {
    let active = true;
    setSnapshots(undefined);
    setError(undefined);
    const api = desktopApi();
    if (api === undefined) {
      setError(t("revisionDiffUnavailable"));
      return;
    }
    void api
      .getContextStoreRevisionDiff({
        storeId: props.record.storeId,
        revision: props.record.revision,
      })
      .then((value) => {
        if (active) setSnapshots(value);
      })
      .catch(() => {
        if (active) setError(t("revisionDiffLoadFailed"));
      });
    return () => {
      active = false;
    };
  }, [props.record.storeId, props.record.revision, attempt, t]);
  const items = useMemo(
    () => (snapshots === undefined ? [] : snapshotDiffItems(snapshots)),
    [snapshots],
  );
  const selected = items.find((item) => `${item.kind}:${item.id}` === selectedKey) ?? items[0];
  const lines = useMemo(
    () => (selected === undefined ? [] : buildRevisionLineDiff(selected.before, selected.after)),
    [selected],
  );
  return (
    <StudioScreenFrame
      className="context-store-revision-detail"
      labelledBy="manual-revision-title"
      header={
        <header className="revision-diff-heading">
          <button className="back-link" type="button" onClick={props.onBack}>
            <ArrowLeft size={18} aria-hidden="true" />
            {t("backRevisionTasks")}
          </button>
          <div className="revision-diff-title-row">
            <div>
              <h1 id="manual-revision-title">{t("revisionSource.manual")}</h1>
              <p>
                {props.store?.name ?? t("unavailableKnowledgeBase")} ·{" "}
                {t("knowledgeRevisionNumber", { count: props.record.parentRevision })} →{" "}
                {t("knowledgeRevisionNumber", { count: props.record.revision })} ·{" "}
                {formatRevisionTimestamp(props.record.createdAt, i18n.language)}
              </p>
              <p>{props.record.summary}</p>
            </div>
          </div>
        </header>
      }
    >
      <div className="revision-diff-content">
        {error !== undefined ? (
          <div role="alert">
            <p className="form-error">{error}</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              {t("retryRevision")}
            </button>
          </div>
        ) : snapshots === undefined ? (
          <p role="status">{t("revisionLoadingDiff")}</p>
        ) : items.length === 0 ? (
          <p>{t("revisionNoChanges")}</p>
        ) : (
          <div className="revision-diff-workspace">
            <aside className="revision-diff-files" aria-label={t("revisionReviewContents")}>
              <div className="revision-diff-files-heading">{t("revisionReviewContents")}</div>
              <nav>
                {items.map((item) => (
                  <button
                    key={`${item.kind}:${item.id}`}
                    type="button"
                    className={item === selected ? "is-active" : undefined}
                    onClick={() => setSelectedKey(`${item.kind}:${item.id}`)}
                  >
                    <FileText size={17} aria-hidden="true" />
                    <span>
                      <strong>{item.id}</strong>
                      <small>
                        {t(`revisionDiffKind.${item.kind}`)} ·{" "}
                        {t(`revisionDiffOperation.${item.operation}`)}
                      </small>
                    </span>
                  </button>
                ))}
              </nav>
            </aside>
            <section className="revision-diff-view" aria-label={t("revisionDiff")}>
              <header>
                <div className="revision-diff-view-heading">
                  <FileText size={16} aria-hidden="true" />
                  <span>
                    <strong>{selected?.id}</strong>
                    <small>
                      {selected === undefined ? "" : t(`revisionDiffKind.${selected.kind}`)}
                    </small>
                  </span>
                </div>
                <span className="revision-diff-stats">
                  <b>+{lines.filter((line) => line.kind === "addition").length}</b>
                  <i>−{lines.filter((line) => line.kind === "deletion").length}</i>
                </span>
              </header>
              <div className="revision-diff-scroll-area">
                <RevisionDiffCode lines={lines} />
              </div>
            </section>
          </div>
        )}
      </div>
    </StudioScreenFrame>
  );
}
