import { ArrowsClockwise, GitBranchIcon, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { KnowledgeSyncOverview } from "../../../../shared/contracts/index.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

export function KnowledgeSyncSettingsFragment() {
  const { t } = useTranslation("settings");
  const [overview, setOverview] = useState<KnowledgeSyncOverview>();
  const [remote, setRemote] = useState("");
  const [branch, setBranch] = useState("");
  const [autoPush, setAutoPush] = useState(true);
  const [pushDeletions, setPushDeletions] = useState(false);
  const [initializationMode, setInitializationMode] = useState<"publish_local" | "restore_remote">(
    "publish_local",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeError = error ?? overview?.errorMessage;

  const applyOverview = (next: KnowledgeSyncOverview) => {
    setOverview(next);
    if (next.configuration !== undefined) {
      setRemote(next.configuration.remote);
      setBranch(next.configuration.branch ?? "");
      setAutoPush(next.configuration.autoPush);
      setPushDeletions(next.configuration.pushDeletions);
    }
  };

  useEffect(() => {
    void window.pragmaDesktop
      .getKnowledgeSyncOverview()
      .then(applyOverview)
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, []);

  const run = async (operation: () => Promise<KnowledgeSyncOverview | void>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await operation();
      applyOverview(next ?? (await window.pragmaDesktop.getKnowledgeSyncOverview()));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsScreenFrame
      id="knowledge-sync-panel"
      labelledBy="knowledge-sync-heading"
      header={
        <header className="panel-heading panel-heading-with-action knowledge-sync-heading">
          <div>
            <h2 id="knowledge-sync-heading">{t("knowledgeSync.title")}</h2>
            <p>{t("knowledgeSync.description")}</p>
          </div>
          {overview?.configured ? (
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => void run(() => window.pragmaDesktop.syncKnowledgeBases())}
            >
              <ArrowsClockwise size={17} /> {t("knowledgeSync.syncNow")}
            </button>
          ) : null}
        </header>
      }
    >
      <form
        className="knowledge-sync-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() =>
            window.pragmaDesktop.updateKnowledgeSyncConfiguration({
              remote,
              ...(branch.trim() === "" ? {} : { branch }),
              autoPush,
              pushDeletions,
              initializationMode,
            }),
          );
        }}
      >
        <label>
          <span>{t("knowledgeSync.remote")}</span>
          <input
            aria-describedby={activeError === undefined ? undefined : "knowledge-sync-error"}
            value={remote}
            disabled={busy}
            onChange={(event) => setRemote(event.target.value)}
            placeholder="git@github.com:organization/knowledge.git"
            required
          />
        </label>
        <label>
          <span>{t("knowledgeSync.branch")}</span>
          <input
            aria-describedby={activeError === undefined ? undefined : "knowledge-sync-error"}
            value={branch}
            disabled={busy}
            onChange={(event) => setBranch(event.target.value)}
            placeholder={t("knowledgeSync.defaultBranch")}
          />
        </label>
        <label>
          <span>{t("knowledgeSync.initializationMode")}</span>
          <SelectMenu<"publish_local" | "restore_remote">
            ariaLabel={t("knowledgeSync.initializationMode")}
            className="form-select"
            value={initializationMode}
            disabled={busy}
            options={[
              { value: "publish_local", label: t("knowledgeSync.initializeFromLocal") },
              { value: "restore_remote", label: t("knowledgeSync.initializeFromRemote") },
            ]}
            onChange={setInitializationMode}
          />
        </label>
        <label className="knowledge-sync-toggle">
          <input
            type="checkbox"
            checked={autoPush}
            disabled={busy}
            onChange={(event) => setAutoPush(event.target.checked)}
          />
          {t("knowledgeSync.autoPush")}
        </label>
        <label className="knowledge-sync-toggle">
          <input
            type="checkbox"
            checked={pushDeletions}
            disabled={busy}
            onChange={(event) => setPushDeletions(event.target.checked)}
          />
          {t("knowledgeSync.pushDeletions")}
        </label>
        {activeError !== undefined ? (
          <p className="form-error" id="knowledge-sync-error" role="alert">
            {activeError}
          </p>
        ) : null}
        <div className="knowledge-sync-actions">
          <button className="primary-button" type="submit" disabled={busy || remote.trim() === ""}>
            {busy ? t("knowledgeSync.saving") : t("knowledgeSync.saveAndSync")}
          </button>
          {overview?.configured ? (
            <button
              className="icon-button is-danger"
              type="button"
              aria-label={t("knowledgeSync.remove")}
              title={t("knowledgeSync.remove")}
              disabled={busy}
              onClick={() =>
                void run(() => window.pragmaDesktop.removeKnowledgeSyncConfiguration())
              }
            >
              <Trash size={17} aria-hidden="true" />
            </button>
          ) : null}
          {overview?.configured ? (
            <p>
              <GitBranchIcon size={16} />{" "}
              {(overview.resolvedBranch ?? branch) || t("knowledgeSync.defaultBranch")}
              {overview.revision ? ` · ${overview.revision.slice(0, 8)}` : ""}
            </p>
          ) : null}
        </div>
      </form>
      {(overview?.stores.filter((store) => store.status === "ignored_remote") ?? []).map(
        (store) => (
          <article className="knowledge-sync-card" key={store.storeId}>
            <div>
              <strong>{store.name}</strong>
              <small>{t("knowledgeSync.ignoredRemote")}</small>
            </div>
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  window.pragmaDesktop.restoreIgnoredRemoteKnowledgeBase({
                    storeId: store.storeId,
                  }),
                )
              }
            >
              {t("knowledgeSync.restore")}
            </button>
          </article>
        ),
      )}
    </SettingsScreenFrame>
  );
}
