import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  DesktopGlobalMemoryPolicySnapshot,
  DesktopMemoryExtractionSettings,
  DesktopMemoryExtractorProfile,
  DesktopRuntimeAvailability,
} from "../../../../shared/contracts/index.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

export function MemorySettingsFragment() {
  const { t } = useTranslation("settings");
  const [snapshot, setSnapshot] = useState<DesktopGlobalMemoryPolicySnapshot>();
  const [extractor, setExtractor] = useState<DesktopMemoryExtractorProfile>();
  const [extractionSettings, setExtractionSettings] = useState<DesktopMemoryExtractionSettings>();
  const [runtimes, setRuntimes] = useState<readonly DesktopRuntimeAvailability[]>([]);
  const [runtimeId, setRuntimeId] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.pragmaDesktop.getGlobalMemoryPolicy(),
      window.pragmaDesktop.getMemoryExtractorProfile(),
      window.pragmaDesktop.getMemoryExtractionSettings(),
      window.pragmaDesktop.getRuntimeAvailability(),
    ])
      .then(([nextSnapshot, nextExtractor, nextExtractionSettings, nextRuntimes]) => {
        if (cancelled) return;
        setSnapshot(nextSnapshot);
        setExtractor(nextExtractor);
        setExtractionSettings(nextExtractionSettings);
        setRuntimes(nextRuntimes);
        const selectedRuntime =
          nextExtractor.runtimeId ?? nextRuntimes.find((runtime) => runtime.isDefault)?.id ?? "";
        setRuntimeId(selectedRuntime);
        setModelKey(
          nextExtractor.providerId === undefined || nextExtractor.modelId === undefined
            ? ""
            : `${nextExtractor.providerId}\0${nextExtractor.modelId}`,
        );
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

  const updateExtractor = async (
    profile:
      | { readonly mode: "inherit-default" }
      | {
          readonly mode: "pinned";
          readonly runtimeId: string;
          readonly providerId: string;
          readonly modelId: string;
        },
  ) => {
    if (extractor === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      setExtractor(
        await window.pragmaDesktop.updateMemoryExtractorProfile({
          expectedRevision: extractor.revision,
          profile,
        }),
      );
    } catch {
      setError(t("memory.saveError"));
    } finally {
      setSaving(false);
    }
  };

  const updateExtractionSettings = async (
    allowToolAssisted: DesktopMemoryExtractionSettings["allowToolAssisted"],
  ) => {
    if (extractionSettings === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      setExtractionSettings(
        await window.pragmaDesktop.updateMemoryExtractionSettings({
          expectedRevision: extractionSettings.revision,
          allowToolAssisted,
        }),
      );
    } catch {
      setError(t("memory.saveError"));
    } finally {
      setSaving(false);
    }
  };

  const selectedRuntime = runtimes.find((runtime) => runtime.id === runtimeId);
  const models = selectedRuntime?.models ?? [];
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
        <MemoryGlobalSwitch
          label={t("memory.episodicToolAssistedExtraction")}
          description={t("memory.episodicToolAssistedExtractionDescription")}
          value={extractionSettings?.allowToolAssisted.episodic ? "enabled" : "disabled"}
          disabled={extractionSettings === undefined || saving}
          onChange={(value) =>
            void updateExtractionSettings({
              ...extractionSettings!.allowToolAssisted,
              episodic: value === "enabled",
            })
          }
        />
        <MemoryGlobalSwitch
          label={t("memory.semanticToolAssistedExtraction")}
          description={t("memory.semanticToolAssistedExtractionDescription")}
          value={extractionSettings?.allowToolAssisted.semantic ? "enabled" : "disabled"}
          disabled={extractionSettings === undefined || saving}
          onChange={(value) =>
            void updateExtractionSettings({
              ...extractionSettings!.allowToolAssisted,
              semantic: value === "enabled",
            })
          }
        />
        <MemorySelectRow
          label={t("memory.extractorMode")}
          description={t("memory.extractorModeDescription")}
          value={extractor?.mode ?? "inherit-default"}
          disabled={extractor === undefined || saving}
          options={[
            ["inherit-default", t("memory.inheritDefaultModel")],
            ["pinned", t("memory.pinnedModel")],
          ]}
          onChange={(mode) => {
            if (mode === "inherit-default") void updateExtractor({ mode });
            else
              setExtractor((current) =>
                current === undefined ? current : { ...current, mode: "pinned" },
              );
          }}
        />
        {extractor?.mode !== "pinned" ? null : (
          <>
            <MemorySelectRow
              label={t("memory.extractorRuntime")}
              description={t("memory.extractorRuntimeDescription")}
              value={runtimeId}
              disabled={saving}
              options={runtimes
                .filter((runtime) => runtime.status === "available")
                .map((runtime) => [runtime.id, runtime.displayName] as const)}
              onChange={(value) => {
                setRuntimeId(value);
                setModelKey("");
              }}
            />
            <MemorySelectRow
              label={t("memory.extractorModel")}
              description={t("memory.extractorModelDescription")}
              value={modelKey}
              disabled={saving || runtimeId === ""}
              options={models.map(
                (model) =>
                  [
                    `${model.provider.id}\0${model.id}`,
                    `${model.provider.displayName} · ${model.displayName}`,
                  ] as const,
              )}
              onChange={setModelKey}
            />
            <div className="setting-row">
              <span className="setting-copy">
                <strong>{t("memory.saveExtractor")}</strong>
                <span>{t("memory.saveExtractorDescription")}</span>
              </span>
              <button
                type="button"
                className="secondary-button"
                disabled={saving || runtimeId === "" || modelKey === ""}
                onClick={() => {
                  const [providerId, modelId] = modelKey.split("\0");
                  if (providerId !== undefined && modelId !== undefined) {
                    void updateExtractor({ mode: "pinned", runtimeId, providerId, modelId });
                  }
                }}
              >
                {t("memory.saveExtractor")}
              </button>
            </div>
          </>
        )}
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
    <div className="setting-row general-language-setting">
      <span className="setting-copy">
        <strong>{props.label}</strong>
        <span>{props.description}</span>
      </span>
      <SelectMenu<T>
        ariaLabel={props.label}
        className="settings-select language-settings-select"
        value={props.value}
        disabled={props.disabled}
        placement="bottom"
        options={props.options.map(([value, label]) => ({ value, label }))}
        onChange={props.onChange}
      />
    </div>
  );
}
