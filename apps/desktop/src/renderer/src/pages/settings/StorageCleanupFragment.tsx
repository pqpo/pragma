import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  DesktopStorageCleanupOverview,
  MissionSummary,
} from "../../../../shared/contracts/index.ts";
import { ConfirmationDialog } from "../../components/Dialog.tsx";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

type CleanupAction = "missions" | "cache" | "trash";

function formatBytes(bytes: number, locale: string): string {
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1_024;
    unit += 1;
  } while (value >= 1_024 && unit < units.length - 1);
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}

export function StorageCleanupFragment() {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const [overview, setOverview] = useState<DesktopStorageCleanupOverview>();
  const [missions, setMissions] = useState<readonly MissionSummary[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<string>();
  const [failedMissionTitles, setFailedMissionTitles] = useState<readonly string[]>([]);
  const [action, setAction] = useState<CleanupAction>();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  const refresh = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextOverview, allMissions] = await Promise.all([
        window.pragmaDesktop.inspectStorageCleanup(),
        window.pragmaDesktop.listMissions(),
      ]);
      const completed = allMissions.filter(
        (mission) =>
          mission.source.type === "task" &&
          mission.lifecycleStatus === "completed" &&
          (mission.execution === undefined ||
            !["queued", "running", "waiting"].includes(mission.execution.status)),
      );
      setOverview(nextOverview);
      setMissions(completed);
      setSelected(
        (current) =>
          new Set(completed.filter((item) => current.has(item.id)).map((item) => item.id)),
      );
    } catch {
      setOverview(undefined);
      setMissions([]);
      setSelected(new Set());
      setError(t("storage.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // The data is deliberately refreshed only when this screen opens or the user asks.
  }, []);

  const toggleMission = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const confirm = async () => {
    if (action === undefined) return;
    const currentAction = action;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    setFailedMissionTitles([]);
    try {
      if (currentAction === "missions") {
        const ids = missions
          .filter((mission) => selected.has(mission.id))
          .map((mission) => mission.id);
        const failed = new Set<string>();
        const failedTitles: string[] = [];
        let deleted = 0;
        setProgress(0);
        for (const [index, id] of ids.entries()) {
          try {
            await window.pragmaDesktop.deleteCompletedTaskMission(id);
            deleted += 1;
          } catch {
            failed.add(id);
            failedTitles.push(missions.find((mission) => mission.id === id)?.title ?? id);
          }
          setProgress(index + 1);
        }
        setSelected(failed);
        setFailedMissionTitles(failedTitles);
        setResult(t("storage.missionResult", { deleted, failed: failed.size }));
      } else {
        const cleanup =
          currentAction === "cache"
            ? await window.pragmaDesktop.clearRebuildableCache()
            : await window.pragmaDesktop.emptyCompletedTrash();
        setResult(
          t("storage.cleanupResult", {
            count: cleanup.deletedEntries,
            size: formatBytes(cleanup.reclaimedBytes, i18n.language),
          }),
        );
      }
      setAction(undefined);
      await refresh();
    } catch {
      setAction(undefined);
      await refresh();
      setError(t("storage.cleanupError"));
    } finally {
      setBusy(false);
    }
  };

  const categories =
    overview === undefined
      ? []
      : ([
          ["workspace", overview.workspaceBytes],
          ["data", overview.storage.dataBytes],
          ["state", overview.storage.stateBytes],
          ["archives", overview.storage.archiveBytes],
          ["cache", overview.storage.cacheBytes],
          ["temporary", overview.storage.temporaryBytes],
          ["trash", overview.storage.trashBytes],
        ] as const);

  return (
    <SettingsScreenFrame
      id="storage-panel"
      labelledBy="storage-panel-heading"
      className="storage-cleanup-screen"
      header={
        <header className="panel-heading panel-heading-with-action">
          <div>
            <h2 id="storage-panel-heading">{t("storage.title")}</h2>
            <p>{t("storage.description")}</p>
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={loading || busy}
            onClick={() => void refresh()}
          >
            {t("storage.refresh")}
          </button>
        </header>
      }
    >
      <div className="storage-cleanup-content">
        {error ? (
          <p className="storage-cleanup-error" role="alert">
            {error}
          </p>
        ) : null}
        {result ? (
          <p className="storage-cleanup-result" role="status">
            {result}
          </p>
        ) : null}
        {failedMissionTitles.length > 0 ? (
          <div className="storage-cleanup-error" role="alert">
            <strong>{t("storage.failedMissions")}</strong>
            <ul>
              {failedMissionTitles.map((title, index) => (
                <li key={`${title}-${index}`}>{title}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <section className="storage-cleanup-section" aria-label={t("storage.usageTitle")}>
          <div className="storage-cleanup-section-heading">
            <h3>{t("storage.usageTitle")}</h3>
            <strong>
              {overview === undefined
                ? loading
                  ? t("storage.loading")
                  : "—"
                : formatBytes(overview.storage.totalBytes + overview.workspaceBytes, i18n.language)}
            </strong>
          </div>
          <p className="storage-cleanup-note">{t("storage.usageNote")}</p>
          {overview !== undefined ? (
            <div className="storage-cleanup-categories">
              {categories.map(([key, bytes]) => (
                <div className="storage-cleanup-category" key={key}>
                  <span>{t(`storage.categories.${key}`)}</span>
                  <strong>{formatBytes(bytes, i18n.language)}</strong>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="storage-cleanup-section">
          <div className="storage-cleanup-section-heading">
            <div>
              <h3>{t("storage.missionsTitle")}</h3>
              <p>{t("storage.missionsDescription")}</p>
            </div>
            <button
              className="danger-button"
              type="button"
              disabled={selected.size === 0 || busy || loading}
              onClick={() => setAction("missions")}
            >
              {t("storage.deleteSelected", { count: selected.size })}
            </button>
          </div>
          {missions.length > 0 ? (
            <>
              <label className="storage-cleanup-select-all">
                <input
                  type="checkbox"
                  checked={selected.size === missions.length}
                  disabled={busy || loading}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked ? new Set(missions.map((item) => item.id)) : new Set(),
                    )
                  }
                />
                {t("storage.selectAll", { count: missions.length })}
              </label>
              <div className="storage-cleanup-mission-list">
                {missions.map((mission) => (
                  <label className="storage-cleanup-mission" key={mission.id}>
                    <input
                      type="checkbox"
                      checked={selected.has(mission.id)}
                      disabled={busy || loading}
                      onChange={() => toggleMission(mission.id)}
                    />
                    <span>
                      <strong>{mission.title}</strong>
                      <small>
                        {t("storage.lastUpdated", {
                          date: new Intl.DateTimeFormat(i18n.language, {
                            dateStyle: "medium",
                          }).format(new Date(mission.updatedAt)),
                        })}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            </>
          ) : (
            <p className="storage-cleanup-note">
              {loading ? t("storage.loading") : t("storage.noMissions")}
            </p>
          )}
        </section>

        <section className="storage-cleanup-section storage-cleanup-action-row">
          <div>
            <h3>{t("storage.cacheTitle")}</h3>
            <p>
              {t("storage.cacheDescription", {
                size: formatBytes(overview?.clearableCacheBytes ?? 0, i18n.language),
              })}
            </p>
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={busy || loading || (overview?.clearableCacheEntries ?? 0) === 0}
            onClick={() => setAction("cache")}
          >
            {t("storage.clearCache")}
          </button>
        </section>
        <section className="storage-cleanup-section storage-cleanup-action-row">
          <div>
            <h3>{t("storage.trashTitle")}</h3>
            <p>
              {t("storage.trashDescription", {
                size: formatBytes(overview?.clearableTrashBytes ?? 0, i18n.language),
              })}
            </p>
            {overview !== undefined &&
            overview.storage.trashBytes > overview.clearableTrashBytes ? (
              <small className="storage-cleanup-note">{t("storage.protectedTrash")}</small>
            ) : null}
          </div>
          <button
            className="danger-button"
            type="button"
            disabled={busy || loading || (overview?.clearableTrashEntries ?? 0) === 0}
            onClick={() => setAction("trash")}
          >
            {t("storage.emptyTrash")}
          </button>
        </section>
      </div>
      {action !== undefined ? (
        <ConfirmationDialog
          title={t(`storage.confirm.${action}.title`)}
          description={t(`storage.confirm.${action}.description`, { count: selected.size })}
          warning={action === "trash" ? t("storage.confirm.trash.warning") : undefined}
          cancelLabel={t("actions.cancel", { ns: "common" })}
          confirmLabel={t(`storage.confirm.${action}.confirm`)}
          busyLabel={
            action === "missions"
              ? t("storage.deletingProgress", { done: progress, total: selected.size })
              : t("storage.cleaning")
          }
          busy={busy}
          tone={action === "cache" ? "primary" : "danger"}
          onCancel={() => setAction(undefined)}
          onConfirm={() => void confirm()}
        />
      ) : null}
    </SettingsScreenFrame>
  );
}
