import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  DesktopRuntimeAvailability,
  EvaluationQueueSettings,
} from "../../../../shared/contracts/index.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

export function EvaluationSettingsFragment() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<EvaluationQueueSettings>();
  const [runtimes, setRuntimes] = useState<readonly DesktopRuntimeAvailability[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const updating = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.pragmaDesktop.getEvaluationQueueSettings(),
      window.pragmaDesktop.getRuntimeAvailability(),
    ])
      .then(([nextSettings, nextRuntimes]) => {
        if (cancelled) return;
        setSettings(nextSettings);
        setRuntimes(nextRuntimes);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const models = useMemo(
    () =>
      runtimes.flatMap((runtime) =>
        runtime.status !== "available"
          ? []
          : (runtime.models ?? []).map((model) => ({
              value: `${runtime.id}\0${model.provider.id}\0${model.id}`,
              label: `${runtime.displayName} · ${model.provider.displayName} · ${model.displayName}`,
            })),
      ),
    [runtimes],
  );
  const judgeModelKey =
    settings?.judge.mode === "pinned"
      ? `${settings.judge.model.runtimeId}\0${settings.judge.model.providerId}\0${settings.judge.model.modelId}`
      : "";

  const update = async (change: {
    readonly concurrency?: number;
    readonly judge?: EvaluationQueueSettings["judge"];
  }) => {
    if (settings === undefined || updating.current) return;
    updating.current = true;
    setSaving(true);
    setError(undefined);
    try {
      setSettings(
        await window.pragmaDesktop.updateEvaluationQueueSettings({
          expectedRevision: settings.revision,
          ...change,
        }),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      updating.current = false;
      setSaving(false);
    }
  };

  return (
    <SettingsScreenFrame
      id="evaluations-panel"
      labelledBy="evaluations-panel-heading"
      header={
        <header className="panel-heading">
          <h2 id="evaluations-panel-heading">{t("evaluations.title")}</h2>
          <p>{t("evaluations.description")}</p>
        </header>
      }
    >
      <div className="general-settings-list evaluation-settings-list">
        <div className="setting-row evaluation-judge-setting">
          <span className="setting-copy">
            <strong>{t("evaluations.judgeModel")}</strong>
            <span>{t("evaluations.judgeModelDescription")}</span>
          </span>
          <SelectMenu
            ariaLabel={t("evaluations.judgeModel")}
            className="settings-select evaluation-settings-select"
            value={judgeModelKey}
            disabled={settings === undefined || saving}
            placement="bottom"
            options={[{ value: "", label: t("evaluations.inheritDefault") }, ...models]}
            onChange={(key) => {
              if (key === "") {
                void update({ judge: { mode: "inherit-default" } });
                return;
              }
              const [runtimeId, providerId, modelId] = key.split("\0");
              if (runtimeId !== undefined && providerId !== undefined && modelId !== undefined) {
                void update({
                  judge: { mode: "pinned", model: { runtimeId, providerId, modelId } },
                });
              }
            }}
          />
        </div>
        <div className="setting-row evaluation-concurrency-setting">
          <span className="setting-copy">
            <strong>{t("evaluations.concurrency")}</strong>
            <span>{t("evaluations.concurrencyDescription")}</span>
          </span>
          <SelectMenu
            ariaLabel={t("evaluations.concurrency")}
            className="settings-select evaluation-concurrency-select"
            value={String(settings?.concurrency ?? 3)}
            disabled={settings === undefined || saving}
            placement="bottom"
            options={Array.from({ length: 16 }, (_, index) => ({
              value: String(index + 1),
              label: String(index + 1),
            }))}
            onChange={(value) => void update({ concurrency: Number(value) })}
          />
        </div>
        <aside className="evaluation-settings-note">
          <strong>{t("evaluations.slotTitle")}</strong>
          <p>{t("evaluations.slotDescription")}</p>
        </aside>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsScreenFrame>
  );
}
