import { ArrowLeft, ArrowsClockwise, TerminalWindow } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import type { DesktopRuntimeAvailability } from "../../../../shared/desktop-api.ts";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

export function RuntimeEnvironmentDetail(props: {
  readonly runtime: DesktopRuntimeAvailability;
  readonly refreshing: boolean;
  readonly error: string | null;
  readonly onBack: () => void;
  readonly onRefresh: () => void;
}) {
  const { runtime } = props;
  const available = runtime.status === "available";
  const models = runtime.models ?? [];

  return (
    <SettingsScreenFrame
      id="runtimes-panel"
      labelledBy="runtime-detail-name"
      className="runtime-detail"
      header={
        <>
          <button className="back-link runtime-detail-back" type="button" onClick={props.onBack}>
            <ArrowLeft size={18} aria-hidden="true" />
            Back to Runtime Environments
          </button>

          <header className="runtime-detail-header">
            <span className="runtime-detail-icon" aria-hidden="true">
              <TerminalWindow size={32} />
            </span>
            <div>
              <div className="runtime-detail-title-line">
                <h2 id="runtime-detail-name">{runtime.displayName}</h2>
                {runtime.isDefault ? <span className="status-badge is-ready">Default</span> : null}
              </div>
              <p>{runtime.kind}</p>
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={props.onRefresh}
              disabled={props.refreshing}
            >
              <ArrowsClockwise size={16} aria-hidden="true" />
              {props.refreshing ? "Checking…" : "Check again"}
            </button>
          </header>
        </>
      }
    >
      <section className="runtime-detail-meta" aria-label="Runtime status and identity">
        <RuntimeFact label="Status">
          <span className={available ? "runtime-detail-status is-active" : "runtime-detail-status"}>
            <i aria-hidden="true" />
            {available ? "Available" : "Unavailable"}
          </span>
        </RuntimeFact>
        <RuntimeFact label="Runtime ID">
          <code>{runtime.id}</code>
        </RuntimeFact>
        <RuntimeFact label="Origin">
          {runtime.origin ? runtimeOrigin(runtime.origin) : "—"}
        </RuntimeFact>
        <RuntimeFact label="Revision">{runtime.revision ?? "—"}</RuntimeFact>
        <RuntimeFact label="Executable">
          {runtime.executablePath ? <code>{runtime.executablePath}</code> : "Managed by adapter"}
        </RuntimeFact>
        <RuntimeFact label="Runtime version">{runtime.version ?? "—"}</RuntimeFact>
        <RuntimeFact label="Adapter">
          {runtime.adapter ? (
            <code>
              {runtime.adapter.id}@{runtime.adapter.version}
            </code>
          ) : (
            "—"
          )}
        </RuntimeFact>
      </section>

      {runtime.reason ? (
        <p className="runtime-detail-diagnostic" role="status">
          <strong>Runtime unavailable</strong>
          {runtime.reason}
        </p>
      ) : null}
      {runtime.modelDiscoveryError ? (
        <p className="runtime-detail-diagnostic" role="status">
          <strong>Model discovery failed</strong>
          {runtime.modelDiscoveryError}
        </p>
      ) : null}
      {props.error ? (
        <p className="form-error runtime-error" role="alert">
          {props.error}
        </p>
      ) : null}

      <section className="runtime-model-section" aria-labelledby="runtime-models-heading">
        <header>
          <div>
            <h3 id="runtime-models-heading">Models</h3>
            <p>The model catalog reported by this Runtime Environment.</p>
          </div>
          <span>{models.length}</span>
        </header>

        {models.length === 0 ? (
          <p className="empty-state">
            {runtime.modelDiscoveryError
              ? "The model catalog could not be loaded."
              : "This Runtime Environment did not report any models."}
          </p>
        ) : (
          <div className="runtime-model-list">
            {models.map((model) => (
              <article className="runtime-model-row" key={runtimeModelKey(model)}>
                <div>
                  <div className="runtime-model-name">
                    <strong>{model.displayName}</strong>
                    {model.default ? <span className="status-badge is-ready">Default</span> : null}
                  </div>
                  <p>
                    {model.provider.displayName} · {providerKind(model.provider.kind)}
                  </p>
                </div>
                <div className="runtime-model-identity">
                  <span>Model ID</span>
                  <code>{model.id}</code>
                </div>
                <div className="runtime-model-thinking">
                  <span>Thinking levels</span>
                  <p>
                    {model.thinking === undefined
                      ? "Not reported"
                      : model.thinking.supportedLevels.map((level) => level.label).join(", ")}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </SettingsScreenFrame>
  );
}

function RuntimeFact(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <h3>{props.label}</h3>
      <p>{props.children}</p>
    </div>
  );
}

function runtimeOrigin(origin: NonNullable<DesktopRuntimeAvailability["origin"]>): string {
  return origin === "built-in" ? "Built in" : "Registered";
}

function providerKind(
  kind: NonNullable<DesktopRuntimeAvailability["models"]>[number]["provider"]["kind"],
): string {
  return kind === "runtime-managed" ? "Runtime managed" : "Registered provider";
}

function runtimeModelKey(model: NonNullable<DesktopRuntimeAvailability["models"]>[number]): string {
  return JSON.stringify([model.provider.kind, model.provider.id, model.id]);
}
