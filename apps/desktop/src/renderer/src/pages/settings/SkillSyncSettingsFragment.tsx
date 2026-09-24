import {
  ArrowsClockwise,
  CheckCircle,
  GitBranchIcon,
  SpinnerGap,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SkillSyncOverview } from "../../../../shared/contracts/index.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

export function SkillSyncSettingsFragment() {
  const { t } = useTranslation("settings");
  const [overview, setOverview] = useState<SkillSyncOverview>();
  const [remote, setRemote] = useState("");
  const [branch, setBranch] = useState("");
  const [autoPush, setAutoPush] = useState(true);
  const [pushDeletions, setPushDeletions] = useState(false);
  const [initializationMode, setInitializationMode] = useState<
    "merge_and_publish" | "restore_remote"
  >("merge_and_publish");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applyOverview = (next: SkillSyncOverview) => {
    setOverview(next);
    if (next.configuration !== undefined) {
      setRemote(next.configuration.remote);
      setBranch(next.configuration.branch ?? "");
      setAutoPush(next.configuration.autoPush);
      setPushDeletions(next.configuration.pushDeletions);
    } else {
      setRemote("");
      setBranch("");
      setAutoPush(true);
      setPushDeletions(false);
    }
  };

  useEffect(() => {
    void window.pragmaDesktop
      .getSkillSyncOverview()
      .then(applyOverview)
      .catch(() => setError(t("skillSync.loadFailed")));
  }, [t]);

  const run = async (
    operation: () => Promise<SkillSyncOverview | void>,
    getNotice?: (next: SkillSyncOverview) => string,
  ) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await operation();
      const result = next ?? (await window.pragmaDesktop.getSkillSyncOverview());
      applyOverview(result);
      setNotice(getNotice?.(result) ?? null);
    } catch {
      setError(t("skillSync.operationFailed"));
    } finally {
      setBusy(false);
    }
  };

  const attentionCount =
    overview?.skills.filter((skill) => skill.status === "error" || skill.status === "conflict")
      .length ?? 0;
  const pendingCount = overview?.skills.filter((skill) => skill.status === "pending").length ?? 0;
  const syncedCount = overview?.skills.filter((skill) => skill.status === "synced").length ?? 0;
  const syncMessage = (next: SkillSyncOverview) =>
    next.status === "ready" && next.errorMessage === undefined
      ? t("skillSync.syncComplete")
      : next.status === "error" || next.errorMessage !== undefined
        ? t("skillSync.syncFailed")
        : t("skillSync.syncWithIssues", {
            count: next.skills.filter(
              (skill) => skill.status === "error" || skill.status === "conflict",
            ).length,
          });

  const skillErrorHint = (code: string | undefined, message: string | undefined) => {
    const path = skillDiagnosticPath(code, message);
    let detail: string;
    switch (code) {
      case "skill_metadata_mismatch":
        detail = t("skillSync.diagnostics.metadataMismatch");
        break;
      case "skill_import_forbidden":
        detail = t("skillSync.diagnostics.unsupportedImport");
        break;
      case "skill_dynamic_module_loading_forbidden":
        detail = t("skillSync.diagnostics.dynamicLoading");
        break;
      case "skill_network_access_forbidden":
        detail = t("skillSync.diagnostics.networkAccess");
        break;
      case "skill_process_escape_forbidden":
        detail = t("skillSync.diagnostics.processAccess");
        break;
      case "skill_file_location_invalid":
        detail = t("skillSync.diagnostics.invalidFileLocation");
        break;
      case "skill_executable_extension_invalid":
        detail = t("skillSync.diagnostics.invalidScriptExtension");
        break;
      case "skill_script_language_unsupported":
        detail = t("skillSync.diagnostics.unsupportedScriptLanguage");
        break;
      case "skill_script_tests_missing":
        detail = t("skillSync.diagnostics.missingScriptTests");
        break;
      case "skill_script_uncovered":
        detail = t("skillSync.diagnostics.uncoveredScript");
        break;
      case "skill_sync_size_limit":
        detail = t("skillSync.diagnostics.fileTooLarge");
        break;
      case "skill_sync_binary_file":
        detail = t("skillSync.diagnostics.binaryFile");
        break;
      case "skill_sync_git_timeout":
        detail = t("skillSync.diagnostics.gitTimeout");
        break;
      case "skill_sync_head_changed":
        detail = t("skillSync.diagnostics.remoteChanged");
        break;
      case "custom":
        if (message?.includes("Skill package paths must be safe relative paths.")) {
          detail = t("skillSync.diagnostics.invalidFilePath");
        } else if (message?.includes("Skill file paths must be unique.")) {
          detail = t("skillSync.diagnostics.duplicateFile");
        } else if (message?.includes("SKILL.md is required.")) {
          detail = t("skillSync.diagnostics.missingSkillDocument");
        } else if (message?.includes("Skill packages may contain at most")) {
          detail = t("skillSync.diagnostics.packageTooLarge");
        } else {
          detail = t("skillSync.skillErrorHint");
        }
        break;
      default:
        detail = t("skillSync.skillErrorHint");
    }
    return path === undefined ? detail : t("skillSync.diagnosticWithFile", { path, detail });
  };

  return (
    <SettingsScreenFrame
      id="skill-sync-panel"
      labelledBy="skill-sync-heading"
      className="skill-sync-settings"
      header={
        <header className="panel-heading panel-heading-with-action knowledge-sync-heading">
          <div>
            <h2 id="skill-sync-heading">{t("skillSync.title")}</h2>
            <p>{t("skillSync.description")}</p>
          </div>
          {overview?.configured ? (
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => void run(() => window.pragmaDesktop.syncSkills(), syncMessage)}
            >
              {busy ? (
                <SpinnerGap className="skill-sync-spinner" size={17} aria-hidden="true" />
              ) : (
                <ArrowsClockwise size={17} aria-hidden="true" />
              )}
              {busy ? t("skillSync.syncing") : t("skillSync.syncNow")}
            </button>
          ) : null}
        </header>
      }
    >
      <form
        className="knowledge-sync-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            () =>
              window.pragmaDesktop.updateSkillSyncConfiguration({
                remote,
                ...(branch.trim() === "" ? {} : { branch }),
                autoPush,
                pushDeletions,
                initializationMode,
              }),
            (next) =>
              next.status === "ready" && next.errorMessage === undefined
                ? t("skillSync.configurationSaved")
                : next.status === "error" || next.errorMessage !== undefined
                  ? t("skillSync.configurationSavedButSyncFailed")
                  : t("skillSync.configurationSavedWithIssues", {
                      count: next.skills.filter(
                        (skill) => skill.status === "error" || skill.status === "conflict",
                      ).length,
                    }),
          );
        }}
      >
        <label className="knowledge-sync-field">
          <span>{t("skillSync.remote")}</span>
          <input
            aria-describedby={error === null ? undefined : "skill-sync-error"}
            value={remote}
            disabled={busy}
            onChange={(event) => {
              setRemote(event.target.value);
              setError(null);
              setNotice(null);
            }}
            placeholder="git@github.com:organization/skills.git"
            required
          />
        </label>
        <label className="knowledge-sync-field">
          <span>{t("skillSync.branch")}</span>
          <input
            aria-describedby={error === null ? undefined : "skill-sync-error"}
            value={branch}
            disabled={busy}
            onChange={(event) => {
              setBranch(event.target.value);
              setError(null);
              setNotice(null);
            }}
            placeholder={t("skillSync.defaultBranch")}
          />
        </label>
        <label className="knowledge-sync-field">
          <span>{t("skillSync.initializationMode")}</span>
          <SelectMenu<"merge_and_publish" | "restore_remote">
            ariaLabel={t("skillSync.initializationMode")}
            className="form-select"
            value={initializationMode}
            disabled={busy}
            options={[
              { value: "merge_and_publish", label: t("skillSync.mergeAndPublish") },
              { value: "restore_remote", label: t("skillSync.initializeFromRemote") },
            ]}
            onChange={(value) => {
              setInitializationMode(value);
              setError(null);
              setNotice(null);
            }}
          />
        </label>
        <label className="knowledge-sync-toggle">
          <input
            type="checkbox"
            checked={autoPush}
            disabled={busy}
            onChange={(event) => {
              setAutoPush(event.target.checked);
              setError(null);
              setNotice(null);
            }}
          />
          {t("skillSync.autoPush")}
        </label>
        <label className="knowledge-sync-toggle">
          <input
            type="checkbox"
            checked={pushDeletions}
            disabled={busy}
            onChange={(event) => {
              setPushDeletions(event.target.checked);
              setError(null);
              setNotice(null);
            }}
          />
          {t("skillSync.pushDeletions")}
        </label>
        {error !== null ? (
          <p className="form-error" id="skill-sync-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="knowledge-sync-actions">
          <button className="primary-button" type="submit" disabled={busy || remote.trim() === ""}>
            {busy ? t("skillSync.saving") : t("skillSync.saveAndSync")}
          </button>
          {overview?.configured ? (
            <button
              className="icon-button is-danger"
              type="button"
              aria-label={t("skillSync.remove")}
              title={t("skillSync.remove")}
              disabled={busy}
              onClick={() =>
                void run(
                  () => window.pragmaDesktop.removeSkillSyncConfiguration(),
                  () => t("skillSync.configurationRemoved"),
                )
              }
            >
              <Trash size={17} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </form>

      {notice !== null ? (
        <p className="knowledge-sync-feedback" role="status">
          {notice}
        </p>
      ) : null}

      {overview?.configured ? (
        <div className={`skill-sync-summary is-${overview.status}`} aria-live="polite">
          <div className="skill-sync-summary-copy">
            <span className="skill-sync-status-mark" aria-hidden="true">
              {overview.status === "ready" ? (
                <CheckCircle size={20} />
              ) : overview.status === "syncing" ? (
                <ArrowsClockwise size={20} />
              ) : (
                <WarningCircle size={20} />
              )}
            </span>
            <div>
              <strong>{t(`skillSync.overviewStatus.${overview.status}`)}</strong>
              <p>
                {t("skillSync.syncSummary", {
                  synced: syncedCount,
                  pending: pendingCount,
                  attention: attentionCount,
                })}
              </p>
              {overview.status === "error" ||
              overview.errorCode !== undefined ||
              overview.errorMessage !== undefined ? (
                <small className="skill-sync-summary-error">
                  {overview.errorCode !== undefined || overview.errorMessage !== undefined
                    ? t(
                        skillSyncRepositoryErrorMessageKey(
                          overview.errorCode,
                          overview.errorMessage,
                        ),
                      )
                    : t("skillSync.retryHint")}
                </small>
              ) : null}
            </div>
          </div>
          <p className="skill-sync-remote-meta">
            <GitBranchIcon size={15} aria-hidden="true" />
            {(overview.resolvedBranch ?? branch) || t("skillSync.defaultBranch")}
            {overview.revision ? ` · ${overview.revision.slice(0, 8)}` : ""}
          </p>
        </div>
      ) : null}

      {overview?.configured ? (
        <section className="skill-sync-items" aria-labelledby="skill-sync-items-heading">
          <header>
            <h3 id="skill-sync-items-heading">{t("skillSync.skillList")}</h3>
            <span>{overview.skills.length}</span>
          </header>
          {overview.skills.length === 0 ? (
            <p className="skill-sync-empty">{t("skillSync.noSkills")}</p>
          ) : null}
          {overview.skills.map((skill) => {
            const conflict = overview.conflicts.find((item) => item.syncKey === skill.syncKey);
            return (
              <article
                className={`knowledge-sync-card skill-sync-item is-${skill.status}`}
                key={skill.syncKey}
              >
                <div className="skill-sync-item-copy">
                  <strong>{skill.name}</strong>
                  {skill.status === "conflict" && conflict !== undefined ? (
                    <>
                      <small>{t("skillSync.conflict")}</small>
                      <details>
                        <summary>{t("skillSync.compareFiles")}</summary>
                        <small>
                          {t("skillSync.localFiles")}: {conflict.localFiles.join(", ") || "—"}
                        </small>
                        <small>
                          {t("skillSync.remoteFiles")}: {conflict.remoteFiles.join(", ") || "—"}
                        </small>
                      </details>
                    </>
                  ) : skill.status === "error" ? (
                    <small>{skillErrorHint(skill.errorCode, skill.errorMessage)}</small>
                  ) : (
                    <small>
                      {skill.status === "ignored_remote"
                        ? t("skillSync.ignoredRemote")
                        : t(`skillSync.status.${skill.status}`)}
                    </small>
                  )}
                </div>
                {skill.status === "conflict" ? (
                  <div className="knowledge-sync-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          window.pragmaDesktop.resolveSkillSyncConflict({
                            syncKey: skill.syncKey,
                            choice: "local",
                          }),
                        )
                      }
                    >
                      {t("skillSync.keepLocal")}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          window.pragmaDesktop.resolveSkillSyncConflict({
                            syncKey: skill.syncKey,
                            choice: "remote",
                          }),
                        )
                      }
                    >
                      {t("skillSync.useRemote")}
                    </button>
                  </div>
                ) : skill.status === "ignored_remote" ? (
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        window.pragmaDesktop.restoreIgnoredRemoteSkill({ syncKey: skill.syncKey }),
                      )
                    }
                  >
                    {t("skillSync.restore")}
                  </button>
                ) : null}
              </article>
            );
          })}
        </section>
      ) : null}
    </SettingsScreenFrame>
  );
}

