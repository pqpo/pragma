import { CheckCircle, Circle, FileText, FileImage, Trash, X } from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { EditorState } from "@codemirror/state";
import { useTranslation } from "react-i18next";

import type {
  AssetGitConflicts,
  AssetGitResolution,
  AssetGitStatus,
  AssetGitTarget,
} from "../../../../shared/contracts/index.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { gitFailureKey } from "../../lib/git-feedback.ts";
import { desktopApi } from "./studio-model.ts";

const AssetGitMergeEditor = lazy(() => import("./AssetGitMergeEditor.tsx"));

export function AssetGitConflictEditor(props: {
  readonly target: AssetGitTarget;
  readonly beforeApply?: (() => Promise<void>) | undefined;
  readonly onClose: () => void;
  readonly onResolved: (status: AssetGitStatus) => Promise<void>;
}) {
  const { t } = useTranslation("studio");
  const [preview, setPreview] = useState<AssetGitConflicts>();
  const [decisions, setDecisions] = useState<Map<string, AssetGitResolution>>(new Map());
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const editorStates = useRef(new Map<string, EditorState>());
  const [pendingChunks, setPendingChunks] = useState(new Map<string, number>());
  const [showBase, setShowBase] = useState(false);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [errorPath, setErrorPath] = useState<string>();
  const [confirmClose, setConfirmClose] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    setBusy(true);
    void desktopApi()
      ?.getAssetGitConflicts(props.target)
      .then((next) => {
        if (!active) return;
        setPreview(next);
        setSelected(next.files[0]?.path ?? "");
        // Keep edited text available when a stale snapshot is refreshed, but require
        // the user to make fresh choices before submitting it.
      })
      .catch((cause: unknown) => {
        if (active) setError(gitFailureKey(cause));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [props.target.kind, props.target.id, generation]);
  const file = preview?.files.find((item) => item.path === selected);
  const decision = decisions.get(selected);
  const update = (next: AssetGitResolution) => {
    setDecisions((current) => new Map(current).set(next.path, next));
    if (next.choice === "manual")
      setDrafts((current) => new Map(current).set(next.path, next.content));
    setError(undefined);
    setErrorPath(undefined);
  };
  const close = () =>
    decisions.size > 0 || drafts.size > 0 ? setConfirmClose(true) : props.onClose();
  const isDecided = (path: string) => {
    const choice = decisions.get(path);
    return choice !== undefined && (choice.choice !== "manual" || pendingChunks.get(path) === 0);
  };
  const completed = preview?.files.filter((item) => isDecided(item.path)).length ?? 0;
  const ready =
    preview !== undefined && preview.files.length > 0 && completed === preview.files.length;
  const apply = async () => {
    if (!preview || !ready) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.beforeApply?.();
      const api = desktopApi();
      if (!api) throw new Error("Desktop bridge is unavailable.");
      const result = await api.resolveAssetGitConflicts({
        target: props.target,
        snapshot: preview.snapshot,
        resolutions: preview.files.map((item) => decisions.get(item.path)!),
      });
      if (result.status === "error") {
        setError(gitFailureKey(result.error));
        setErrorPath(result.errorPath);
        if (result.errorPath && preview.files.some((item) => item.path === result.errorPath))
          setSelected(result.errorPath);
      } else if (result.status === "conflict") {
        setError("stale");
      }
      await props.onResolved(result);
    } catch (cause) {
      setError(gitFailureKey(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t("assetGit.mergeTitle")}
      description={t("assetGit.mergeDescription")}
      className="asset-git-merge-dialog"
      backdropClassName="asset-git-merge-backdrop"
      busy={busy}
      onCancel={close}
      headerAction={
        <button
          className="text-button asset-git-icon-button"
          type="button"
          disabled={busy}
          aria-label={t("assetGit.cancel")}
          title={t("assetGit.cancel")}
          onClick={close}
        >
          <X size={20} aria-hidden="true" />
        </button>
      }
      footer={
        <>
          <div className="asset-git-merge-progress" role="status">
            <CheckCircle size={18} aria-hidden="true" />
            <span>{t("assetGit.progress", { completed, total: preview?.files.length ?? 0 })}</span>
            <span className="asset-git-merge-hint">{t("assetGit.autoMerged")}</span>
          </div>
          <button className="text-button" type="button" disabled={busy} onClick={close}>
            {t("assetGit.cancel")}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy || !ready || error === "stale"}
            onClick={() => void apply()}
          >
            {t(busy ? "assetGit.syncing" : "assetGit.apply")}
          </button>
        </>
      }
    >
      {error ? (
        <p className="form-error asset-git-merge-error" role="alert">
          {errorPath ? `${errorPath}: ` : ""}
          {t(`assetGit.errors.${error}`)}
        </p>
      ) : null}
      {error === "stale" ? (
        <button
          className="text-button"
          type="button"
          disabled={busy}
          onClick={() => {
            setDecisions(new Map());
            setPendingChunks(new Map());
            editorStates.current.clear();
            setError(undefined);
            setGeneration((value) => value + 1);
          }}
        >
          {t("assetGit.reload")}
        </button>
      ) : null}
      {preview?.files.length === 0 ? <p>{t("assetGit.noConflicts")}</p> : null}
      <div className="asset-git-merge-layout">
        <nav aria-label={t("assetGit.files")} className="asset-git-merge-files">
          <div className="asset-git-files-heading">
            <span>{t("assetGit.files")}</span>
            <span>{preview?.files.length ?? 0}</span>
          </div>
          <div className="asset-git-file-list">
            {preview?.files.map((item) => (
              <button
                className={`text-button${selected === item.path ? " is-active" : ""}`}
                type="button"
                key={item.path}
                title={item.path}
                disabled={busy}
                aria-pressed={selected === item.path}
                onClick={() => {
                  setSelected(item.path);
                  setShowBase(false);
                }}
              >
                {item.kind === "binary" ? (
                  <FileImage size={18} aria-hidden="true" />
                ) : (
                  <FileText size={18} aria-hidden="true" />
                )}
                <span className="asset-git-file-label">
                  <span>{item.path.split("/").at(-1)}</span>
                  {item.path.includes("/") ? (
                    <small>{item.path.slice(0, item.path.lastIndexOf("/"))}</small>
                  ) : null}
                </span>
                <span
                  className={`asset-git-file-state${isDecided(item.path) ? " is-complete" : ""}`}
                  aria-label={t(isDecided(item.path) ? "assetGit.decided" : "assetGit.pending")}
                  title={t(isDecided(item.path) ? "assetGit.decided" : "assetGit.pending")}
                >
                  {isDecided(item.path) ? (
                    <CheckCircle size={16} weight="fill" aria-hidden="true" />
                  ) : (
                    <Circle size={16} aria-hidden="true" />
                  )}
                </span>
              </button>
            ))}
          </div>
        </nav>
        {file ? (
          <div className="asset-git-merge-content">
            <div className="asset-git-file-header">
              <div className="asset-git-file-title">
                {file.kind === "binary" ? (
                  <FileImage size={18} aria-hidden="true" />
                ) : (
                  <FileText size={18} aria-hidden="true" />
                )}
                <h3>{file.path}</h3>
              </div>
              <div className="asset-git-file-tools">
                {file.kind === "text" ? (
                  <button
                    className="text-button"
                    type="button"
                    disabled={busy}
                    aria-pressed={showBase}
                    onClick={() => setShowBase((value) => !value)}
                  >
                    {t(showBase ? "assetGit.backToMerge" : "assetGit.viewBase")}
                  </button>
                ) : null}
                <button
                  className="text-button asset-git-icon-button asset-git-delete-button"
                  type="button"
                  disabled={busy}
                  aria-label={t("assetGit.deleteFile")}
                  title={t("assetGit.deleteFile")}
                  aria-pressed={decision?.choice === "delete"}
                  onClick={() => update({ path: file.path, choice: "delete" })}
                >
                  <Trash size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className="asset-git-version-bar">
              <div
                className="asset-git-version-options"
                role="group"
                aria-label={t("assetGit.versionChoice")}
              >
                {file.kind === "text" ? (
                  <button
                    className="text-button"
                    type="button"
                    disabled={busy}
                    aria-pressed={!decision || decision.choice === "manual"}
                    onClick={() =>
                      update({
                        path: file.path,
                        choice: "manual",
                        content:
                          decision?.choice === "manual"
                            ? decision.content
                            : (drafts.get(file.path) ??
                              file.mergeLocal ??
                              file.local ??
                              file.remote ??
                              ""),
                        ...(props.target.kind === "skill"
                          ? { executable: file.localExecutable ?? file.remoteExecutable ?? false }
                          : {}),
                      })
                    }
                  >
                    {t("assetGit.manual")}
                  </button>
                ) : null}
                {(["local", "remote"] as const).map((choice) => (
                  <button
                    className="text-button"
                    type="button"
                    key={choice}
                    disabled={busy}
                    aria-pressed={decision?.choice === choice}
                    onClick={() => update({ path: file.path, choice })}
                  >
                    {t(
                      choice === "local"
                        ? file.localDeleted
                          ? "assetGit.localDelete"
                          : "assetGit.wholeLocal"
                        : file.remoteDeleted
                          ? "assetGit.remoteDelete"
                          : "assetGit.wholeRemote",
                    )}
                  </button>
                ))}
              </div>
              {file.kind === "text" && !showBase && (!decision || decision.choice === "manual") ? (
                <div className="asset-git-source-legend" aria-label={t("assetGit.editorHelp")}>
                  <span className="is-remote">{t("assetGit.remoteLabel")}</span>
                  <span className="is-local">{t("assetGit.localLabel")}</span>
                </div>
              ) : (
                <span className="asset-git-status">
                  {t(
                    showBase
                      ? "assetGit.base"
                      : file.kind === "binary"
                        ? "assetGit.binaryLabel"
                        : decision?.choice === "local"
                          ? "assetGit.local"
                          : decision?.choice === "remote"
                            ? "assetGit.remoteVersion"
                            : "assetGit.deleteFile",
                  )}
                </span>
              )}
            </div>
            {file.modeConflict ? <p>{t("assetGit.modeConflict")}</p> : null}
            {decision?.choice === "manual" && props.target.kind === "skill" ? (
              <label className="asset-git-mode">
                <input
                  type="checkbox"
                  checked={decision.executable ?? false}
                  disabled={busy}
                  onChange={(event) => update({ ...decision, executable: event.target.checked })}
                />
                {t("assetGit.executable")}
              </label>
            ) : null}
            {decision?.choice === "delete" && !showBase ? (
              <div className="asset-git-binary-state">
                <Trash size={32} aria-hidden="true" />
                <p>{t("assetGit.deletePreview")}</p>
              </div>
            ) : file.kind === "binary" ? (
              <div className="asset-git-binary-state">
                <FileImage size={32} aria-hidden="true" />
                <p>{t("assetGit.binary")}</p>
              </div>
            ) : (
              <>
                <Suspense fallback={<p role="status">{t("assetGit.loadingEditor")}</p>}>
                  <AssetGitMergeEditor
                    documentKey={`${preview!.snapshot}:${file.path}:${showBase ? "base" : decision?.choice === "local" || decision?.choice === "remote" || decision?.choice === "delete" ? decision.choice : "manual"}`}
                    initialContent={
                      showBase
                        ? (file.base ?? "")
                        : decision?.choice === "local"
                          ? (file.local ?? "")
                          : decision?.choice === "remote"
                            ? (file.remote ?? "")
                            : decision?.choice === "delete"
                              ? ""
                              : (drafts.get(file.path) ?? file.mergeLocal ?? "")
                    }
                    original={
                      showBase || (decision && decision.choice !== "manual")
                        ? undefined
                        : (file.mergeRemote ?? "")
                    }
                    readOnly={showBase || (decision !== undefined && decision.choice !== "manual")}
                    busy={busy}
                    states={editorStates.current}
                    onChange={(content, remaining, edited) => {
                      if (showBase || (decision && decision.choice !== "manual")) return;
                      setPendingChunks((current) =>
                        current.get(file.path) === remaining
                          ? current
                          : new Map(current).set(file.path, remaining),
                      );
                      if (edited)
                        update({
                          path: file.path,
                          choice: "manual",
                          content,
                          ...(props.target.kind === "skill"
                            ? {
                                executable:
                                  decision?.choice === "manual"
                                    ? decision.executable
                                    : (file.localExecutable ?? file.remoteExecutable ?? false),
                              }
                            : {}),
                        });
                    }}
                  />
                </Suspense>
              </>
            )}
          </div>
        ) : null}
      </div>
      {confirmClose ? (
        <Dialog
          title={t("assetGit.discardTitle")}
          description={t("assetGit.discardDescription")}
          onCancel={() => setConfirmClose(false)}
          footer={
            <>
              <button className="text-button" type="button" onClick={() => setConfirmClose(false)}>
                {t("assetGit.keepEditing")}
              </button>
              <button className="primary-button" type="button" onClick={props.onClose}>
                {t("assetGit.discard")}
              </button>
            </>
          }
        />
      ) : null}
    </Dialog>
  );
}
