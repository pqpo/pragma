import { ArrowsClockwise, CircleNotch } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DesktopRuntimeAvailability } from "../../../../shared/contracts/index.ts";
import { RuntimeLogo } from "../../components/RuntimeLogo.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { isBuiltInRuntime, runtimeDisplayName } from "../../lib/runtime-display.ts";
import { RuntimeEnvironmentDetail } from "./RuntimeEnvironmentDetail.tsx";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

const INITIAL_RUNTIMES: readonly DesktopRuntimeAvailability[] = [
  {
    id: "pi",
    displayName: "Built-in Runtime",
    isDefault: true,
    kind: "cloud-pi-agent",
    status: "unavailable",
    origin: "built-in",
  },
  {
    id: "codex",
    displayName: "Codex",
    isDefault: false,
    kind: "codex-local",
    status: "unavailable",
    origin: "built-in",
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    isDefault: false,
    kind: "claude-code-local",
    status: "unavailable",
    origin: "built-in",
  },
  {
    id: "qodercli",
    displayName: "Qoder CLI",
    isDefault: false,
    kind: "qodercli-local",
    status: "unavailable",
    origin: "built-in",
  },
  {
    id: "antigravity",
    displayName: "Antigravity CLI",
    isDefault: false,
    kind: "antigravity-local",
    status: "unavailable",
    origin: "built-in",
  },
];

export function RuntimeCard(props: {
  readonly runtime: DesktopRuntimeAvailability;
  readonly isProbing?: boolean;
  readonly onOpen: () => void;
  readonly onRefresh?: () => void;
  readonly onNavigateToModels: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const isProbing = props.isProbing ?? false;
  const available = props.runtime.status === "available";
  const displayName = runtimeDisplayName(t, props.runtime);
  const models = props.runtime.models;
  const showModelConfigurationLink =
    isBuiltInRuntime(props.runtime) && models !== undefined && models.length === 0;

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
          <RuntimeLogo runtime={props.runtime} />
        </span>
        <div className="card-title-group">
          <h3>{displayName}</h3>
          <p
            className={
              isProbing ? "status-copy" : available ? "status-copy is-active" : "status-copy"
            }
          >
            <span
              className={isProbing ? "status-dot runtime-spin" : "status-dot"}
              aria-hidden="true"
            />
            {isProbing
              ? t("actions.checking", { ns: "common" })
              : available
                ? t("status.available", { ns: "common" })
                : t("status.unavailable", { ns: "common" })}
          </p>
        </div>
        {isProbing ? (
          <span className="status-badge is-probing">
            <CircleNotch size={12} className="runtime-spin" aria-hidden="true" />
            <span>{t("actions.checking", { ns: "common" })}</span>
          </span>
        ) : (
          <button
            className={available ? "status-badge-button is-ready" : "status-badge-button"}
            type="button"
            aria-label={t("actions.checkAgain", { ns: "common" })}
            title={t("actions.checkAgain", { ns: "common" })}
            onClick={(e) => {
              e.stopPropagation();
              props.onRefresh?.();
            }}
          >
            <span className="badge-label">
              {available
                ? t("status.ready", { ns: "common" })
                : t("status.notAvailable", { ns: "common" })}
            </span>
            <span className="badge-hover-action">
              <ArrowsClockwise size={13} aria-hidden="true" />
            </span>
          </button>
        )}
      </header>

      <div className="runtime-summary-models" aria-label={t("runtimes.models", { ns: "settings" })}>
        {isProbing ? (
          <span>{t("actions.checking", { ns: "common" })}</span>
        ) : models === undefined ? (
          <span>{t("runtimes.catalogUnavailable", { ns: "settings" })}</span>
        ) : showModelConfigurationLink ? (
          <button
            className="text-button runtime-models-link"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onNavigateToModels();
            }}
          >
            {t("runtimes.configureModels", { ns: "settings" })}
          </button>
        ) : (
          <span>{t("counts.model", { ns: "common", count: models.length })}</span>
        )}
      </div>
    </article>
  );
}

export function RuntimeEnvironmentsFragment(props: { readonly onNavigateToModels: () => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const [runtimes, setRuntimes] = useState<readonly DesktopRuntimeAvailability[]>(INITIAL_RUNTIMES);
  const [probingIds, setProbingIds] = useState<ReadonlySet<string>>(
    () => new Set(INITIAL_RUNTIMES.map((runtime) => runtime.id)),
  );
  const [selectedRuntimeId, setSelectedRuntimeId] = useState<string>();
  const [error, setError] = useState<string | null>(null);

  const loadRuntimes = async (targetId?: string, forceRefresh = false) => {
    setError(null);
    if (targetId !== undefined) {
      setProbingIds((prev) => new Set([...prev, targetId]));
    } else {
      setProbingIds(new Set(runtimes.map((runtime) => runtime.id)));
    }

    try {
      const freshResults = await window.pragmaDesktop.getRuntimeAvailability({
        ...(targetId === undefined ? {} : { runtimeId: targetId }),
        forceRefresh,
      });

      setRuntimes((currentRuntimes) => {
        const freshMap = new Map(freshResults.map((item) => [item.id, item]));
        const merged = currentRuntimes.map((existing) => freshMap.get(existing.id) ?? existing);
        for (const freshItem of freshResults) {
          if (!merged.some((item) => item.id === freshItem.id)) {
            merged.push(freshItem);
          }
        }
        return merged;
      });
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      if (targetId !== undefined) {
        setProbingIds((prev) => {
          const next = new Set(prev);
          next.delete(targetId);
          return next;
        });
      } else {
        setProbingIds(new Set());
      }
    }
  };

  useEffect(() => {
    void loadRuntimes(undefined, false);
  }, []);

  const selectedRuntime = runtimes.find((runtime) => runtime.id === selectedRuntimeId);
  const isGlobalChecking = probingIds.size > 0;

  if (selectedRuntime !== undefined) {
    return (
      <RuntimeEnvironmentDetail
        runtime={selectedRuntime}
        refreshing={probingIds.has(selectedRuntime.id)}
        error={error}
        onBack={() => setSelectedRuntimeId(undefined)}
        onRefresh={() => void loadRuntimes(selectedRuntime.id, true)}
        onNavigateToModels={props.onNavigateToModels}
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
            onClick={() => void loadRuntimes(undefined, true)}
            disabled={isGlobalChecking}
          >
            {isGlobalChecking
              ? t("actions.checking", { ns: "common" })
              : t("actions.checkAgain", { ns: "common" })}
          </button>
        </header>
      }
    >
      <section className="runtime-section" aria-labelledby="local-runtimes-heading">
        <div className="runtime-list">
          {runtimes.map((runtime) => (
            <RuntimeCard
              key={runtime.id}
              runtime={runtime}
              isProbing={probingIds.has(runtime.id)}
              onOpen={() => setSelectedRuntimeId(runtime.id)}
              onRefresh={() => void loadRuntimes(runtime.id, true)}
              onNavigateToModels={props.onNavigateToModels}
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
