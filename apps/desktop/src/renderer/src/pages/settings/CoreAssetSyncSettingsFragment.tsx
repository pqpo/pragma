import { CaretRight, CheckCircle, Disc, Gear, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CoreAssetSyncOverview } from "../../../../shared/contracts/index.ts";
import { gitFailureDetails, gitFailureKey } from "../../lib/git-feedback.ts";
import { aggregateCoreAssetSyncItems, coreAssetOverallHealth } from "./core-asset-sync-summary.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

export function CoreAssetSyncSettingsFragment() {
  const { t } = useTranslation("settings");
  const [overview, setOverview] = useState<CoreAssetSyncOverview>();
  const [remote, setRemote] = useState("");
  const [branch, setBranch] = useState("");
  const [autoPush, setAutoPush] = useState(true);
  const [pushDeletions, setPushDeletions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [error, setError] = useState<unknown>();
  const failure = error ?? overview?.error;
  const summary = useMemo(() => aggregateCoreAssetSyncItems(overview?.items ?? []), [overview]);
  const overallHealth =
    overview === undefined ? "synced" : coreAssetOverallHealth(overview.status, summary);
  const apply = (next: CoreAssetSyncOverview) => {
    setOverview(next);
  };
  useEffect(() => {
    void window.pragmaDesktop
      .getCoreAssetSyncOverview()
      .then(apply)
      .catch((cause: unknown) => setError(cause));
  }, []);
  const run = async (action: () => Promise<CoreAssetSyncOverview | void>) => {
    setBusy(true);
    setError(undefined);
    try {
      const next = (await action()) ?? (await window.pragmaDesktop.getCoreAssetSyncOverview());
      apply(next);
      return next.error === undefined;
    } catch (cause) {
      setError(cause);
      return false;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (overview?.status !== "syncing" || busy || error) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await window.pragmaDesktop.getCoreAssetSyncOverview();
        if (!cancelled) apply(next);
      } catch (cause) {
        if (!cancelled) setError(cause);
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 2_000);
      }
    };
    timer = setTimeout(() => void refresh(), 2_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [overview?.status, busy, error]);
  const openConfiguration = () => {
    const config = overview?.configuration;
    setRemote(config?.remote ?? "");
    setBranch(config?.branch ?? "");
    setAutoPush(config?.autoPush ?? true);
    setPushDeletions(config?.pushDeletions ?? false);
    setError(undefined);
    setConfigurationOpen(true);
  };
  const syncStatus = busy ? "syncing" : failure ? "failed" : overallHealth;
  const statusMessage = busy
    ? t("coreAssetSync.overview.syncing")
    : overview === undefined
      ? failure
        ? t("coreAssetSync.overview.loadFailed")
        : t("coreAssetSync.overview.loading")
      : overview.configuration === undefined
        ? t("coreAssetSync.overview.unconfigured")
        : syncStatus === "syncing"
          ? t("coreAssetSync.overview.syncing")
          : syncStatus === "failed"
            ? summary.failed > 0
              ? t("coreAssetSync.overview.failed", { count: summary.failed })
              : t("coreAssetSync.overview.syncError")
            : syncStatus === "pending"
              ? t("coreAssetSync.overview.pending", { count: summary.pending })
              : t("coreAssetSync.overview.synced");
  return (
    <SettingsScreenFrame
      className="core-asset-sync-screen"
      id="core-asset-sync-panel"
      labelledBy="core-asset-sync-heading"
      header={
        <header className="panel-heading core-asset-sync-heading">
          <div>
            <h2 id="core-asset-sync-heading">{t("coreAssetSync.title")}</h2>
            <p>{t("coreAssetSync.description")}</p>
          </div>
          <button
            className="secondary-button core-asset-sync-settings-button"
            type="button"
            aria-label={t("coreAssetSync.settings")}
            title={t("coreAssetSync.settings")}
            aria-haspopup="dialog"
            disabled={busy}
            onClick={openConfiguration}
          >
            <Gear size={20} aria-hidden="true" />
          </button>
        </header>
      }
    >
      <CoreAssetSyncStatus
        message={statusMessage}
        status={syncStatus}
        loading={overview === undefined && !failure}
        configured={overview?.configuration !== undefined}
        busy={busy}
        syncedAt={overview?.syncedAt}
        onSync={() => void run(() => window.pragmaDesktop.syncCoreAssets())}
      />
      {!configurationOpen && failure !== undefined && failure !== null && (
        <CoreAssetSyncError error={failure} />
      )}
      {configurationOpen ? (
        <Dialog
          title={t("coreAssetSync.settings")}
          description={t("coreAssetSync.settingsDescription")}
          className="core-asset-sync-configuration-dialog"
          busy={busy}
          onCancel={() => setConfigurationOpen(false)}
          footer={
            <>
              {overview?.configuration ? (
                <button
                  className="secondary-button core-asset-sync-remove"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() => window.pragmaDesktop.removeCoreAssetSyncConfiguration()).then(
                      (success) => {
                        if (success) setConfigurationOpen(false);
                      },
                    )
                  }
                >
                  {t("coreAssetSync.remove")}
                </button>
              ) : null}
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => setConfigurationOpen(false)}
              >
                {t("coreAssetSync.cancel")}
              </button>
              <button
                className="primary-button"
                type="submit"
                form="core-asset-sync-configuration-form"
                disabled={busy}
              >
                {t(busy ? "coreAssetSync.overview.syncing" : "coreAssetSync.saveAndSync")}
              </button>
            </>
          }
        >
          <form
            id="core-asset-sync-configuration-form"
            className="knowledge-sync-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              void run(() =>
                window.pragmaDesktop.updateCoreAssetSyncConfiguration({
                  remote: remote.trim(),
                  ...(branch.trim() ? { branch: branch.trim() } : {}),
                  autoPush,
                  pushDeletions,
                }),
              ).then((success) => {
                if (success) setConfigurationOpen(false);
              });
            }}
          >
            <label>
              {t("coreAssetSync.remote")}
              <input
                data-dialog-initial-focus
                value={remote}
                onChange={(event) => setRemote(event.target.value)}
                required
                disabled={busy}
              />
            </label>
            <label>
              {t("coreAssetSync.branch")}
              <input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                disabled={busy}
              />
            </label>
            <label className="knowledge-sync-toggle">
              <input
                type="checkbox"
                checked={autoPush}
                onChange={(event) => setAutoPush(event.target.checked)}
                disabled={busy}
              />
              {t("coreAssetSync.autoPush")}
            </label>
            <label className="knowledge-sync-toggle">
              <input
                type="checkbox"
                checked={pushDeletions}
                onChange={(event) => setPushDeletions(event.target.checked)}
                disabled={busy}
              />
              {t("coreAssetSync.pushDeletions")}
            </label>
          </form>
          {failure !== undefined && failure !== null ? (
            <CoreAssetSyncError error={failure} />
          ) : null}
        </Dialog>
      ) : null}

      {overview?.configuration && (
        <section className="core-asset-sync-status" aria-label={t("coreAssetSync.overview.title")}>
          <header>
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
            <div className="core-asset-sync-columns" aria-hidden="true">
              <span>{t("coreAssetSync.assetType")}</span>
              {(["total", "synced", "pending", "failed"] as const).map((key) => (
                <span key={key}>{t(`coreAssetSync.counts.${key}`)}</span>
              ))}
            </div>
            {summary.groups.map((group) => {
              const attention = group.assets.filter((asset) => asset.status !== "synced");
              const metrics = (
                <span className="core-asset-sync-group-metrics">
                  <span
                    aria-label={t("coreAssetSync.counts.totalWithCount", { count: group.total })}
                  >
                    {group.total}
                  </span>
                  <span
                    aria-label={t("coreAssetSync.counts.syncedWithCount", { count: group.synced })}
                  >
                    {group.synced}
                  </span>
                  <span
                    aria-label={t("coreAssetSync.counts.pendingWithCount", {
                      count: group.pending,
                    })}
                  >
                    {group.pending}
                  </span>
                  <span
                    className={group.failed > 0 ? "is-failed" : undefined}
                    aria-label={t("coreAssetSync.counts.failedWithCount", { count: group.failed })}
                  >
                    {group.failed}
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
                    <strong>
                      {t(`coreAssetSync.assetKinds.${group.kind}`)}
                      <CaretRight className="core-asset-sync-caret" size={16} aria-hidden="true" />
                    </strong>
                    {metrics}
                  </summary>
                  <div className="core-asset-sync-attention-list">
                    {attention.map((asset) => (
                      <article key={asset.key} className="core-asset-sync-attention-item">
                        <div className="skill-sync-item-copy">
                          <strong>{asset.name}</strong>
                          <small>{t(`coreAssetSync.health.${asset.status}`)}</small>
                          {asset.records.some((item) => item.status === "ignored_remote") ? (
                            <p>
                              {t("coreAssetSync.deletedLocally")}{" "}
                              {t(
                                asset.kind === "runtime-profile"
                                  ? "coreAssetSync.restoreDescription"
                                  : "coreAssetSync.restoreAssetDescription",
                              )}
                            </p>
                          ) : null}
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
                            if (item.status === "ignored_remote") {
                              if (
                                item.key !==
                                asset.records.find((record) => record.status === "ignored_remote")
                                  ?.key
                              )
                                return [];
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
                                <button
                                  className="secondary-button"
                                  disabled={busy}
                                  key={`${item.key}:delete-remote`}
                                  type="button"
                                  onClick={() =>
                                    void run(() =>
                                      window.pragmaDesktop.deleteRemoteCoreAsset(item.key),
                                    )
                                  }
                                >
                                  {t("coreAssetSync.deleteRemote")}
                                </button>,
                              ];
                            }
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

export function CoreAssetSyncError({ error }: { readonly error: unknown }) {
  const { t } = useTranslation("studio");
  return (
    <div role="alert" className="core-asset-sync-error">
      <p className="form-error">{t(`assetGit.errors.${gitFailureKey(error)}`)}</p>
      <details>
        <summary>{t("assetGit.errorDetails")}</summary>
        <pre>{gitFailureDetails(error)}</pre>
      </details>
    </div>
  );
}

export function CoreAssetSyncStatus(props: {
  readonly message: string;
  readonly status: "synced" | "pending" | "failed" | "syncing";
  readonly loading: boolean;
  readonly busy: boolean;
  readonly configured: boolean;
  readonly syncedAt?: string | undefined;
  readonly onSync: () => void;
}) {
  const { t } = useTranslation("settings");
  const spinning = props.loading || props.status === "syncing";
  return (
    <div className="core-asset-sync-toolbar" aria-busy={spinning}>
      <div className={`core-asset-sync-indicator is-${props.status}`}>
        {spinning ? (
          <Disc className="core-asset-sync-disc" size={32} aria-hidden="true" />
        ) : props.configured && props.status === "synced" ? (
          <CheckCircle size={32} weight="fill" aria-hidden="true" />
        ) : (
          <WarningCircle size={32} aria-hidden="true" />
        )}
        <div>
          <strong role="status" aria-live="polite">
            {props.message}
          </strong>
          <span>
            {props.syncedAt
              ? t("coreAssetSync.lastSync", { date: new Date(props.syncedAt).toLocaleString() })
              : t("coreAssetSync.neverSynced")}
          </span>
        </div>
      </div>
      <button
        className="primary-button"
        type="button"
        disabled={props.busy || !props.configured || spinning}
        onClick={props.onSync}
      >
        {t("coreAssetSync.syncNow")}
      </button>
    </div>
  );
}
