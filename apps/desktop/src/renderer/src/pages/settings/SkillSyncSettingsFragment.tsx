import { ArrowsClockwise, GitBranchIcon, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SkillSyncOverview } from "../../../../shared/contracts/index.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { errorMessage } from "../../lib/errors.ts";
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
  const activeError = error ?? overview?.errorMessage;

  const applyOverview = (next: SkillSyncOverview) => {
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
      .getSkillSyncOverview()
      .then(applyOverview)
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, []);

  const run = async (operation: () => Promise<SkillSyncOverview | void>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await operation();
      applyOverview(next ?? (await window.pragmaDesktop.getSkillSyncOverview()));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsScreenFrame
      id="skill-sync-panel"
      labelledBy="skill-sync-heading"
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
              onClick={() => void run(() => window.pragmaDesktop.syncSkills())}
            >
              <ArrowsClockwise size={17} /> {t("skillSync.syncNow")}
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
            window.pragmaDesktop.updateSkillSyncConfiguration({
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
          <span>{t("skillSync.remote")}</span>
          <input
            value={remote}
            disabled={busy}
            onChange={(event) => setRemote(event.target.value)}
            placeholder="git@github.com:organization/skills.git"
            required
          />
        </label>
        <label>
          <span>{t("skillSync.branch")}</span>
          <input
            value={branch}
            disabled={busy}
            onChange={(event) => setBranch(event.target.value)}
            placeholder={t("skillSync.defaultBranch")}
          />
        </label>
        <label>
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
          {t("skillSync.autoPush")}
        </label>
        <label className="knowledge-sync-toggle">
          <input
            type="checkbox"
            checked={pushDeletions}
            disabled={busy}
            onChange={(event) => setPushDeletions(event.target.checked)}
          />
          {t("skillSync.pushDeletions")}
        </label>
        {activeError !== undefined ? (
          <p className="form-error" role="alert">
            {activeError}
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
              onClick={() => void run(() => window.pragmaDesktop.removeSkillSyncConfiguration())}
            >
              <Trash size={17} aria-hidden="true" />
            </button>
          ) : null}
          {overview?.configured ? (
            <p>
              <GitBranchIcon size={16} />{" "}
              {(overview.resolvedBranch ?? branch) || t("skillSync.defaultBranch")}
              {overview.revision ? ` · ${overview.revision.slice(0, 8)}` : ""}
            </p>
          ) : null}
        </div>
      </form>

      {overview?.conflicts.map((conflict) => (
        <article className="knowledge-sync-card" key={conflict.syncKey}>
          <div>
            <strong>{conflict.name}</strong>
            <small>
              {t("skillSync.conflict", {
                local: conflict.localFiles.length,
                remote: conflict.remoteFiles.length,
              })}
            </small>
            <small>
              {t("skillSync.localFiles")}: {conflict.localFiles.join(", ") || "—"}
            </small>
            <small>
              {t("skillSync.remoteFiles")}: {conflict.remoteFiles.join(", ") || "—"}
            </small>
          </div>
          <div className="knowledge-sync-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  window.pragmaDesktop.resolveSkillSyncConflict({
                    syncKey: conflict.syncKey,
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
                    syncKey: conflict.syncKey,
                    choice: "remote",
                  }),
                )
              }
            >
              {t("skillSync.useRemote")}
            </button>
          </div>
        </article>
      ))}
      {(overview?.skills.filter((skill) => skill.status === "ignored_remote") ?? []).map(
        (skill) => (
          <article className="knowledge-sync-card" key={skill.syncKey}>
            <div>
              <strong>{skill.name}</strong>
              <small>{t("skillSync.ignoredRemote")}</small>
            </div>
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
          </article>
        ),
      )}
      {(overview?.skills.filter((skill) => skill.status === "error") ?? []).map((skill) => (
        <article className="knowledge-sync-card" key={skill.syncKey}>
          <div>
            <strong>{skill.name}</strong>
            <small>{skill.errorMessage ?? t("skillSync.error")}</small>
          </div>
        </article>
      ))}
      {(
        overview?.skills.filter((skill) =>
          ["synced", "pending", "syncing"].includes(skill.status),
        ) ?? []
      ).map((skill) => (
        <article className="knowledge-sync-card" key={skill.syncKey}>
          <div>
            <strong>{skill.name}</strong>
            <small>{t(`skillSync.status.${skill.status}`)}</small>
          </div>
        </article>
      ))}
    </SettingsScreenFrame>
  );
}
