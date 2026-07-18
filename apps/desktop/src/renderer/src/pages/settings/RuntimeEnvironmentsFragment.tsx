import { CaretRight, TerminalWindow } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import type { DesktopRuntimeAvailability } from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";
import { RuntimeEnvironmentDetail } from "./RuntimeEnvironmentDetail.tsx";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

export function RuntimeCard(props: {
  readonly runtime: DesktopRuntimeAvailability;
  readonly onOpen: () => void;
}) {
  const available = props.runtime.status === "available";
  const modelCount = props.runtime.models?.length;

  return (
    <article className="runtime-card runtime-summary-card">
      <button
        className="runtime-card-hit-target"
        type="button"
        aria-label={`View ${props.runtime.displayName} details`}
        onClick={props.onOpen}
      />
      <header className="card-header runtime-card-header">
        <span className="card-icon runtime-icon" aria-hidden="true">
          <TerminalWindow size={24} />
        </span>
        <div className="card-title-group">
          <h3>{props.runtime.displayName}</h3>
          <p className={available ? "status-copy is-active" : "status-copy"}>
            <span className="status-dot" aria-hidden="true" />
            {available ? "Available" : "Unavailable"}
          </p>
        </div>
        <span className={available ? "status-badge is-ready" : "status-badge"}>
          {available ? "Ready" : "Not available"}
        </span>
      </header>

      <div className="runtime-summary-footer">
        <div>
          <p>{props.runtime.kind}</p>
          <span>
            {modelCount === undefined
              ? "Model catalog unavailable"
              : `${modelCount} ${modelCount === 1 ? "model" : "models"}`}
          </span>
        </div>
        <span className="runtime-open-detail" aria-hidden="true">
          View details
          <CaretRight size={17} />
        </span>
      </div>
    </article>
  );
}

export function RuntimeEnvironmentsFragment() {
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
            <h2 id="runtimes-panel-heading">Runtime Environments</h2>
            <p>Inspect registered runtimes and the model catalogs they provide.</p>
          </div>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void loadRuntimes()}
            disabled={loading}
          >
            {loading ? "Checking…" : "Check again"}
          </button>
        </header>
      }
    >
      <section className="runtime-section" aria-labelledby="local-runtimes-heading">
        <div className="runtime-list">
          {loading ? <p className="empty-state">Checking runtime availability…</p> : null}
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
