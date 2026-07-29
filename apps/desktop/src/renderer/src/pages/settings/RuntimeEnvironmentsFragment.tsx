import { CaretRight, TerminalWindow } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DesktopRuntimeAvailability } from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { isBuiltInRuntime, runtimeDisplayName } from "../../lib/runtime-display.ts";
import { RuntimeEnvironmentDetail } from "./RuntimeEnvironmentDetail.tsx";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

export function RuntimeCard(props: {
  readonly runtime: DesktopRuntimeAvailability;
  readonly onOpen: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const available = props.runtime.status === "available";
  const modelCount = props.runtime.models?.length;
  const displayName = runtimeDisplayName(t, props.runtime);
  const runtimeType = isBuiltInRuntime(props.runtime)
    ? t("runtimes.builtIn", { ns: "settings" })
    : props.runtime.kind;

  return (
    <article className="runtime-card runtime-summary-card">
      <button
        className="runtime-card-hit-target"
        type="button"
        aria-label={t("runtimes.viewDetails", {
          ns: "settings",
          name: displayName,
        })}
        onClick={props.onOpen}
      />
      <header className="card-header runtime-card-header">
        <span className="card-icon runtime-icon" aria-hidden="true">
          <TerminalWindow size={24} />
        </span>
        <div className="card-title-group">
          <h3>{displayName}</h3>
          <p className={available ? "status-copy is-active" : "status-copy"}>
            <span className="status-dot" aria-hidden="true" />
            {available
              ? t("status.available", { ns: "common" })
              : t("status.unavailable", { ns: "common" })}
          </p>
        </div>
        <span className={available ? "status-badge is-ready" : "status-badge"}>
          {available
            ? t("status.ready", { ns: "common" })
            : t("status.notAvailable", { ns: "common" })}
        </span>
      </header>

      <div className="runtime-summary-footer">
        <div>
          <p>{runtimeType}</p>
          <span>
            {modelCount === undefined
              ? t("runtimes.catalogUnavailable", { ns: "settings" })
              : t("counts.model", { ns: "common", count: modelCount })}
          </span>
        </div>
        <span className="runtime-open-detail" aria-hidden="true">
          {t("actions.viewDetails", { ns: "common" })}
          <CaretRight size={17} />
        </span>
      </div>
    </article>
  );
}

export function RuntimeEnvironmentsFragment() {
  const { t } = useTranslation(["settings", "common"]);
  const [runtimes, setRuntimes] = useState<readonly DesktopRuntimeAvailability[]>([]);
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRuntimes = async () => {
    setLoading(true);
    try {
      setRuntimes(await window.pragmaDesktop.getRuntimeAvailability());
      setError(null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadRuntimes();
  }, []);

  const selectedRuntime = runtimes.find((runtime) => runtime.id === selectedRuntimeId);

  if (selectedRuntime !== undefined) {
    return (
      <RuntimeEnvironmentDetail
        runtime={selectedRuntime}
        refreshing={loading}
        error={error}
        onBack={() => setSelectedRuntimeId(undefined)}
        onRefresh={() => void loadRuntimes()}
      />
    );
  }

  return (
    <SettingsScreenFrame
      id="runtimes-panel"
      labelledBy="runtimes-panel-heading"
      header={
        <header className="panel-heading panel-heading-with-action">
          <div>
            <h2 id="runtimes-panel-heading">{t("runtimes.title", { ns: "settings" })}</h2>
            <p>{t("runtimes.description", { ns: "settings" })}</p>
          </div>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void loadRuntimes()}
            disabled={loading}
          >
            {loading
              ? t("actions.checking", { ns: "common" })
              : t("actions.checkAgain", { ns: "common" })}
          </button>
        </header>
      }
    >
      <section className="runtime-section" aria-labelledby="local-runtimes-heading">
        <div className="runtime-list">
          {loading ? (
            <p className="empty-state">{t("runtimes.checking", { ns: "settings" })}</p>
          ) : null}
          {runtimes.map((runtime) => (
            <RuntimeCard
              key={runtime.id}
              runtime={runtime}
              onOpen={() => setSelectedRuntimeId(runtime.id)}
            />
          ))}
        </div>
      </section>
      {error ? (
        <p className="form-error runtime-error" role="alert">
          {error}
        </p>
      ) : null}
    </SettingsScreenFrame>
  );
}
