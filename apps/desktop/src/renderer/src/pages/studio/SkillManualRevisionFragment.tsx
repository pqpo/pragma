import { ArrowLeft } from "@phosphor-icons/react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { Capability, SkillManualRevisionRecord } from "../../../../shared/contracts/index.ts";
import { SkillRevisionChangeViewer } from "./SkillRevisionChangeViewer.tsx";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

export function skillManualRevisionSummary(
  record: SkillManualRevisionRecord,
  t: TFunction<"studio">,
): string {
  return t("skillManualRevisionSummary", {
    added: record.operations.filter((operation) => operation.operation === "added").length,
    modified: record.operations.filter((operation) => operation.operation === "modified").length,
    deleted: record.operations.filter((operation) => operation.operation === "deleted").length,
  });
}

export function SkillManualRevisionRow(props: {
  readonly record: SkillManualRevisionRecord;
  readonly capability: Capability | undefined;
  readonly onOpen: () => void;
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
          <strong>{skillManualRevisionSummary(props.record, t)}</strong>
          <small>
            {props.capability?.manifest.name ?? props.record.name} ·{" "}
            {t("knowledgeRevisionNumber", { count: props.record.revision })}
          </small>
        </span>
        <span className="revision-task-result">
          <span className="revision-task-state is-manual">{t("skillManualRevisionTitle")}</span>
        </span>
        <time
          className="revision-task-updated"
          dateTime={props.record.createdAt}
          title={new Intl.DateTimeFormat(i18n.language, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(props.record.createdAt))}
        >
          {new Intl.DateTimeFormat(i18n.language, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(props.record.createdAt))}
        </time>
      </button>
      <div className="revision-task-actions" />
    </article>
  );
}

export function SkillManualRevisionDetailFragment(props: {
  readonly record: SkillManualRevisionRecord;
  readonly capability: Capability | undefined;
  readonly onBack: () => void;
}) {
  const { t, i18n } = useTranslation("studio");
  const { record } = props;
  const loadFile = useCallback(
    async (path: string) => {
      const api = desktopApi();
      if (api === undefined) throw new Error(t("revisionDiffUnavailable"));
      return await api.getSkillManualRevisionFile({
        capabilityId: record.capabilityId,
        revision: record.revision,
        path,
      });
    },
    [record.capabilityId, record.revision, t],
  );
  return (
    <StudioScreenFrame
      className="context-store-revision-detail skill-revision-detail"
      labelledBy="skill-manual-revision-title"
      header={
        <header className="revision-diff-heading">
          <button className="back-link" type="button" onClick={props.onBack}>
            <ArrowLeft size={18} />
            {t("backSkillRevisionHistory")}
          </button>
          <div className="revision-diff-title-row">
            <div>
              <h1 id="skill-manual-revision-title">{t("skillManualRevisionTitle")}</h1>
              <p>
                {props.capability?.manifest.name ?? record.name} ·{" "}
                {t("knowledgeRevisionNumber", { count: record.baseRevision })} →{" "}
                {t("knowledgeRevisionNumber", { count: record.revision })} ·{" "}
                {new Intl.DateTimeFormat(i18n.language, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(record.createdAt))}
              </p>
            </div>
            <span className="revision-task-state is-completed">{t("saved")}</span>
          </div>
        </header>
      }
    >
      <SkillRevisionChangeViewer
        operations={record.operations}
        contentsLabel={t("skillManualRevisionContents")}
        summaryDescription={t("skillManualRevisionSummaryDescription")}
        summary={skillManualRevisionSummary(record, t)}
        loadFile={loadFile}
      />
    </StudioScreenFrame>
  );
}
