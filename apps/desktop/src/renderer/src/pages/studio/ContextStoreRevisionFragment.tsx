import { ArrowClockwise, Check, ClockCounterClockwise, Trash, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ContextStore, ContextStoreRevisionJob } from "../../../../shared/contracts/index.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

export function ContextStoreRevisionFragment(props: {
  readonly stores: readonly ContextStore[];
  readonly initialStoreId?: string | undefined;
  readonly onCountChanged?: ((count: number) => void) | undefined;
}) {
  const { t } = useTranslation("studio");
  const [storeId, setStoreId] = useState(props.initialStoreId ?? "");
  const [jobs, setJobs] = useState<readonly ContextStoreRevisionJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");

  const load = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    try {
      const next = await api.listContextStoreRevisions(storeId === "" ? {} : { storeId });
      setJobs(next);
      props.onCountChanged?.(
        next.filter((job) => !["completed", "rejected", "superseded"].includes(job.state)).length,
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
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const submitRevision = async () => {
    const api = desktopApi();
    if (api === undefined || storeId === "" || prompt.trim() === "") return;
    setBusy("submit");
    try {
      await api.submitContextStoreRevision({
        schemaVersion: "pragma.context-store-revision-request/v1",
        storeId,
        prompt,
        source: "user",
      });
      setPrompt("");
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <StudioScreenFrame
      className="context-store-revisions"
      labelledBy="context-store-revisions-title"
      header={
        <header className="studio-heading revision-task-heading">
          <div>
            <h1 id="context-store-revisions-title">{t("contextStoreRevisions")}</h1>
            <p>{t("contextStoreRevisionsDescription")}</p>
          </div>
          <span className="revision-task-count">{jobs.length}</span>
        </header>
      }
    >
      <div className="revision-task-content">
        <form
          className="revision-task-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submitRevision();
          }}
        >
          <div className="revision-task-composer-heading">
            <ClockCounterClockwise size={20} aria-hidden="true" />
            <div>
              <h2>{t("newRevisionTask")}</h2>
              <p>{t("newRevisionTaskDescription")}</p>
            </div>
          </div>
          <div className="revision-task-fields">
            <label className="revision-task-field revision-task-store-field">
              <span>{t("revisionStoreFilter")}</span>
              <SelectMenu
                className="revision-task-select"
                ariaLabel={t("revisionStoreFilter")}
                value={storeId}
                options={[
                  { value: "", label: t("allKnowledgeBases") },
                  ...props.stores.map((store) => ({ value: store.id, label: store.name })),
                ]}
                onChange={setStoreId}
              />
            </label>
            <label className="revision-task-field revision-task-prompt-field">
              <span>{t("revisionPrompt")}</span>
              <textarea
                value={prompt}
                maxLength={50_000}
                placeholder={t("revisionPromptPlaceholder")}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            <button
              className="primary-button revision-task-submit"
              type="submit"
              disabled={storeId === "" || prompt.trim() === "" || busy === "submit"}
            >
              {t("submitRevisionTask")}
            </button>
          </div>
        </form>

        {jobs.length === 0 ? (
          <div className="revision-task-empty">
            <ClockCounterClockwise size={28} aria-hidden="true" />
            <h3>{t("noStoreRevisionTasks")}</h3>
            <p>{t("noStoreRevisionTasksDescription")}</p>
          </div>
        ) : null}
        <div className="revision-task-list" role="list">
          {jobs.map((job) => {
            const store = props.stores.find((candidate) => candidate.id === job.request.storeId);
            return (
              <article className="revision-task-row" role="listitem" key={job.id}>
                <div className="revision-task-summary">
                  <strong>{store?.name ?? job.request.storeId}</strong>
                  <small>{job.request.prompt}</small>
                </div>
                <div className="revision-task-result">
                  <span className={`revision-task-state is-${job.state}`}>
                    {t(`revisionState.${job.state}`)}
                  </span>
                  {job.changeSet !== undefined ? (
                    <details className="revision-task-changes">
                      <summary>{job.changeSet.summary}</summary>
                      <ul>
                        {job.changeSet.operations.map((operation, index) => (
                          <li key={`${operation.operation}:${operation.id}:${index}`}>
                            {operation.operation} · {operation.id}
                            {operation.operation === "rename" ? ` → ${operation.nextId}` : null}
                            {operation.operation === "upsert" ? (
                              <pre>{operation.content}</pre>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {job.error !== undefined ? (
                    <p className="form-error" role="alert">
                      {job.error.message}
                    </p>
                  ) : null}
                </div>
                <div className="revision-task-actions">
                  {job.state === "pending_review" ? (
                    <>
                      <button
                        className="primary-button"
                        type="button"
                        disabled={busy === job.id}
                        onClick={() => void act(job, "approve")}
                      >
                        <Check size={16} /> {t("approveRevision")}
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={busy === job.id}
                        onClick={() => void act(job, "reject")}
                      >
                        <X size={16} /> {t("rejectRevision")}
                      </button>
                    </>
                  ) : null}
                  {job.state === "needs_attention" || job.state === "rejected" ? (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busy === job.id}
                      onClick={() => void act(job, "retry")}
                    >
                      <ArrowClockwise size={16} /> {t("retryRevision")}
                    </button>
                  ) : null}
                  {["completed", "rejected", "superseded"].includes(job.state) ? (
                    <button
                      className="danger-button"
                      type="button"
                      disabled={busy === job.id}
                      onClick={() => void act(job, "delete")}
                    >
                      <Trash size={16} /> {t("deleteRevisionTask")}
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
        {error !== null ? <p className="form-error">{error}</p> : null}
      </div>
    </StudioScreenFrame>
  );
}
