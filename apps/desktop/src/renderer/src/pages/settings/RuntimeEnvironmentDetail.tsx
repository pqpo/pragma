import { ArrowLeft, ArrowsClockwise } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { DesktopRuntimeAvailability } from "../../../../shared/contracts/index.ts";
import { RuntimeLogo } from "../../components/RuntimeLogo.tsx";
import { isBuiltInRuntime, runtimeDisplayName } from "../../lib/runtime-display.ts";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

export function RuntimeEnvironmentDetail(props: {
  readonly runtime: DesktopRuntimeAvailability;
  readonly refreshing: boolean;
  readonly error: string | null;
  readonly onBack: () => void;
  readonly onRefresh: () => void;
  readonly onNavigateToModels?: (() => void) | undefined;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { runtime } = props;
  const available = runtime.status === "available";
  const models = runtime.models ?? [];
  const builtIn = isBuiltInRuntime(runtime);
  const displayName = runtimeDisplayName(t, runtime);
  const runtimeType = builtIn ? t("runtimes.builtIn", { ns: "settings" }) : runtime.kind;

  return (
    <SettingsScreenFrame
      id="runtimes-panel"
      labelledBy="runtime-detail-name"
      className="runtime-detail"
      header={
        <>
          <button className="back-link runtime-detail-back" type="button" onClick={props.onBack}>
            <ArrowLeft size={18} aria-hidden="true" />
            {t("runtimes.back", { ns: "settings" })}
          </button>

          <header className="runtime-detail-header">
            <span className="runtime-detail-icon" aria-hidden="true">
              <RuntimeLogo runtime={runtime} className="runtime-detail-logo" />
            </span>
            <div>
              <div className="runtime-detail-title-line">
                <h2 id="runtime-detail-name">{displayName}</h2>
                {runtime.isDefault ? (
                  <span className="status-badge is-ready">
                    {t("status.default", { ns: "common" })}
                  </span>
                ) : null}
              </div>
              <p>{runtimeType}</p>
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={props.onRefresh}
              disabled={props.refreshing}
            >
              <ArrowsClockwise size={16} aria-hidden="true" />
              {props.refreshing
                ? t("actions.checking", { ns: "common" })
                : t("actions.checkAgain", { ns: "common" })}
            </button>
          </header>
        </>
      }
    >
      <section
        className="runtime-detail-meta"
        aria-label={t("runtimes.statusIdentity", { ns: "settings" })}
      >
        <RuntimeFact label={t("runtimes.status", { ns: "settings" })}>
          <span className={available ? "runtime-detail-status is-active" : "runtime-detail-status"}>
            <i aria-hidden="true" />
            {available
              ? t("status.available", { ns: "common" })
              : t("status.unavailable", { ns: "common" })}
          </span>
        </RuntimeFact>
        {builtIn ? null : (
          <RuntimeFact label={t("runtimes.runtimeId", { ns: "settings" })}>
            <code>{runtime.id}</code>
          </RuntimeFact>
        )}
        <RuntimeFact label={t("runtimes.origin", { ns: "settings" })}>
          {runtime.origin
            ? runtime.origin === "built-in"
              ? t("runtimes.builtIn", { ns: "settings" })
              : t("runtimes.registered", { ns: "settings" })
            : "—"}
        </RuntimeFact>
        <RuntimeFact label={t("runtimes.revision", { ns: "settings" })}>
          {runtime.revision ?? "—"}
        </RuntimeFact>
        <RuntimeFact label={t("runtimes.executable", { ns: "settings" })}>
          {runtime.executablePath ? (
            <code>{runtime.executablePath}</code>
          ) : (
            t("runtimes.managedByAdapter", { ns: "settings" })
          )}
        </RuntimeFact>
        <RuntimeFact label={t("runtimes.runtimeVersion", { ns: "settings" })}>
          {runtime.version ?? "—"}
        </RuntimeFact>
        {builtIn ? null : (
          <RuntimeFact label={t("runtimes.adapter", { ns: "settings" })}>
            {runtime.adapter ? (
              <code>
                {runtime.adapter.id}@{runtime.adapter.version}
              </code>
            ) : (
              "—"
            )}
          </RuntimeFact>
        )}
      </section>

      {runtime.reason ? (
        <p className="runtime-detail-diagnostic" role="status">
          <strong>{t("runtimes.unavailable", { ns: "settings" })}</strong>
          {runtime.reason}
        </p>
      ) : null}
      {runtime.modelDiscoveryError ? (
        <p className="runtime-detail-diagnostic" role="status">
          <strong>{t("runtimes.discoveryFailed", { ns: "settings" })}</strong>
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
            <h3 id="runtime-models-heading">{t("runtimes.models", { ns: "settings" })}</h3>
            <p>{t("runtimes.catalogDescription", { ns: "settings" })}</p>
          </div>
          <span>{models.length}</span>
        </header>

        {models.length === 0 ? (
          <div className="empty-state runtime-empty-state">
            <p>
              {runtime.modelDiscoveryError
                ? t("runtimes.catalogLoadFailed", { ns: "settings" })
                : t("runtimes.noModels", { ns: "settings" })}
            </p>
            {builtIn && runtime.models !== undefined && props.onNavigateToModels !== undefined ? (
              <button className="secondary-button" type="button" onClick={props.onNavigateToModels}>
                {t("runtimes.configureModelsAction", { ns: "settings" })}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="runtime-model-list">
            {models.map((model) => (
              <article className="runtime-model-row" key={runtimeModelKey(model)}>
                <div>
                  <div className="runtime-model-name">
                    <strong>{model.displayName}</strong>
                    {model.default ? (
                      <span className="status-badge is-ready">
                        {t("status.default", { ns: "common" })}
                      </span>
                    ) : null}
                  </div>
                  <p>
                    {model.provider.displayName} ·{" "}
                    {model.provider.kind === "runtime-managed"
                      ? t("runtimes.runtimeManaged", { ns: "settings" })
                      : t("runtimes.registeredProvider", { ns: "settings" })}
                  </p>
                </div>
                <div className="runtime-model-identity">
                  <span>{t("runtimes.modelId", { ns: "settings" })}</span>
                  <code>{model.id}</code>
                </div>
                <div className="runtime-model-thinking">
                  <span>{t("runtimes.thinkingLevels", { ns: "settings" })}</span>
                  <p>
                    {model.thinking === undefined
                      ? t("runtimes.defaultOnly", { ns: "settings" })
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

function runtimeModelKey(model: NonNullable<DesktopRuntimeAvailability["models"]>[number]): string {
  return JSON.stringify([model.provider.kind, model.provider.id, model.id]);
}
