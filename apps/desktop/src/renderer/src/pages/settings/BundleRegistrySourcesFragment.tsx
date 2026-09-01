import { ArrowsClockwise, GitBranch, Plus, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DesktopBundleRegistrySourceStatus } from "../../../../shared/contracts/index.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { desktopApi } from "../studio/studio-model.ts";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

export function BundleRegistrySourcesFragment() {
  const { t } = useTranslation("settings");
  const [sources, setSources] = useState<readonly DesktopBundleRegistrySourceStatus[]>([]);
  const [name, setName] = useState("");
  const [remote, setRemote] = useState("");
  const [ref, setRef] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    setSources(await api.listBundleRegistrySources());
  };

  useEffect(() => {
    void reload().catch((cause: unknown) => setError(errorMessage(cause)));
  }, []);

  const addSource = async () => {
    const api = desktopApi();
    if (api === undefined || name.trim() === "" || remote.trim() === "") return;
    setAdding(true);
    setAddError(null);
    try {
      await api.addBundleRegistrySource({
        name,
        remote,
        ...(ref.trim() === "" ? {} : { ref }),
      });
      setName("");
      setRemote("");
      setRef("");
      await reload();
      setAddDialogOpen(false);
    } catch (cause) {
      setAddError(errorMessage(cause));
    } finally {
      setAdding(false);
    }
  };

  const mutate = async (sourceId: string, operation: () => Promise<unknown>) => {
    setBusyId(sourceId);
    setError(null);
    try {
      await operation();
      await reload();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  };

  const closeAddDialog = () => {
    setAddDialogOpen(false);
    setAddError(null);
    setName("");
    setRemote("");
    setRef("");
  };

  return (
    <SettingsScreenFrame
      id="bundle-sources-panel"
      labelledBy="bundle-sources-heading"
      className="bundle-registry-settings"
      header={
        <header className="bundle-source-heading">
          <div>
            <h1 id="bundle-sources-heading">{t("bundleSources.title")}</h1>
            <p>{t("bundleSources.description")}</p>
          </div>
          <button
            className="primary-button"
            type="button"
            onClick={() => {
              setAddError(null);
              setAddDialogOpen(true);
            }}
          >
            <Plus size={17} /> {t("bundleSources.add")}
          </button>
        </header>
      }
    >
      {error ? <p className="form-error">{error}</p> : null}
      <div className="bundle-source-list">
        {sources.length === 0 ? (
          <div className="bundle-source-empty">
            <GitBranch size={28} />
            <strong>{t("bundleSources.empty")}</strong>
            <p>{t("bundleSources.emptyDescription")}</p>
          </div>
        ) : (
          sources.map((source) => (
            <article className="bundle-source-card" key={source.id}>
              <div>
                <div className="bundle-source-title">
                  <strong>{source.name}</strong>
                  {source.official ? <span>{t("bundleSources.official")}</span> : null}
                  <span className={`bundle-source-status is-${source.status}`}>
                    {t(`bundleSources.status.${source.status}`)}
                  </span>
                </div>
                <code>{source.remote}</code>
                <small>
                  {source.commit === undefined
                    ? t("bundleSources.notSynced")
                    : t("bundleSources.synced", {
                        count: source.itemCount ?? 0,
                        commit: source.commit.slice(0, 8),
                      })}
                </small>
                {source.errorMessage ? <p className="form-error">{source.errorMessage}</p> : null}
              </div>
              <div className="bundle-source-actions">
                <label>
                  <input
                    type="checkbox"
                    checked={source.enabled}
                    disabled={busyId === source.id}
                    onChange={(event) =>
                      void mutate(source.id, () =>
                        window.pragmaDesktop.updateBundleRegistrySource({
                          sourceId: source.id,
                          enabled: event.target.checked,
                        }),
                      )
                    }
                  />
                  {t("bundleSources.enabled")}
                </label>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busyId === source.id}
                  onClick={() =>
                    void mutate(source.id, () =>
                      window.pragmaDesktop.refreshBundleRegistrySource({ sourceId: source.id }),
                    )
                  }
                >
                  <ArrowsClockwise size={16} /> {t("bundleSources.refresh")}
                </button>
                {!source.official ? (
                  <button
                    className="icon-button danger"
                    type="button"
                    aria-label={t("bundleSources.remove", { name: source.name })}
                    disabled={busyId === source.id}
                    onClick={() =>
                      void mutate(source.id, () =>
                        window.pragmaDesktop.removeBundleRegistrySource({ sourceId: source.id }),
                      )
                    }
                  >
                    <Trash size={17} />
                  </button>
                ) : null}
              </div>
            </article>
          ))
        )}
      </div>
      {addDialogOpen ? (
        <Dialog
          className="bundle-source-dialog"
          title={t("bundleSources.addTitle")}
          description={t("bundleSources.addDescription")}
          busy={adding}
          onCancel={closeAddDialog}
          footer={
            <>
              <button
                className="secondary-button"
                type="button"
                disabled={adding}
                onClick={closeAddDialog}
              >
                {t("bundleSources.cancel")}
              </button>
              <button
                className="primary-button"
                type="submit"
                form="bundle-source-add-form"
                disabled={adding}
              >
                <Plus size={17} />
                {adding ? t("bundleSources.validating") : t("bundleSources.add")}
              </button>
            </>
          }
        >
          <form
            id="bundle-source-add-form"
            className="bundle-source-form"
            onSubmit={(event) => {
              event.preventDefault();
              void addSource();
            }}
          >
            <label>
              <span>{t("bundleSources.name")}</span>
              <input
                value={name}
                disabled={adding}
                data-dialog-initial-focus
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <label>
              <span>{t("bundleSources.remote")}</span>
              <input
                value={remote}
                disabled={adding}
                onChange={(event) => setRemote(event.target.value)}
                placeholder="git@github.com:organization/awesome-pragma.git"
                required
              />
            </label>
            <label>
              <span>{t("bundleSources.ref")}</span>
              <input
                value={ref}
                disabled={adding}
                onChange={(event) => setRef(event.target.value)}
                placeholder={t("bundleSources.refPlaceholder")}
              />
            </label>
            {addError ? <p className="form-error">{addError}</p> : null}
          </form>
        </Dialog>
      ) : null}
    </SettingsScreenFrame>
  );
}
