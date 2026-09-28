import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AssetGitStatus, AssetGitTarget } from "../../../../shared/contracts/index.ts";
import { gitFailureKey } from "../../lib/git-feedback.ts";
import { AssetGitConflictEditor } from "./AssetGitConflictEditor.tsx";
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
  const [operation, setOperation] = useState<"save" | "sync" | "unbind" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    let active = true;
    const api = desktopApi();
    const appliesToTarget = (next: AssetGitStatus) =>
      next.target.kind === props.target.kind && next.target.id === props.target.id;
    const applyBackgroundStatus = (next: AssetGitStatus) => {
      if (!active || !appliesToTarget(next)) return;
      setStatus(next);
      setError(null);
      setNotice(null);
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
        if (active) setError(gitFailureKey(cause));
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [props.target.kind, props.target.id]);

  const run = async (
    kind: "save" | "sync" | "unbind",
    action: () => Promise<AssetGitStatus>,
  ): Promise<void> => {
    setBusy(true);
    setOperation(kind);
    setNotice(null);
    setError(null);
    try {
      const next = await action();
      setStatus(next);
      setRemote(next.source?.remote ?? "");
      setBranch(next.source?.branch ?? "");
      if (next.error) setError(gitFailureKey(next.error));
      else if (next.backupFailed) setNotice("backupFailed");
      else if (kind !== "sync" || next.status === "synced")
        setNotice(kind === "save" ? "saved" : kind === "unbind" ? "unbound" : "synced");
    } catch (cause) {
      setError(gitFailureKey(cause));
    } finally {
      setBusy(false);
      setOperation(null);
    }
  };
  const dirty =
    status?.source === undefined ||
    remote.trim() !== status.source.remote ||
    branch.trim() !== (status.source.branch ?? "");
  return (
    <section className="asset-git-panel" aria-label={t("assetGit.title")}>
      {props.showHeading === false ? null : (
        <>
          <h2>{t("assetGit.title")}</h2>
          <p>{t("assetGit.description")}</p>
        </>
      )}
      <label className="asset-git-field">
        {t("assetGit.remote")}
        <input
          type="text"
          disabled={busy}
          value={remote}
          onChange={(event) => setRemote(event.target.value)}
          placeholder="https://github.com/team/asset.git"
        />
      </label>
      <label className="asset-git-field">
        {t("assetGit.branch")}
        <input
          disabled={busy}
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          placeholder={t("assetGit.defaultBranch")}
        />
      </label>
      <div className="asset-git-actions">
        <button
          type="button"
          className={dirty ? "primary-button" : "text-button"}
          disabled={busy || remote.trim() === "" || !dirty}
          onClick={() =>
            void run("save", async () => {
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
          {t(operation === "save" ? "assetGit.saving" : "assetGit.save")}
        </button>
        <button
          type="button"
          className={dirty ? "text-button" : "primary-button"}
          disabled={
            busy ||
            status?.status === "unbound" ||
            status === null ||
            remote.trim() !== status.source?.remote ||
            branch.trim() !== (status.source?.branch ?? "")
          }
          onClick={() =>
            void run("sync", async () => {
              const api = desktopApi();
              if (!api) throw new Error("Desktop bridge is unavailable.");
              await props.beforeSync?.();
              const next = await api.syncAssetGit(props.target);
              await props.onSynced();
              return next;
            })
          }
        >
          {operation === "sync" ? t("assetGit.syncing") : t("assetGit.sync")}
        </button>
        {status?.source ? (
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() =>
              void run("unbind", async () => {
                const api = desktopApi();
                if (!api) throw new Error("Desktop bridge is unavailable.");
                await api.unbindAssetGit(props.target);
                return await api.getAssetGitStatus(props.target);
              })
            }
          >
            {t(operation === "unbind" ? "assetGit.unbinding" : "assetGit.unbind")}
          </button>
        ) : null}
      </div>
      {status && error === null && notice === null ? (
        <p className="asset-git-status" aria-live="polite">
          {t(`assetGit.status.${status.status}`)}
        </p>
      ) : null}
      {status?.syncedAt ? (
        <p className="asset-git-status">
          {t("assetGit.lastSync")}: {new Date(status.syncedAt).toLocaleString()}
        </p>
      ) : null}
      {status?.conflictPaths?.length ? (
        <div className="asset-git-conflict-summary">
          <p role="alert">{t("assetGit.conflictCount", { count: status.conflictPaths.length })}</p>
          <ul>
            {status.conflictPaths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          <button
            className="text-button"
            type="button"
            disabled={busy || dirty}
            onClick={() => setResolving(true)}
          >
            {t("assetGit.resolve")}
          </button>
        </div>
      ) : null}
      {notice ? (
        <p className="asset-git-status" role="status">
          {t(`assetGit.notices.${notice}`)}
        </p>
      ) : null}
      {error || status?.error ? (
        <p className="form-error" role="alert">
          {t(`assetGit.errors.${error ?? gitFailureKey(status?.error)}`)}
        </p>
      ) : null}
      {resolving ? (
        <AssetGitConflictEditor
          target={props.target}
          beforeApply={props.beforeSync}
          onClose={() => setResolving(false)}
          onResolved={async (next) => {
            setStatus(next);
            setError(next.error ? gitFailureKey(next.error) : null);
            if (next.status === "synced") {
              setResolving(false);
              setNotice(next.backupFailed ? "backupFailed" : "synced");
              await props.onSynced();
            }
          }}
        />
      ) : null}
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
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229))
          event.preventDefault();
      }}
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
          .catch((cause: unknown) => setError(gitFailureKey(cause)))
          .finally(() => setBusy(false));
      }}
    >
      <label className="asset-git-field">
        {t("assetGit.remote")}
        <input
          disabled={busy}
          value={remote}
          onChange={(event) => setRemote(event.target.value)}
          placeholder="https://github.com/team/asset.git"
        />
      </label>
      <label className="asset-git-field">
        {t("assetGit.branch")}
        <input
          disabled={busy}
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          placeholder={t("assetGit.defaultBranch")}
        />
      </label>
      <button className="primary-button" type="submit" disabled={busy || remote.trim() === ""}>
        {busy ? t("assetGit.importing") : t("assetGit.import")}
      </button>
      {error ? (
        <p className="form-error" role="alert">
          {t(`assetGit.errors.${error}`)}
        </p>
      ) : null}
    </form>
  );
}
