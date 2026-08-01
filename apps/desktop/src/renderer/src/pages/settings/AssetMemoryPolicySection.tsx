import { CaretDown } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  DesktopAssetMemoryPolicySnapshot,
  DesktopMemoryPolicyTarget,
} from "../../../../shared/contracts/index.ts";

export function AssetMemoryPolicySection(props: {
  readonly targetRef: DesktopMemoryPolicyTarget;
  readonly compact?: boolean | undefined;
}) {
  const { t } = useTranslation("settings");
  const [snapshot, setSnapshot] = useState<DesktopAssetMemoryPolicySnapshot>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const targetType = props.targetRef.type;
  const targetId = props.targetRef.id;

  useEffect(() => {
    let cancelled = false;
    setSnapshot(undefined);
    setError(undefined);
    void window.pragmaDesktop
      .getAssetMemoryPolicy({ targetRef: { type: targetType, id: targetId } })
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch(() => {
        if (!cancelled) setError(t("memory.loadError"));
      });
    return () => {
      cancelled = true;
    };
  }, [t, targetId, targetType]);

  const update = async (policy: DesktopAssetMemoryPolicySnapshot["policy"]) => {
    if (snapshot === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      setSnapshot(
        await window.pragmaDesktop.updateAssetMemoryPolicy({
          targetRef: props.targetRef,
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
    <section className={props.compact ? "asset-memory-policy is-compact" : "asset-memory-policy"}>
      <div className="asset-memory-policy-heading">
        <div>
          <h3>{t("memory.assetTitle")}</h3>
          <p>{t("memory.assetDescription")}</p>
        </div>
        {snapshot === undefined ? null : (
          <span className="memory-effective-summary">
            {t("memory.effectiveSummary", {
              capture: t(`memory.states.${snapshot.effective.capture ? "enabled" : "disabled"}`),
              recall: t(`memory.states.${snapshot.effective.recall ? "enabled" : "disabled"}`),
              learning: t(`memory.learningStates.${snapshot.effective.learning}`),
            })}
          </span>
        )}
      </div>
      <div className="asset-memory-policy-fields">
        <OverrideSelect
          label={t("memory.capture")}
          value={snapshot?.policy.capture ?? "inherit"}
          disabled={snapshot === undefined || saving}
          options={["inherit", "enabled", "disabled"]}
          onChange={(capture) => void update({ ...snapshot!.policy, capture })}
        />
        <OverrideSelect
          label={t("memory.recall")}
          value={snapshot?.policy.recall ?? "inherit"}
          disabled={snapshot === undefined || saving}
          options={["inherit", "enabled", "disabled"]}
          onChange={(recall) => void update({ ...snapshot!.policy, recall })}
        />
        <OverrideSelect
          label={t("memory.learning")}
          value={snapshot?.policy.learning ?? "inherit"}
          disabled={snapshot === undefined || saving}
          options={["inherit", "local-candidates", "disabled"]}
          onChange={(learning) => void update({ ...snapshot!.policy, learning })}
        />
      </div>
      {error === undefined ? null : <p className="form-error">{error}</p>}
    </section>
  );
}

function OverrideSelect<T extends "inherit" | "enabled" | "disabled" | "local-candidates">(props: {
  readonly label: string;
  readonly value: T;
  readonly disabled: boolean;
  readonly options: readonly T[];
  readonly onChange: (value: T) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <label>
      <span>{props.label}</span>
      <span className="protocol-select-shell">
        <select
          value={props.value}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value as T)}
        >
          {props.options.map((value) => (
            <option key={value} value={value}>
              {t(`memory.overrideStates.${value}`)}
            </option>
          ))}
        </select>
        <CaretDown size={15} weight="bold" aria-hidden="true" />
      </span>
    </label>
  );
}
