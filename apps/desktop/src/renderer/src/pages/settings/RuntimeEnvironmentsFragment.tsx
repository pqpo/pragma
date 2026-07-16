import { TerminalWindow } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import type { DesktopRuntimeAvailability } from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";

const runtimeDetails = {
  pi: {
    name: "PI Runtime",
    description: "Pragma's built-in runtime for managed agent execution.",
    command: "Built in",
  },
  codex: {
    name: "Codex",
    description: "OpenAI's coding agent runtime for local workspaces and shell tasks.",
    command: "codex",
  },
  "claude-code": {
    name: "Claude Code",
    description: "Anthropic's coding agent runtime for repository-aware development tasks.",
    command: "claude",
  },
} satisfies Record<
  DesktopRuntimeAvailability["id"],
  {
    readonly name: string;
    readonly description: string;
    readonly command: string;
  }
>;

function RuntimeCard(props: { readonly runtime: DesktopRuntimeAvailability }) {
  const details = runtimeDetails[props.runtime.id];
  const available = props.runtime.status === "available";

  return (
    <article className="runtime-card">
      <header className="card-header runtime-card-header">
        <span className="card-icon runtime-icon" aria-hidden="true">
          <TerminalWindow size={24} />
        </span>
        <div className="card-title-group">
          <h3>{details.name}</h3>
          <p className={available ? "status-copy is-active" : "status-copy"}>
            <span className="status-dot" aria-hidden="true" />
            {available ? "Available" : "Unavailable"}
          </p>
        </div>
        <span className={available ? "status-badge is-ready" : "status-badge"}>
          {available ? "Ready" : "Not available"}
        </span>
      </header>

      <p className="runtime-description">{details.description}</p>

      <div className="runtime-command">
        <div>
          <span>{props.runtime.id === "pi" ? "Runtime" : "Executable"}</span>
          <code>{props.runtime.executablePath ?? details.command}</code>
        </div>
        {props.runtime.version ? (
          <code className="runtime-version">{props.runtime.version}</code>
        ) : null}
      </div>
      {props.runtime.reason ? <p className="runtime-reason">{props.runtime.reason}</p> : null}
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
          <p>Check which runtimes are available on this device.</p>
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
          <h3 id="local-runtimes-heading">Available runtimes</h3>
          <p>PI is built in. Codex and Claude Code are checked from their local commands.</p>
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
