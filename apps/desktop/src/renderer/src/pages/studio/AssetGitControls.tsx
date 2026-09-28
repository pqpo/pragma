import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AssetGitStatus, AssetGitTarget } from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { desktopApi } from "./studio-model.ts";

export function AssetGitPanel(props: {
  readonly target: AssetGitTarget;
  readonly showHeading?: boolean | undefined;
  readonly beforeSync?: (() => Promise<void>) | undefined;
  readonly onSynced: () => Promise<void>;
}) {
  const { t } = useTranslation("studio");
  const [status, setStatus] = useState<AssetGitStatus | null>(null);
  const [remote, setRemote] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const api = desktopApi();
    const appliesToTarget = (next: AssetGitStatus) =>
      next.target.kind === props.target.kind && next.target.id === props.target.id;
    const applyBackgroundStatus = (next: AssetGitStatus) => {
      if (!active || !appliesToTarget(next)) return;
      setStatus(next);
    };
    const applyLoadedStatus = (next: AssetGitStatus) => {
      if (!active || !appliesToTarget(next)) return;
      setStatus(next);
      setRemote(next.source?.remote ?? "");
      setBranch(next.source?.branch ?? "");
    };
    const unsubscribe = api?.subscribeAssetGitStatusUpdates(applyBackgroundStatus);
    void api
      ?.getAssetGitStatus(props.target)
      .then(applyLoadedStatus)
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [props.target.kind, props.target.id]);

  const run = async (action: () => Promise<AssetGitStatus>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setStatus(next);
      setRemote(next.source?.remote ?? "");
      setBranch(next.source?.branch ?? "");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="asset-git-panel" aria-label={t("assetGit.title")}>
      {props.showHeading === false ? null : (
        <>
          <h2>{t("assetGit.title")}</h2>
          <p>{t("assetGit.description")}</p>
        </>
      )}
      <label>
        {t("assetGit.remote")}
        <input
          type="text"
          value={remote}
          onChange={(event) => setRemote(event.target.value)}
          placeholder="https://github.com/team/asset.git"
          disabled={busy}
        />
      </label>
      <label>
        {t("assetGit.branch")}
        <input
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          placeholder={t("assetGit.defaultBranch")}
          disabled={busy}
        />
      </label>
      <div className="knowledge-sync-actions">
        <button
          type="button"
          disabled={busy || remote.trim() === ""}
          onClick={() =>
            void run(async () => {
              const api = desktopApi();
              if (!api) throw new Error("Desktop bridge is unavailable.");
              return await api.bindAssetGit({
                target: props.target,
                source: {
                  remote: remote.trim(),
                  ...(branch.trim() ? { branch: branch.trim() } : {}),
                },
              });
            })
          }
        >
          {t("assetGit.save")}
        </button>
        <button
          type="button"
          disabled={
            busy ||
            status?.status === "unbound" ||
            status === null ||
            remote.trim() !== status.source?.remote ||
            branch.trim() !== (status.source?.branch ?? "")
          }
          onClick={() =>
            void run(async () => {
              const api = desktopApi();
              if (!api) throw new Error("Desktop bridge is unavailable.");
              await props.beforeSync?.();
              const next = await api.syncAssetGit(props.target);
              await props.onSynced();
              return next;
            })
          }
        >
          {busy ? t("assetGit.syncing") : t("assetGit.sync")}
        </button>
        {status?.source ? (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const api = desktopApi();
                if (!api) throw new Error("Desktop bridge is unavailable.");
                await api.unbindAssetGit(props.target);
                return await api.getAssetGitStatus(props.target);
              })
            }
          >
            {t("assetGit.unbind")}
          </button>
        ) : null}
      </div>
      {status ? <p aria-live="polite">{t(`assetGit.status.${status.status}`)}</p> : null}
      {status?.syncedAt ? (
        <p>
          {t("assetGit.lastSync")}: {new Date(status.syncedAt).toLocaleString()}
        </p>
      ) : null}
      {status?.conflictPaths?.length ? (
        <p role="alert">
          {t("assetGit.conflict")}: {status.conflictPaths.join(", ")}
        </p>
      ) : null}
      {status?.error ? <p role="alert">{status.error}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

export function AssetGitImportForm(props: {
  readonly kind: AssetGitTarget["kind"];
  readonly onImported: (target: AssetGitTarget) => Promise<void>;
}) {
  const { t } = useTranslation("studio");
  const [remote, setRemote] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="asset-git-import-form"
      onSubmit={(event) => {
        event.preventDefault();
        const api = desktopApi();
        if (!api) return;
        setBusy(true);
        setError(null);
        void api
          .importAssetGit({
            kind: props.kind,
            source: {
              remote: remote.trim(),
              ...(branch.trim() ? { branch: branch.trim() } : {}),
            },
          })
          .then(async (target) => {
            await props.onImported(target);
          })
          .catch((cause: unknown) => setError(errorMessage(cause)))
          .finally(() => setBusy(false));
      }}
    >
      <label>
        {t("assetGit.remote")}
        <input
          value={remote}
          onChange={(event) => setRemote(event.target.value)}
          placeholder="https://github.com/team/asset.git"
        />
      </label>
      <label>
        {t("assetGit.branch")}
        <input
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          placeholder={t("assetGit.defaultBranch")}
        />
      </label>
      <button type="submit" disabled={busy || remote.trim() === ""}>
        {busy ? t("assetGit.syncing") : t("assetGit.import")}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
