import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  DesktopGlobalMemoryPolicySnapshot,
  DesktopMemoryExtractorProfile,
  DesktopMemoryPlaneStatus,
  DesktopRuntimeAvailability,
} from "../../../../shared/contracts/index.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

export function MemorySettingsFragment() {
  const { t } = useTranslation("settings");
  const [snapshot, setSnapshot] = useState<DesktopGlobalMemoryPolicySnapshot>();
  const [status, setStatus] = useState<DesktopMemoryPlaneStatus>();
  const [extractor, setExtractor] = useState<DesktopMemoryExtractorProfile>();
  const [runtimes, setRuntimes] = useState<readonly DesktopRuntimeAvailability[]>([]);
  const [runtimeId, setRuntimeId] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.pragmaDesktop.getGlobalMemoryPolicy(),
      window.pragmaDesktop.getMemoryPlaneStatus(),
      window.pragmaDesktop.getMemoryExtractorProfile(),
      window.pragmaDesktop.getRuntimeAvailability(),
    ])
      .then(([nextSnapshot, nextStatus, nextExtractor, nextRuntimes]) => {
        if (cancelled) return;
        setSnapshot(nextSnapshot);
        setStatus(nextStatus);
        setExtractor(nextExtractor);
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
            {status?.lastError === undefined ? null : (
              <small className="form-error" role="alert">
                {t("memory.pipelineError", { code: status.lastError.code })}
              </small>
            )}
            {status?.modules.map((module) =>
              module.work === undefined ? null : (
                <span className="memory-module-status" key={module.moduleId}>
                  <small>
                    {t("memory.moduleWorkSummary", {
                      module: module.moduleId,
                      records: module.work.records,
                      pending: module.work.pending + module.work.running,
                      attention: module.work.needsAttention,
                      rejected: module.work.rejected,
                    })}
                  </small>
                  {module.lastErrorCode === undefined ? null : (
                    <small className="form-error" role="alert">
                      {t("memory.extractionError", { code: module.lastErrorCode })}
                    </small>
                  )}
                </span>
              ),
            )}
          </span>
          <span className={`memory-health-badge is-${status?.state ?? "loading"}`}>
            {status === undefined ? t("memory.loading") : t(`memory.states.${status.state}`)}
          </span>
        </div>
        {status?.storagePolicy === undefined ? null : (
          <div className="setting-row">
            <span className="setting-copy">
              <strong>{t("memory.storageGovernance")}</strong>
              <span>{t("memory.storageGovernanceDescription")}</span>
              <small>
                {t("memory.storageSummary", {
                  events: status.feed.eventCount,
                  logical: formatBytes(status.feed.logicalBytes),
                  file: formatBytes(status.feed.fileBytes),
                  target: formatBytes(status.storagePolicy.canonicalFeedTargetBytes),
                  safe: status.feed.safeThroughSequence,
                  blocked: formatBytes(status.feed.blockedBytes),
                })}
              </small>
              <small>
                {t("memory.retentionSummary", {
                  feedDays: status.storagePolicy.canonicalFeedRetentionDays,
                  jobDays: status.storagePolicy.jobRecordRetentionDays,
                  records: status.storagePolicy.evidenceMaxRecordsPerExecution,
                  bytes: formatBytes(status.storagePolicy.evidenceMaxBytesPerExecution),
                  deadLetters: status.maintenance.deadLetterEntries,
                })}
              </small>
            </span>
          </div>
        )}
      </div>
      {error === undefined ? null : <p className="form-error">{error}</p>}
    </SettingsScreenFrame>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
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
      <SelectMenu<T>
        ariaLabel={props.label}
        className="settings-select language-settings-select"
        value={props.value}
        disabled={props.disabled}
        placement="bottom"
        options={props.options.map(([value, label]) => ({ value, label }))}
        onChange={props.onChange}
      />
    </label>
  );
}
