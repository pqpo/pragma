import { useEffect, useRef, useState } from "react";
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
  const [judgeMode, setJudgeMode] =
    useState<EvaluationQueueSettings["judge"]["mode"]>("inherit-default");
  const [runtimeId, setRuntimeId] = useState("");
  const [modelKey, setModelKey] = useState("");
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
        setJudgeMode(nextSettings.judge.mode);
        if (nextSettings.judge.mode === "pinned") {
          setRuntimeId(nextSettings.judge.model.runtimeId);
          setModelKey(
            `${nextSettings.judge.model.providerId}\0${nextSettings.judge.model.modelId}`,
          );
        }
        setRuntimes(nextRuntimes);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedRuntime = runtimes.find((runtime) => runtime.id === runtimeId);
  const models = selectedRuntime?.status === "available" ? (selectedRuntime.models ?? []) : [];

  const update = async (change: {
    readonly concurrency?: number;
    readonly judge?: EvaluationQueueSettings["judge"];
  }) => {
    if (settings === undefined || updating.current) return false;
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
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
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
            value={judgeMode}
            disabled={settings === undefined || saving}
            placement="bottom"
            options={[
              { value: "inherit-default", label: t("evaluations.inheritDefault") },
              { value: "pinned", label: t("evaluations.pinnedModel") },
            ]}
            onChange={(mode) => {
              if (mode === judgeMode) return;
              if (mode === "pinned") {
                setRuntimeId("");
                setModelKey("");
                setJudgeMode(mode);
              } else {
                void update({ judge: { mode } }).then((saved) => {
                  if (saved) setJudgeMode(mode);
                });
              }
            }}
          />
        </div>
        {judgeMode === "pinned" ? (
          <>
            <div className="setting-row evaluation-judge-setting">
              <span className="setting-copy">
                <strong>{t("evaluations.judgeRuntime")}</strong>
                <span>{t("evaluations.judgeRuntimeDescription")}</span>
              </span>
              <SelectMenu
                ariaLabel={t("evaluations.judgeRuntime")}
                className="settings-select evaluation-settings-select"
                value={runtimeId}
                disabled={settings === undefined || saving}
                placement="bottom"
                options={[
                  { value: "", label: t("evaluations.chooseRuntime") },
                  ...runtimes
                    .filter((runtime) => runtime.status === "available")
                    .map((runtime) => ({ value: runtime.id, label: runtime.displayName })),
                ]}
                onChange={(value) => {
                  if (value === runtimeId) return;
                  setRuntimeId(value);
                  setModelKey("");
                }}
              />
            </div>
            <div className="setting-row evaluation-judge-setting">
              <span className="setting-copy">
                <strong>{t("evaluations.judgePinnedModel")}</strong>
                <span>{t("evaluations.judgePinnedModelDescription")}</span>
              </span>
              <SelectMenu
                ariaLabel={t("evaluations.judgePinnedModel")}
                className="settings-select evaluation-settings-select"
                value={modelKey}
                disabled={
                  settings === undefined || saving || selectedRuntime?.status !== "available"
                }
                placement="bottom"
                options={[
                  { value: "", label: t("evaluations.chooseModel") },
                  ...models.map((model) => ({
                    value: `${model.provider.id}\0${model.id}`,
                    label: `${model.provider.displayName} · ${model.displayName}`,
                  })),
                ]}
                onChange={(value) => {
                  const model = models.find(
                    (candidate) => `${candidate.provider.id}\0${candidate.id}` === value,
                  );
                  if (model === undefined) return;
                  void update({
                    judge: {
                      mode: "pinned",
                      model: { runtimeId, providerId: model.provider.id, modelId: model.id },
                    },
                  }).then((saved) => {
                    if (saved) setModelKey(value);
                  });
                }}
              />
            </div>
          </>
        ) : null}
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