export function skillSyncRepositoryErrorMessageKey(
  code: string | undefined,
  message: string | undefined,
): string {
  switch (code) {
    case "git_identity_missing":
      return "skillSync.diagnostics.gitIdentityMissing";
    case "skill_sync_git_timeout":
      return "skillSync.diagnostics.gitTimeout";
    case "skill_sync_head_changed":
      return "skillSync.diagnostics.remoteChanged";
    case "skill_sync_manifest_missing":
    case "skill_sync_manifest_invalid":
    case "skill_sync_protocol_unsupported":
    case "skill_sync_identity_mismatch":
    case "skill_sync_entry_invalid":
    case "skill_sync_integrity_failed":
      return "skillSync.diagnostics.repositoryFormat";
    case "skill_sync_binary_file":
      return "skillSync.diagnostics.binaryFile";
    case "skill_sync_size_limit":
      return "skillSync.diagnostics.packageTooLarge";
    case "skill_sync_path_invalid":
      return "skillSync.diagnostics.invalidFilePath";
  }

  const detail = message?.toLowerCase() ?? "";
  if (
    /auth|credential|publickey|permission denied|access denied|could not read username/iu.test(
      detail,
    )
  ) {
    return "skillSync.diagnostics.repositoryAccess";
  }
  if (
    /couldn.t find remote ref|invalid branch|not a valid branch name|invalid ref|unknown revision|reference is not a tree/iu.test(
      detail,
    )
  ) {
    return "skillSync.diagnostics.branchUnavailable";
  }
  if (/not a git repository|repository .* not found|could not read from remote/iu.test(detail)) {
    return "skillSync.diagnostics.repositoryAddress";
  }
  if (
    /could not resolve host(?:name)?|network|connect.*failed|connection.*(?:timed out|refused|reset)/iu.test(
      detail,
    )
  ) {
    return "skillSync.diagnostics.repositoryNetwork";
  }
  return "skillSync.diagnostics.repositorySyncFailed";
}

function skillDiagnosticPath(code: string | undefined, message: string | undefined) {
  if (code === "skill_sync_size_limit") {
    return /^Skill file is too large: (.+)$/u.exec(message ?? "")?.[1];
  }
  if (
    code === "skill_metadata_mismatch" ||
    code === "skill_import_forbidden" ||
    code === "skill_dynamic_module_loading_forbidden" ||
    code === "skill_network_access_forbidden" ||
    code === "skill_process_escape_forbidden" ||
    code === "skill_file_location_invalid" ||
    code === "skill_executable_extension_invalid" ||
    code === "skill_script_language_unsupported" ||
    code === "skill_script_uncovered"
  ) {
    const path = /^([^:]+):\s/u.exec(message ?? "")?.[1];
    return path !== undefined && path.length <= 300 ? path : undefined;
  }
  return undefined;
}
