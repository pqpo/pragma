import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CoreAssetSyncOverview } from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { aggregateCoreAssetSyncItems, coreAssetOverallHealth } from "./core-asset-sync-summary.ts";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

export function CoreAssetSyncSettingsFragment(props: {
  readonly onLegacySyncStoppedChange?: ((stopped: boolean) => void) | undefined;
}) {
  const { t } = useTranslation("settings");
  const [overview, setOverview] = useState<CoreAssetSyncOverview>();
  const [remote, setRemote] = useState("");
  const [branch, setBranch] = useState("");
  const [autoPush, setAutoPush] = useState(true);
  const [pushDeletions, setPushDeletions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const summary = useMemo(() => aggregateCoreAssetSyncItems(overview?.items ?? []), [overview]);
  const overallHealth =
    overview === undefined ? "synced" : coreAssetOverallHealth(overview.status, summary);
  const apply = (next: CoreAssetSyncOverview) => {
    setOverview(next);
    props.onLegacySyncStoppedChange?.(next.legacySyncStopped === true);
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
      {overview?.legacySyncStopped && (
        <p role="alert" className="form-error">
          {t("coreAssetSync.legacyStopped")}
        </p>
      )}
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
        <CoreAssetSyncActions
          busy={busy}
          configured={overview?.configuration !== undefined}
          onSync={() => void run(() => window.pragmaDesktop.syncCoreAssets())}
          onRemove={() => void run(() => window.pragmaDesktop.removeCoreAssetSyncConfiguration())}
        />
      </form>
      {(error ?? overview?.error) && (
        <p role="alert" className="form-error">
          {error ?? overview?.error}
        </p>
      )}
      {overview?.syncedAt && (
        <p>{t("coreAssetSync.lastSync", { date: new Date(overview.syncedAt).toLocaleString() })}</p>
      )}
      {overview?.configuration && (
        <section
          className="core-asset-sync-status"
          aria-labelledby="core-asset-sync-status-heading"
        >
          <header>
            <div>
              <h3 id="core-asset-sync-status-heading">{t("coreAssetSync.overview.title")}</h3>
              <p aria-live="polite">
                {overallHealth === "syncing"
                  ? t("coreAssetSync.overview.syncing")
                  : overallHealth === "failed"
                    ? summary.failed > 0
                      ? t("coreAssetSync.overview.failed", { count: summary.failed })
                      : t("coreAssetSync.overview.syncError")
                    : overallHealth === "pending"
                      ? t("coreAssetSync.overview.pending", { count: summary.pending })
                      : t("coreAssetSync.overview.synced")}
              </p>
            </div>
            <dl>
              <div>
                <dt>{t("coreAssetSync.counts.total")}</dt>
                <dd>{summary.total}</dd>
              </div>
              <div>
                <dt>{t("coreAssetSync.counts.synced")}</dt>
                <dd>{summary.synced}</dd>
              </div>
              <div>
                <dt>{t("coreAssetSync.counts.pending")}</dt>
                <dd>{summary.pending}</dd>
              </div>
              <div>
                <dt>{t("coreAssetSync.counts.failed")}</dt>
                <dd>{summary.failed}</dd>
              </div>
            </dl>
          </header>
          <div className="core-asset-sync-groups">
            {summary.groups.map((group) => {
              const attention = group.assets.filter((asset) => asset.status !== "synced");
              const metrics = (
                <span className="core-asset-sync-group-metrics">
                  <span>{t("coreAssetSync.counts.totalWithCount", { count: group.total })}</span>
                  <span>{t("coreAssetSync.counts.syncedWithCount", { count: group.synced })}</span>
                  <span>
                    {t("coreAssetSync.counts.pendingWithCount", { count: group.pending })}
                  </span>
                  <span className={group.failed > 0 ? "is-failed" : undefined}>
                    {t("coreAssetSync.counts.failedWithCount", { count: group.failed })}
                  </span>
                </span>
              );
              if (attention.length === 0)
                return (
                  <div className="core-asset-sync-group-row" key={group.kind}>
                    <strong>{t(`coreAssetSync.assetKinds.${group.kind}`)}</strong>
                    {metrics}
                  </div>
                );
              return (
                <details className="core-asset-sync-group" key={group.kind}>
                  <summary>
                    <strong>{t(`coreAssetSync.assetKinds.${group.kind}`)}</strong>
                    {metrics}
                  </summary>
                  <div className="core-asset-sync-attention-list">
                    {attention.map((asset) => (
                      <article key={asset.key} className="core-asset-sync-attention-item">
                        <div className="skill-sync-item-copy">
                          <strong>{asset.name}</strong>
                          <small>{t(`coreAssetSync.health.${asset.status}`)}</small>
                          {asset.records.flatMap((item) =>
                            item.message ? [<p key={item.key}>{item.message}</p>] : [],
                          )}
                        </div>
                        <div className="knowledge-sync-actions">
                          {asset.records.flatMap((item) => {
                            if (item.status === "conflict")
                              return [
                                <button
                                  className="secondary-button"
                                  disabled={busy}
                                  key={`${item.key}:local`}
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
                                </button>,
                                <button
                                  className="secondary-button"
                                  disabled={busy}
                                  key={`${item.key}:remote`}
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
                                </button>,
                              ];
                            if (item.status === "ignored_remote")
                              return [
                                <button
                                  className="secondary-button"
                                  disabled={busy}
                                  key={`${item.key}:restore`}
                                  type="button"
                                  onClick={() =>
                                    void run(() =>
                                      window.pragmaDesktop.restoreIgnoredCoreAsset(item.key),
                                    )
                                  }
                                >
                                  {t("coreAssetSync.restore")}
                                </button>,
                              ];
                            return [];
                          })}
                        </div>
                      </article>
                    ))}
                  </div>
                </details>
              );
            })}
          </div>
        </section>
      )}
    </SettingsScreenFrame>
  );
}

export function CoreAssetSyncActions(props: {
  readonly busy: boolean;
  readonly configured: boolean;
  readonly onSync: () => void;
  readonly onRemove: () => void;
}) {
  const { t } = useTranslation("settings");

  return (
    <div className="knowledge-sync-actions">
      <button className="primary-button" type="submit" disabled={props.busy}>
        {t("coreAssetSync.saveAndSync")}
      </button>
      {props.configured && (
        <button
          className="secondary-button"
          type="button"
          disabled={props.busy}
          onClick={props.onSync}
        >
          {t("coreAssetSync.syncNow")}
        </button>
      )}
      {props.configured && (
        <button
          className="danger-button"
          type="button"
          disabled={props.busy}
          onClick={props.onRemove}
        >
          {t("coreAssetSync.remove")}
        </button>
      )}
    </div>
  );
}
