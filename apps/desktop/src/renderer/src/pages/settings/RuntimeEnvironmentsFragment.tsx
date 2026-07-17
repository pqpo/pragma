import { TerminalWindow } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import type { DesktopRuntimeAvailability } from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";

function RuntimeCard(props: { readonly runtime: DesktopRuntimeAvailability }) {
  const available = props.runtime.status === "available";

  return (
    <article className="runtime-card">
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

      <p className="runtime-description">{props.runtime.kind}</p>

      <div className="runtime-command">
        <div>
          <span>{props.runtime.executablePath === undefined ? "Runtime ID" : "Executable"}</span>
          <code>{props.runtime.executablePath ?? props.runtime.id}</code>
        </div>
        {props.runtime.version ? (
          <code className="runtime-version">{props.runtime.version}</code>
        ) : null}
      </div>
      {props.runtime.reason ? <p className="runtime-reason">{props.runtime.reason}</p> : null}
      {props.runtime.modelDiscoveryError ? (
        <p className="runtime-reason">{props.runtime.modelDiscoveryError}</p>
      ) : null}
      {(props.runtime.models?.length ?? 0) > 0 ? (
        <div className="configured-model-list">
          {props.runtime.models!.map((model) => (
            <div className="configured-model" key={runtimeModelKey(model)}>
              <div>
                <strong>{model.displayName}</strong>
                <p>
                  {model.provider.displayName}
                  {model.thinking === undefined
                    ? ""
                    : ` · Thinking: ${model.thinking.supportedLevels
                        .map((level) => level.label)
                        .join(", ")}`}
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export function RuntimeEnvironmentsFragment() {
  const [runtimes, setRuntimes] = useState<readonly DesktopRuntimeAvailability[]>([]);
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

  return (
    <div className="settings-panel" id="runtimes-panel" role="tabpanel">
      <header className="panel-heading panel-heading-with-action">
        <div>
          <h2>Runtime Environments</h2>
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

      <section className="runtime-section" aria-labelledby="local-runtimes-heading">
        <header className="section-copy compact-section-copy">
          <h3 id="local-runtimes-heading">Registered runtimes</h3>
          <p>Runtime availability and models are reported by each registered adapter.</p>
        </header>

        <div className="runtime-list">
          {loading ? <p className="empty-state">Checking runtime availability…</p> : null}
          {runtimes.map((runtime) => (
            <RuntimeCard key={runtime.id} runtime={runtime} />
          ))}
        </div>
      </section>
      {error ? (
        <p className="form-error runtime-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function runtimeModelKey(model: NonNullable<DesktopRuntimeAvailability["models"]>[number]): string {
  return JSON.stringify([model.provider.kind, model.provider.id, model.id]);
}
