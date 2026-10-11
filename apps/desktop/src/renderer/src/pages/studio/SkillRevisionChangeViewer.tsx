import { FileText, Plus, Trash } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  SkillRevisionReview,
  SkillRevisionReviewFile,
} from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { buildRevisionLineDiff, RevisionDiffCode } from "./ContextStoreRevisionFragment.tsx";

export type SkillRevisionFilePreview = Pick<SkillRevisionReviewFile, "path" | "before" | "after">;
type Selection = { kind: "summary" } | { kind: "request" } | { kind: "operation"; index: number };
export function SkillRevisionChangeViewer(props: {
  readonly operations: readonly (SkillRevisionReview["operations"][number] & {
    entryKind?: "file" | "directory";
  })[];
  readonly summary: string;
  readonly request?: string | undefined;
  readonly error?: string | undefined;
  readonly summaryError?: string | undefined;
  readonly loading?: boolean;
  readonly contentsLabel?: string;
  readonly summaryDescription?: string;
  readonly loadFile: (path: string) => Promise<SkillRevisionFilePreview>;
}) {
  const { t } = useTranslation("studio");
  const [selection, setSelection] = useState<Selection>({ kind: "summary" });
  const [fileReview, setFileReview] = useState<SkillRevisionFilePreview>();
  const [fileReviewError, setFileReviewError] = useState<string>();
  const operation = selection.kind === "operation" ? props.operations[selection.index] : undefined;
  useEffect(() => {
    let active = true;
    setFileReview(undefined);
    setFileReviewError(undefined);
    if (operation !== undefined && operation.entryKind !== "directory")
      void props
        .loadFile(operation.path)
        .then((value) => {
          if (active) setFileReview(value);
        })
        .catch((cause) => {
          if (active) setFileReviewError(errorMessage(cause));
        });
    return () => {
      active = false;
    };
  }, [props.loadFile, operation]);
  const previewUnavailable =
    fileReview !== undefined &&
    (fileReview.before?.content === null || fileReview.after?.content === null);
  const diff = useMemo(
    () =>
      fileReview === undefined || previewUnavailable
        ? []
        : buildRevisionLineDiff(fileReview.before?.content ?? "", fileReview.after?.content ?? ""),
    [fileReview, previewUnavailable],
  );
  const additions = diff.filter((line) => line.kind === "addition").length;
  const deletions = diff.filter((line) => line.kind === "deletion").length;
  return (
    <div className="revision-diff-content">
      <div className="revision-diff-workspace">
        <aside
          className="revision-diff-files"
          aria-label={props.contentsLabel ?? t("revisionReviewContents")}
        >
          <div className="revision-diff-files-heading">
            <span>{props.contentsLabel ?? t("revisionReviewContents")}</span>
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
            {props.request === undefined ? null : (
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
            )}
            <div className="revision-diff-file-group-label">
              {t("skillEntriesChanged", { count: props.operations.length })}
            </div>
            {props.operations.map((candidate, index) => (
              <button
                className={
                  selection.kind === "operation" && selection.index === index
                    ? "is-active"
                    : undefined
                }
                type="button"
                key={`${candidate.operation}:${candidate.path}`}
                onClick={() => setSelection({ kind: "operation", index })}
              >
                {candidate.operation === "deleted" ? (
                  <Trash size={15} aria-hidden="true" />
                ) : candidate.operation === "added" ? (
                  <Plus size={15} aria-hidden="true" />
                ) : (
                  <FileText size={15} aria-hidden="true" />
                )}
                <span>
                  <strong>{candidate.path}</strong>
                  <small>{t(`skillRevisionOperation.${candidate.operation}`)}</small>
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
                      : (operation?.path ?? "")}
                </strong>
                {selection.kind === "request" ? (
                  <small>{t("skillRevisionRequestDocumentDescription")}</small>
                ) : selection.kind === "summary" ? (
                  <small>
                    {props.summaryDescription ?? t("skillRevisionSummaryDocumentDescription")}
                  </small>
                ) : null}
              </span>
            </div>
            {operation === undefined ? null : (
              <div className="skill-revision-file-stats">
                {fileReview ? (
                  <span className="skill-revision-file-metadata">
                    {formatSkillFileMetadata(fileReview, t)}
                  </span>
                ) : null}
                <span className="revision-diff-stats">
                  <b>+{additions}</b>
                  <i>−{deletions}</i>
                </span>
              </div>
            )}
          </header>
          <div className="revision-diff-scroll-area">
            {selection.kind === "request" ? (
              <article className="revision-review-document">
                <p>{props.request}</p>
              </article>
            ) : selection.kind === "summary" ? (
              <article className="revision-review-document">
                <p>{props.summary}</p>
                {props.summaryError ? <p className="form-error">{props.summaryError}</p> : null}
              </article>
            ) : operation === undefined ? (
              <div className="revision-diff-unavailable">
                <p>
                  {props.loading === true
                    ? t("loadingSkillRevisions")
                    : t("revisionDiffUnavailable")}
                </p>
              </div>
            ) : operation.entryKind === "directory" ? (
              <article className="revision-review-document">
                <p>
                  {t(
                    operation.operation === "added"
                      ? "skillRevisionFolderAdded"
                      : "skillRevisionFolderDeleted",
                    { path: operation.path },
                  )}
                </p>
              </article>
            ) : fileReviewError ? (
              <div className="revision-diff-unavailable">
                <p>{fileReviewError}</p>
              </div>
            ) : fileReview === undefined ? (
              <div className="revision-diff-unavailable">
                <p>{t("loadingSkillRevisionFile")}</p>
              </div>
            ) : previewUnavailable ? (
              <div className="revision-diff-unavailable">
                <p>{skillFileUnavailableMessage(fileReview, t)}</p>
              </div>
            ) : (
              <RevisionDiffCode lines={diff} />
            )}
          </div>
        </section>
      </div>
      {props.error ? (
        <p className="form-error" role="alert">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

export function formatSkillFileMetadata(
  review: SkillRevisionFilePreview,
  t: TFunction<"studio">,
): string {
  const formatSnapshot = (snapshot: SkillRevisionReviewFile["before"]): string =>
    snapshot === null
      ? t("skillRevisionFileMissing")
      : t("skillRevisionFileMetadata", {
          size: formatBytes(snapshot.sizeBytes),
          hash: snapshot.sha256.slice(0, 8),
          mode: t(snapshot.executable ? "skillRevisionExecutable" : "skillRevisionNotExecutable"),
        });
  return t("skillRevisionFileTransition", {
    before: formatSnapshot(review.before),
    after: formatSnapshot(review.after),
  });
}

function skillFileUnavailableMessage(
  review: SkillRevisionFilePreview,
  t: TFunction<"studio">,
): string {
  const unavailable = [review.before, review.after].find((snapshot) => snapshot?.content === null);
  return t(`skillRevisionPreviewUnavailable.${unavailable?.unavailableReason ?? "binary"}`, {
    size: formatBytes(unavailable?.sizeBytes ?? 0),
    hash: unavailable?.sha256.slice(0, 8) ?? "",
  });
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
