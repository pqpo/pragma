import { CaretDown } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  DesktopGlobalMemoryPolicySnapshot,
  DesktopMemoryPlaneStatus,
} from "../../../../shared/contracts/index.ts";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

export function MemorySettingsFragment() {
  const { t } = useTranslation("settings");
  const [snapshot, setSnapshot] = useState<DesktopGlobalMemoryPolicySnapshot>();
  const [status, setStatus] = useState<DesktopMemoryPlaneStatus>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.pragmaDesktop.getGlobalMemoryPolicy(),
      window.pragmaDesktop.getMemoryPlaneStatus(),
    ])
      .then(([nextSnapshot, nextStatus]) => {
        if (cancelled) return;
        setSnapshot(nextSnapshot);
        setStatus(nextStatus);
      })
      .catch(() => {
        if (!cancelled) setError(t("memory.loadError"));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const update = async (policy: DesktopGlobalMemoryPolicySnapshot["policy"]) => {
    if (snapshot === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      setSnapshot(
        await window.pragmaDesktop.updateGlobalMemoryPolicy({
          expectedRevision: snapshot.revision,
          policy,
        }),
      );
    } catch {
      setError(t("memory.saveError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsScreenFrame
      id="memory-panel"
      labelledBy="memory-panel-heading"
      header={
        <header className="panel-heading">
          <h2 id="memory-panel-heading">{t("memory.title")}</h2>
          <p>{t("memory.description")}</p>
        </header>
      }
    >
      <div className="general-settings-list">
        <MemoryGlobalSwitch
          label={t("memory.capture")}
          description={t("memory.captureDescription")}
          value={snapshot?.policy.capture ?? "enabled"}
          disabled={snapshot === undefined || saving}
          onChange={(capture) => void update({ ...snapshot!.policy, capture })}
        />
        <MemoryGlobalSwitch
          label={t("memory.recall")}
          description={t("memory.recallDescription")}
          value={snapshot?.policy.recall ?? "enabled"}
          disabled={snapshot === undefined || saving}
          onChange={(recall) => void update({ ...snapshot!.policy, recall })}
        />
        <MemorySelectRow
          label={t("memory.learning")}
          description={t("memory.learningDescription")}
          value={snapshot?.policy.learning ?? "local-candidates"}
          disabled={snapshot === undefined || saving}
          options={[
            ["local-candidates", t("memory.localCandidates")],
            ["disabled", t("memory.disabled")],
          ]}
          onChange={(learning) => void update({ ...snapshot!.policy, learning })}
        />
        <div className="setting-row memory-health-setting">
          <span className="setting-copy">
            <strong>{t("memory.health")}</strong>
            <span>{t("memory.healthDescription")}</span>
            {status === undefined ? null : (
              <small>
                {t("memory.healthSummary", {
                  state: t(`memory.states.${status.state}`),
                  events: status.feed.eventCount,
                  modules: status.modules.length,
                  pending: status.delivery.pending,
                  quarantined: status.delivery.quarantined,
                })}
              </small>
            )}
          </span>
          <span className={`memory-health-badge is-${status?.state ?? "loading"}`}>
            {status === undefined ? t("memory.loading") : t(`memory.states.${status.state}`)}
          </span>
        </div>
      </div>
      {error === undefined ? null : <p className="form-error">{error}</p>}
    </SettingsScreenFrame>
  );
}

function MemoryGlobalSwitch(props: {
  readonly label: string;
  readonly description: string;
  readonly value: "enabled" | "disabled";
  readonly disabled: boolean;
  readonly onChange: (value: "enabled" | "disabled") => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <MemorySelectRow
      {...props}
      options={[
        ["enabled", t("memory.enabled")],
        ["disabled", t("memory.disabled")],
      ]}
    />
  );
}

function MemorySelectRow<T extends string>(props: {
  readonly label: string;
  readonly description: string;
  readonly value: T;
  readonly disabled: boolean;
  readonly options: readonly (readonly [T, string])[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <label className="setting-row general-language-setting">
      <span className="setting-copy">
        <strong>{props.label}</strong>
        <span>{props.description}</span>
      </span>
      <span className="protocol-select-shell language-select-shell">
        <select
          value={props.value}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value as T)}
        >
          {props.options.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <CaretDown size={17} weight="bold" aria-hidden="true" />
      </span>
    </label>
  );
}
