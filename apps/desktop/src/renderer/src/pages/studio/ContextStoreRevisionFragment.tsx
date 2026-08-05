import { ArrowClockwise, Check, Trash, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  ContextStore,
  ContextStoreRevisionJob,
  ContextStoreRevisionProfile,
  DesktopRuntimeAvailability,
} from "../../../../shared/contracts/index.ts";
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
  const [profile, setProfile] = useState<ContextStoreRevisionProfile>();
  const [runtimes, setRuntimes] = useState<readonly DesktopRuntimeAvailability[]>([]);
  const [runtimeId, setRuntimeId] = useState("");
  const [modelKey, setModelKey] = useState("");
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
    const api = desktopApi();
    if (api === undefined) return;
    let cancelled = false;
    void Promise.all([api.getContextStoreRevisionProfile(), api.getRuntimeAvailability()])
      .then(([nextProfile, nextRuntimes]) => {
        if (cancelled) return;
        setProfile(nextProfile);
        setRuntimes(nextRuntimes);
        setRuntimeId(
          nextProfile.model?.runtimeId ??
            nextRuntimes.find((runtime) => runtime.isDefault)?.id ??
            "",
        );
        setModelKey(
          nextProfile.model === undefined
            ? ""
            : `${nextProfile.model.providerId}\0${nextProfile.model.modelId}`,
        );
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);
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

  const saveProfile = async (mode: "inherit-default" | "pinned") => {
    const api = desktopApi();
    if (api === undefined || profile === undefined) return;
    setBusy("profile");
    try {
      if (mode === "inherit-default") {
        setProfile(
          await api.updateContextStoreRevisionProfile({
            expectedRevision: profile.revision,
            mode,
          }),
        );
      } else {
        const [providerId, modelId] = modelKey.split("\0");
        if (runtimeId === "" || providerId === undefined || modelId === undefined) return;
        setProfile(
          await api.updateContextStoreRevisionProfile({
            expectedRevision: profile.revision,
            mode,
            model: { runtimeId, providerId, modelId },
          }),
        );
      }
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const selectedRuntime = runtimes.find((runtime) => runtime.id === runtimeId);

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
      labelledBy="context-store-revisions-title"
      header={
        <div>
          <h1 id="context-store-revisions-title">{t("contextStoreRevisions")}</h1>
          <p>{t("contextStoreRevisionsDescription")}</p>
        </div>
      }
    >
      <div className="store-directory">
        <section>
          <h2>{t("revisionAgentProfile")}</h2>
          <p>{t("revisionAgentProfileDescription")}</p>
          <label>
            <span>{t("revisionAgentMode")}</span>
            <SelectMenu
              ariaLabel={t("revisionAgentMode")}
              value={profile?.mode ?? "inherit-default"}
              disabled={profile === undefined || busy === "profile"}
              options={[
                { value: "inherit-default", label: t("revisionAgentInherit") },
                { value: "pinned", label: t("revisionAgentPinned") },
              ]}
              onChange={(mode) => {
                if (mode === "inherit-default") void saveProfile(mode);
                else
                  setProfile((current) =>
                    current === undefined ? current : { ...current, mode: "pinned" },
                  );
              }}
            />
          </label>
          {profile?.mode !== "pinned" ? null : (
            <>
              <label>
                <span>{t("revisionAgentRuntime")}</span>
                <SelectMenu
                  ariaLabel={t("revisionAgentRuntime")}
                  value={runtimeId}
                  options={runtimes
                    .filter((runtime) => runtime.status === "available")
                    .map((runtime) => ({ value: runtime.id, label: runtime.displayName }))}
                  onChange={(value) => {
                    setRuntimeId(value);
                    setModelKey("");
                  }}
                />
              </label>
              <label>
                <span>{t("revisionAgentModel")}</span>
                <SelectMenu
                  ariaLabel={t("revisionAgentModel")}
                  value={modelKey}
                  emptyLabel={t("revisionAgentChooseModel")}
                  options={[
                    {
                      value: "",
                      label: t("revisionAgentChooseModel"),
                      disabled: true,
                    },
                    ...(selectedRuntime?.models ?? []).map((model) => ({
                      value: `${model.provider.id}\0${model.id}`,
                      label: `${model.provider.displayName} · ${model.displayName}`,
                    })),
                  ]}
                  onChange={setModelKey}
                />
              </label>
              <button
                type="button"
                disabled={busy === "profile" || runtimeId === "" || modelKey === ""}
                onClick={() => void saveProfile("pinned")}
              >
                {t("revisionAgentSave")}
              </button>
            </>
          )}
        </section>
        <label>
          <span>{t("revisionStoreFilter")}</span>
          <SelectMenu
            ariaLabel={t("revisionStoreFilter")}
            value={storeId}
            options={[
              { value: "", label: t("allKnowledgeBases") },
              ...props.stores.map((store) => ({ value: store.id, label: store.name })),
            ]}
            onChange={setStoreId}
          />
        </label>
        <label>
          <span>{t("revisionPrompt")}</span>
          <textarea
            value={prompt}
            maxLength={50_000}
            placeholder={t("revisionPromptPlaceholder")}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={storeId === "" || prompt.trim() === "" || busy === "submit"}
          onClick={() => void submitRevision()}
        >
          {t("submitRevisionTask")}
        </button>
        {jobs.length === 0 ? <p>{t("noStoreRevisionTasks")}</p> : null}
        <div className="store-table" role="list">
          {jobs.map((job) => {
            const store = props.stores.find((candidate) => candidate.id === job.request.storeId);
            return (
              <article className="store-row" role="listitem" key={job.id}>
                <div className="store-column-name">
                  <strong>{store?.name ?? job.request.storeId}</strong>
                  <small>{job.request.prompt}</small>
                </div>
                <div>
                  <span>{t(`revisionState.${job.state}`)}</span>
                  {job.changeSet !== undefined ? (
                    <details>
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
                  {job.error !== undefined ? <p role="alert">{job.error.message}</p> : null}
                </div>
                <div className="directory-actions">
                  {job.state === "pending_review" ? (
                    <>
                      <button disabled={busy === job.id} onClick={() => void act(job, "approve")}>
                        <Check size={16} /> {t("approveRevision")}
                      </button>
                      <button disabled={busy === job.id} onClick={() => void act(job, "reject")}>
                        <X size={16} /> {t("rejectRevision")}
                      </button>
                    </>
                  ) : null}
                  {job.state === "needs_attention" || job.state === "rejected" ? (
                    <button disabled={busy === job.id} onClick={() => void act(job, "retry")}>
                      <ArrowClockwise size={16} /> {t("retryRevision")}
                    </button>
                  ) : null}
                  {["completed", "rejected", "superseded"].includes(job.state) ? (
                    <button disabled={busy === job.id} onClick={() => void act(job, "delete")}>
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
