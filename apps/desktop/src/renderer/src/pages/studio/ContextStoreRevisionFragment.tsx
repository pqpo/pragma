import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  Check,
  ClockCounterClockwise,
  FileText,
  FunnelSimple,
  PencilSimple,
  Plus,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ContextStore, ContextStoreRevisionJob } from "../../../../shared/contracts/index.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

type RevisionOperation = NonNullable<ContextStoreRevisionJob["changeSet"]>["operations"][number];
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
  readonly onBack: () => void;
}) {
  const { t, i18n } = useTranslation("studio");
  const [storeId, setStoreId] = useState(props.initialStoreId ?? "");
  const [jobs, setJobs] = useState<readonly ContextStoreRevisionJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    try {
      const [next, allJobs] = await Promise.all([
        api.listContextStoreRevisions(storeId === "" ? {} : { storeId }),
        storeId === "" ? undefined : api.listContextStoreRevisions(),
      ]);
      setJobs(next);
      props.onCountChanged?.(
        (allJobs ?? next).filter(
          (job) => !["completed", "rejected", "superseded"].includes(job.state),
        ).length,
      );
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  useEffect(() => {
    setStoreId(props.initialStoreId ?? "");
  }, [props.initialStoreId]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
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
      if (action === "delete") setSelectedJobId(null);
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const selectedJob = jobs.find((job) => job.id === selectedJobId);
  if (selectedJob !== undefined && selectedJob.changeSet !== undefined) {
    return (
      <ContextStoreRevisionDiffFragment
        job={{ ...selectedJob, changeSet: selectedJob.changeSet }}
        store={props.stores.find((store) => store.id === selectedJob.request.storeId)}
        busy={busy === selectedJob.id}
        error={error}
        onBack={() => setSelectedJobId(null)}
        onApprove={() => void act(selectedJob, "approve")}
        onReject={() => void act(selectedJob, "reject")}
        onRetry={() => void act(selectedJob, "retry")}
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
                {t("revisionTaskCount", { count: jobs.length })}
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
        {jobs.length === 0 ? (
          <div className="revision-task-empty">
            <ClockCounterClockwise size={28} aria-hidden="true" />
            <h3>{t("noStoreRevisionTasks")}</h3>
            <p>{t("noStoreRevisionTasksDescription")}</p>
          </div>
        ) : (
          <div className="revision-task-table">
            <div className="revision-task-list-header" aria-hidden="true">
              <span>{t("revisionTaskColumn")}</span>
              <span>{t("status")}</span>
              <span>{t("revisionUpdatedAt")}</span>
              <span>{t("actions")}</span>
            </div>
            <div className="revision-task-list" role="list">
              {jobs.map((job) => {
                const store = props.stores.find(
                  (candidate) => candidate.id === job.request.storeId,
                );
                const hasChanges = job.changeSet !== undefined;
                return (
                  <article className="revision-task-row" role="listitem" key={job.id}>
                    <button
                      className="revision-task-open"
                      type="button"
                      disabled={!hasChanges}
                      aria-label={hasChanges ? t("viewRevisionChanges") : undefined}
                      onClick={() => hasChanges && setSelectedJobId(job.id)}
                    >
                      <span className="revision-task-summary">
                        <strong title={job.request.prompt}>{job.request.prompt}</strong>
                        <small title={store?.name ?? job.request.storeId}>
                          {store?.name ?? job.request.storeId}
                        </small>
                      </span>
                      <span className="revision-task-result">
                        <span
                          className={`revision-task-state is-${job.state}`}
                          title={t(`revisionState.${job.state}`)}
                        >
                          {t(`revisionState.${job.state}`)}
                        </span>
                        {job.error !== undefined ? (
                          <span className="form-error" role="alert" title={job.error.message}>
                            {job.error.message}
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
                    <div className="revision-task-actions">
                      {hasChanges ? (
                        <button
                          className="revision-task-view"
                          type="button"
                          onClick={() => setSelectedJobId(job.id)}
                        >
                          {t("viewRevisionChanges")}
                          <ArrowRight size={14} aria-hidden="true" />
                        </button>
                      ) : null}
                      {job.state === "needs_attention" || job.state === "rejected" ? (
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={busy === job.id}
                          onClick={() => void act(job, "retry")}
                        >
                          <ArrowClockwise size={15} /> {t("retryRevision")}
                        </button>
                      ) : null}
                      {["completed", "rejected", "superseded"].includes(job.state) ? (
                        <button
                          className="revision-task-delete"
                          type="button"
                          aria-label={t("deleteRevisionTask")}
                          title={t("deleteRevisionTask")}
                          disabled={busy === job.id}
                          onClick={() => void act(job, "delete")}
                        >
                          <Trash size={15} aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        )}
        {error !== null ? <p className="form-error">{error}</p> : null}
      </div>
    </StudioScreenFrame>
  );
}

export function ContextStoreRevisionDiffFragment(props: {
  readonly job: ContextStoreRevisionJob & {
    readonly changeSet: NonNullable<ContextStoreRevisionJob["changeSet"]>;
  };
  readonly store?: ContextStore | undefined;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onBack: () => void;
  readonly onApprove: () => void;
  readonly onReject: () => void;
  readonly onRetry: () => void;
}) {
  const { t, i18n } = useTranslation("studio");
  const [selection, setSelection] = useState<RevisionDiffSelection>({ kind: "summary" });
  const operation =
    selection.kind === "operation"
      ? (props.job.changeSet.operations[selection.index] ?? props.job.changeSet.operations[0])
      : undefined;
  const diff = useMemo(
    () => (operation === undefined ? [] : operationDiff(operation)),
    [operation],
  );
  const additions = diff.filter((line) => line.kind === "addition").length;
  const deletions = diff.filter((line) => line.kind === "deletion").length;
  const revisionMetadata = `${props.store?.name ?? props.job.request.storeId} · ${t(
    "baseRevision",
    {
      count: props.job.changeSet.baseRevision,
    },
  )} · ${formatRevisionTimestamp(props.job.updatedAt, i18n.language)}`;

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
            </div>
            <div className="revision-diff-actions">
              <span className={`revision-task-state is-${props.job.state}`}>
                {t(`revisionState.${props.job.state}`)}
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
              {props.job.state === "needs_attention" || props.job.state === "rejected" ? (
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
            </div>
          </div>
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
                {t("filesChanged", { count: props.job.changeSet.operations.length })}
              </div>
              {props.job.changeSet.operations.map((candidate, index) => (
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
              {operation === undefined || operation.operation === "rename" ? null : (
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
                  <p>{props.job.changeSet.summary}</p>
                </article>
              ) : operation === undefined ? null : operation.operation === "rename" ? (
                <div className="revision-rename-preview">
                  <span>{operation.id}</span>
                  <ArrowRight size={18} aria-hidden="true" />
                  <strong>{operation.nextId}</strong>
                </div>
              ) : operation.operation === "delete" && operation.previousContent === undefined ? (
                <div className="revision-diff-unavailable">
                  <p>{t("revisionDiffUnavailable")}</p>
                </div>
              ) : (
                <div className="revision-diff-code" role="table">
                  {diff.map((line, index) => (
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
  if (operation.operation === "rename") return [];
  if (operation.operation === "delete") {
    return buildRevisionLineDiff(operation.previousContent ?? "", "");
  }
  return buildRevisionLineDiff(operation.previousContent ?? "", operation.content);
}

function operationPath(operation: RevisionOperation): string {
  return operation.operation === "rename" ? operation.nextId : operation.id;
}

function operationIcon(operation: RevisionOperation) {
  if (operation.operation === "delete") return <Trash size={15} aria-hidden="true" />;
  if (operation.operation === "rename") return <PencilSimple size={15} aria-hidden="true" />;
  if (operation.previousContent === undefined) return <Plus size={15} aria-hidden="true" />;
  return <FileText size={15} aria-hidden="true" />;
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
