import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CoreAssetSyncOverview } from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

export function CoreAssetSyncSettingsFragment() {
  const { t } = useTranslation("settings");
  const [overview, setOverview] = useState<CoreAssetSyncOverview>();
  const [remote, setRemote] = useState("");
  const [branch, setBranch] = useState("");
  const [autoPush, setAutoPush] = useState(true);
  const [pushDeletions, setPushDeletions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const apply = (next: CoreAssetSyncOverview) => {
    setOverview(next);
    if (next.configuration) {
      setRemote(next.configuration.remote);
      setBranch(next.configuration.branch ?? "");
      setAutoPush(next.configuration.autoPush);
      setPushDeletions(next.configuration.pushDeletions);
    }
  };
  useEffect(() => {
    void window.pragmaDesktop
      .getCoreAssetSyncOverview()
      .then(apply)
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, []);
  const run = async (action: () => Promise<CoreAssetSyncOverview | void>) => {
    setBusy(true);
    setError(undefined);
    try {
      apply((await action()) ?? (await window.pragmaDesktop.getCoreAssetSyncOverview()));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsScreenFrame
      id="core-asset-sync-panel"
      labelledBy="core-asset-sync-heading"
      header={
        <header className="panel-heading">
          <h2 id="core-asset-sync-heading">{t("coreAssetSync.title")}</h2>
          <p>{t("coreAssetSync.description")}</p>
        </header>
      }
    >
      <form
        className="knowledge-sync-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() =>
            window.pragmaDesktop.updateCoreAssetSyncConfiguration({
              remote,
              ...(branch.trim() ? { branch: branch.trim() } : {}),
              autoPush,
              pushDeletions,
            }),
          );
        }}
      >
        <label>
          {t("coreAssetSync.remote")}
          <input value={remote} onChange={(event) => setRemote(event.target.value)} required />
        </label>
        <label>
          {t("coreAssetSync.branch")}
          <input value={branch} onChange={(event) => setBranch(event.target.value)} />
        </label>
        <label className="knowledge-sync-toggle">
          <input
            type="checkbox"
            checked={autoPush}
            onChange={(event) => setAutoPush(event.target.checked)}
          />
          {t("coreAssetSync.autoPush")}
        </label>
        <label className="knowledge-sync-toggle">
          <input
            type="checkbox"
            checked={pushDeletions}
            onChange={(event) => setPushDeletions(event.target.checked)}
          />
          {t("coreAssetSync.pushDeletions")}
        </label>
        <div className="knowledge-sync-actions">
          <button type="submit" disabled={busy}>
            {t("coreAssetSync.saveAndSync")}
          </button>
          {overview?.configuration && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => window.pragmaDesktop.syncCoreAssets())}
            >
              {t("coreAssetSync.syncNow")}
            </button>
          )}
          {overview?.configuration && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() => window.pragmaDesktop.removeCoreAssetSyncConfiguration())
              }
            >
              {t("coreAssetSync.remove")}
            </button>
          )}
        </div>
      </form>
      {(error ?? overview?.error) && (
        <p role="alert" className="form-error">
          {error ?? overview?.error}
        </p>
      )}
      {overview?.syncedAt && (
        <p>{t("coreAssetSync.lastSync", { date: new Date(overview.syncedAt).toLocaleString() })}</p>
      )}
      <div className="skill-sync-items">
        {overview?.items.map((item) => (
          <div key={item.key} className="knowledge-sync-card skill-sync-item">
            <div>
              <strong>{item.name}</strong>
              <small>
                {t(`coreAssetSync.kinds.${item.kind}`)} · {t(`coreAssetSync.status.${item.status}`)}
              </small>
              {item.message && <p>{item.message}</p>}
            </div>
            {item.status === "conflict" && (
              <div className="knowledge-sync-actions">
                <button
                  disabled={busy}
                  type="button"
                  onClick={() =>
                    void run(() =>
                      window.pragmaDesktop.resolveCoreAssetSyncConflict({
                        key: item.key,
                        choice: "local",
                      }),
                    )
                  }
                >
                  {t("coreAssetSync.keepLocal")}
                </button>
                <button
                  disabled={busy}
                  type="button"
                  onClick={() =>
                    void run(() =>
                      window.pragmaDesktop.resolveCoreAssetSyncConflict({
                        key: item.key,
                        choice: "remote",
                      }),
                    )
                  }
                >
                  {t("coreAssetSync.keepRemote")}
                </button>
              </div>
            )}
            {item.status === "ignored_remote" && (
              <button
                disabled={busy}
                type="button"
                onClick={() =>
                  void run(() => window.pragmaDesktop.restoreIgnoredCoreAsset(item.key))
                }
              >
                {t("coreAssetSync.restore")}
              </button>
            )}
          </div>
        ))}
      </div>
    </SettingsScreenFrame>
  );
}
