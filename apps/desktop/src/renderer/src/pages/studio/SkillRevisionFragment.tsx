import { ArrowLeft, Check, ClockCounterClockwise, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ManagedSkillRevisionJob,
  SkillRevisionDraft,
} from "@pragma/built-in-agents/contracts";

import type { Capability } from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

type Entry = { readonly job: ManagedSkillRevisionJob; readonly draft: SkillRevisionDraft };

export function activeSkillRevisionTaskCount(
  entries: readonly { readonly job: Pick<ManagedSkillRevisionJob, "state"> }[],
): number {
  return entries.filter(({ job }) => !["completed", "rejected", "superseded"].includes(job.state))
    .length;
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

export function SkillRevisionFragment(props: {
  readonly capabilities: readonly Capability[];
  readonly capabilityId?: string | undefined;
  readonly onCountChanged?: ((count: number) => void) | undefined;
  readonly onPublished?: (() => Promise<void>) | undefined;
  readonly onBack: () => void;
}) {
  const { t } = useTranslation("studio");
  const [entries, setEntries] = useState<readonly Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
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

  const act = async (entry: Entry, action: "approve" | "reject" | "retry") => {
    const api = desktopApi();
    if (api === undefined) return;
    setBusyId(entry.job.id);
    try {
      const input = { jobId: entry.job.id, expectedRevision: entry.job.revision };
      if (action === "approve") await api.approveSkillRevision(input);
      else if (action === "reject") await api.rejectSkillRevision(input);
      else await api.retrySkillRevision(input);
      if (action === "approve") await props.onPublished?.();
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <StudioScreenFrame
      className="knowledge-revision-page skill-revision-page"
      labelledBy="skill-revisions-heading"
      header={
        <button className="back-link" type="button" onClick={props.onBack}>
          <ArrowLeft size={18} aria-hidden="true" /> {t("backCapabilities")}
        </button>
      }
    >
      <header className="studio-heading">
        <div>
          <h1 id="skill-revisions-heading">{t("skillRevisions")}</h1>
          <p>{t("skillRevisionsDescription")}</p>
        </div>
      </header>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? <p className="directory-empty">{t("loadingSkillRevisions")}</p> : null}
      {!loading && entries.length === 0 ? <SkillRevisionEmptyState /> : null}
      {entries.length > 0 ? (
        <div className="capability-table" role="list" aria-label={t("skillRevisions")}>
          {entries.map((entry) => {
            const capability = props.capabilities.find(
              (item) => item.manifest.id === entry.draft.capabilityId,
            );
            return (
              <article className="skill-revision-row" role="listitem" key={entry.job.id}>
                <div className="skill-revision-main">
                  <strong>{capability?.manifest.name ?? entry.draft.name}</strong>
                  {entry.draft.operation === "create" ? (
                    <small>{t("newSkillRevision")}</small>
                  ) : null}
                  <small>{entry.job.request.prompt}</small>
                </div>
                <div className="skill-revision-meta">
                  <span className="version-label">
                    {entry.draft.operation === "create"
                      ? t("publishesAsRevisionOne")
                      : t("baseRevision", { count: entry.draft.baseRevision })}
                  </span>
                  <span className={`capability-status is-${entry.job.state}`}>
                    {entry.job.state}
                  </span>
                </div>
                {entry.draft.summary ? (
                  <p className="skill-revision-summary">{entry.draft.summary}</p>
                ) : null}
                <div className="skill-revision-actions">
                  {entry.job.state === "pending_review" ? (
                    <>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={busyId === entry.job.id}
                        onClick={() => void act(entry, "reject")}
                      >
                        <X size={16} /> {t("rejectRevision")}
                      </button>
                      <button
                        className="primary-button"
                        type="button"
                        disabled={busyId === entry.job.id}
                        onClick={() => void act(entry, "approve")}
                      >
                        <Check size={16} /> {t("approveAndPublish")}
                      </button>
                    </>
                  ) : null}
                  {entry.job.state === "needs_attention" ? (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busyId === entry.job.id}
                      onClick={() => void act(entry, "retry")}
                    >
                      <ClockCounterClockwise size={16} /> {t("retryRevision")}
                    </button>
                  ) : null}
                </div>
                {entry.job.error ? (
                  <p className="form-error skill-revision-error">
                    <strong>{entry.job.error.code}</strong> {entry.job.error.message}
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </StudioScreenFrame>
  );
}
