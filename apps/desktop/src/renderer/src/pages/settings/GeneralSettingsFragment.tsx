import { FolderOpen, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  ContextStoreRevisionProfile,
  DesktopLocalePreference,
  DesktopRuntimeAvailability,
  DesktopSettingsSnapshot,
  DesktopToolPermissionMode,
  SkillEvaluationProfile,
} from "../../../../shared/contracts/index.ts";
import { localeDisplayNames, setDesktopLocale } from "../../i18n/index.ts";
import { SelectMenu, type SelectMenuOption } from "../../components/SelectMenu.tsx";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

const languageOptions: readonly {
  readonly value: DesktopLocalePreference;
  readonly label: string;
}[] = [
  { value: "en", label: "English" },
  { value: "zh-Hans", label: "简体中文" },
  { value: "zh-Hant", label: "繁體中文" },
];

export function GeneralSettingsFragment() {
  const { t } = useTranslation(["settings", "common"]);
  const [settings, setSettings] = useState<DesktopSettingsSnapshot>();
  const [revisionAgent, setRevisionAgent] = useState<ContextStoreRevisionProfile>();
  const [evaluationAgent, setEvaluationAgent] = useState<SkillEvaluationProfile>();
  const [runtimes, setRuntimes] = useState<readonly DesktopRuntimeAvailability[]>([]);
  const [revisionRuntimeId, setRevisionRuntimeId] = useState("");
  const [revisionModelKey, setRevisionModelKey] = useState("");
  const [evaluationRuntimeId, setEvaluationRuntimeId] = useState("");
  const [evaluationModelKey, setEvaluationModelKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void window.pragmaDesktop
      .getDesktopSettings()
      .then((snapshot) => {
        if (cancelled) return;
        setSettings(snapshot);
      })
      .catch(() => {
        if (!cancelled) setError(t("general.saveError", { ns: "settings" }));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.pragmaDesktop.getContextStoreRevisionProfile(),
      window.pragmaDesktop.getSkillEvaluationProfile(),
      window.pragmaDesktop.getRuntimeAvailability(),
    ])
      .then(([profile, evaluationProfile, availableRuntimes]) => {
        if (cancelled) return;
        setRevisionAgent(profile);
        setEvaluationAgent(evaluationProfile);
        setRuntimes(availableRuntimes);
        setRevisionRuntimeId(
          profile.model?.runtimeId ??
            availableRuntimes.find((runtime) => runtime.isDefault)?.id ??
            "",
        );
        setRevisionModelKey(
          profile.model === undefined
            ? ""
            : `${profile.model.providerId}\0${profile.model.modelId}`,
        );
        setEvaluationRuntimeId(
          evaluationProfile.model?.runtimeId ??
            availableRuntimes.find((runtime) => runtime.isDefault)?.id ??
            "",
        );
        setEvaluationModelKey(
          evaluationProfile.model === undefined
            ? ""
            : `${evaluationProfile.model.providerId}\0${evaluationProfile.model.modelId}`,
        );
      })
      .catch(() => {
        if (!cancelled) setError(t("general.saveError", { ns: "settings" }));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const updateLanguage = async (localePreference: DesktopLocalePreference) => {
    if (settings === undefined || localePreference === settings.localePreference) return;
    setSaving(true);
    setError(undefined);
    try {
      const snapshot = await window.pragmaDesktop.updateDesktopSettings({ localePreference });
      await setDesktopLocale(snapshot.resolvedLocale);
      setSettings(snapshot);
    } catch {
      setError(t("general.saveError", { ns: "settings" }));
    } finally {
      setSaving(false);
    }
  };

  const updateToolPermissionMode = async (toolPermissionMode: DesktopToolPermissionMode) => {
    if (settings === undefined || toolPermissionMode === settings.toolPermissionMode) return;
    setSaving(true);
    setError(undefined);
    try {
      setSettings(await window.pragmaDesktop.updateDesktopSettings({ toolPermissionMode }));
    } catch {
      setError(t("general.saveError", { ns: "settings" }));
    } finally {
      setSaving(false);
    }
  };

  const chooseWorkspace = async () => {
    if (settings === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await window.pragmaDesktop.pickWorkspace();
      if (!result.ok || result.path === undefined) return;
      if (result.path === settings.defaultWorkspace) return;
      setSettings(
        await window.pragmaDesktop.updateDesktopSettings({ defaultWorkspace: result.path }),
      );
    } catch {
      setError(t("general.saveError", { ns: "settings" }));
    } finally {
      setSaving(false);
    }
  };

  const restoreDefaultWorkspace = async () => {
    if (settings === undefined || settings.usesBuiltInDefaultWorkspace) return;
    setSaving(true);
    setError(undefined);
    try {
      setSettings(await window.pragmaDesktop.updateDesktopSettings({ defaultWorkspace: null }));
    } catch {
      setError(t("general.saveError", { ns: "settings" }));
    } finally {
      setSaving(false);
    }
  };

  const updateRevisionAgent = async (
    mode: "inherit-default" | "pinned",
    model?: { readonly runtimeId: string; readonly providerId: string; readonly modelId: string },
  ) => {
    if (revisionAgent === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      setRevisionAgent(
        await window.pragmaDesktop.updateContextStoreRevisionProfile({
          expectedRevision: revisionAgent.revision,
          mode,
          ...(model === undefined ? {} : { model }),
        }),
      );
    } catch {
      setError(t("general.saveError", { ns: "settings" }));
    } finally {
      setSaving(false);
    }
  };

  const workspace = settings?.defaultWorkspace ?? "";
  const workspaceName = workspace.split(/[\\/]/).at(-1);
  const selectedRevisionRuntime = runtimes.find((runtime) => runtime.id === revisionRuntimeId);
  const selectedEvaluationRuntime = runtimes.find((runtime) => runtime.id === evaluationRuntimeId);

  const updateEvaluationAgent = async (
    mode: "inherit-default" | "pinned",
    model?: { readonly runtimeId: string; readonly providerId: string; readonly modelId: string },
  ) => {
    if (evaluationAgent === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      setEvaluationAgent(
        await window.pragmaDesktop.updateSkillEvaluationProfile({
          expectedRevision: evaluationAgent.revision,
          mode,
          ...(model === undefined ? {} : { model }),
        }),
      );
    } catch {
      setError(t("general.saveError", { ns: "settings" }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsScreenFrame
      id="general-panel"
      labelledBy="general-panel-heading"
      header={
        <header className="panel-heading">
          <h2 id="general-panel-heading">{t("general.title", { ns: "settings" })}</h2>
          <p>{t("general.description", { ns: "settings" })}</p>
        </header>
      }
    >
      <div className="general-settings-list">
        <div className="setting-row general-language-setting">
          <span className="setting-copy">
            <strong>{t("general.language", { ns: "settings" })}</strong>
            <span>{t("general.languageDescription", { ns: "settings" })}</span>
            {settings?.localePreference === "system" ? (
              <small>
                {t("general.resolvedAs", {
                  ns: "settings",
                  language: localeDisplayNames[settings.resolvedLocale],
                })}
              </small>
            ) : null}
          </span>
          <SelectMenu<DesktopLocalePreference>
            ariaLabel={t("general.language", { ns: "settings" })}
            className="settings-select language-settings-select"
            value={settings?.localePreference ?? "system"}
            disabled={settings === undefined || saving}
            placement="bottom"
            options={
              [
                { value: "system", label: t("general.followSystem", { ns: "settings" }) },
                ...languageOptions,
              ] satisfies readonly SelectMenuOption<DesktopLocalePreference>[]
            }
            onChange={(value) => void updateLanguage(value)}
          />
        </div>
        <div className="setting-row tool-permission-setting">
          <span className="setting-copy">
            <strong>{t("general.toolPermissions", { ns: "settings" })}</strong>
            <span>{t("general.toolPermissionsDescription", { ns: "settings" })}</span>
          </span>
          <span
            className="tool-permission-options"
            role="radiogroup"
            aria-label={t("general.toolPermissions", { ns: "settings" })}
          >
            {(["request-approval", "auto-approve", "full-access"] as const).map((mode) => (
              <label key={mode}>
                <input
                  type="radio"
                  name="tool-permission-mode"
                  value={mode}
                  checked={(settings?.toolPermissionMode ?? "request-approval") === mode}
                  disabled={settings === undefined || saving}
                  onChange={() => void updateToolPermissionMode(mode)}
                />
                <span>
                  <strong>
                    {t(`general.toolPermissionModes.${mode}.label`, { ns: "settings" })}
                  </strong>
                  <small>
                    {t(`general.toolPermissionModes.${mode}.description`, { ns: "settings" })}
                  </small>
                </span>
              </label>
            ))}
          </span>
        </div>
        <div className="setting-row general-workspace-setting">
          <span className="setting-copy">
            <strong>{t("general.defaultWorkspace", { ns: "settings" })}</strong>
            <span>{t("general.defaultWorkspaceDescription", { ns: "settings" })}</span>
            {workspace === "" ? null : <small>{workspace}</small>}
          </span>
          <span className="general-workspace-controls">
            <button
              className="general-workspace-picker"
              type="button"
              disabled={settings === undefined || saving}
              title={workspace}
              onClick={() => void chooseWorkspace()}
            >
              <FolderOpen size={17} aria-hidden="true" />
              {workspace === ""
                ? t("general.chooseWorkspace", { ns: "settings" })
                : (workspaceName ?? workspace)}
            </button>
            {settings?.usesBuiltInDefaultWorkspace === false ? (
              <button
                className="general-workspace-clear"
                type="button"
                disabled={saving}
                aria-label={t("general.restoreDefaultWorkspace", { ns: "settings" })}
                title={t("general.restoreDefaultWorkspace", { ns: "settings" })}
                onClick={() => void restoreDefaultWorkspace()}
              >
                <X size={16} aria-hidden="true" />
              </button>
            ) : null}
          </span>
        </div>
        <div className="setting-row revision-agent-mode-setting">
          <span className="setting-copy">
            <strong>{t("general.revisionAgent", { ns: "settings" })}</strong>
            <span>{t("general.revisionAgentDescription", { ns: "settings" })}</span>
          </span>
          <SelectMenu<"inherit-default" | "pinned">
            ariaLabel={t("general.revisionAgent", { ns: "settings" })}
            className="settings-select revision-agent-settings-select"
            value={revisionAgent?.mode ?? "inherit-default"}
            disabled={revisionAgent === undefined || saving}
            placement="bottom"
            options={[
              {
                value: "inherit-default",
                label: t("general.revisionAgentInherit", { ns: "settings" }),
              },
              {
                value: "pinned",
                label: t("general.revisionAgentPinned", { ns: "settings" }),
              },
            ]}
            onChange={(mode) => {
              if (mode === "inherit-default") void updateRevisionAgent(mode);
              else
                setRevisionAgent((current) =>
                  current === undefined ? current : { ...current, mode: "pinned" },
                );
            }}
          />
        </div>
        {revisionAgent?.mode !== "pinned" ? null : (
          <div className="revision-agent-pinned-settings">
            <div className="setting-row revision-agent-runtime-setting">
              <span className="setting-copy">
                <strong>{t("general.revisionAgentRuntime", { ns: "settings" })}</strong>
                <span>{t("general.revisionAgentRuntimeDescription", { ns: "settings" })}</span>
              </span>
              <SelectMenu
                ariaLabel={t("general.revisionAgentRuntime", { ns: "settings" })}
                className="settings-select revision-agent-settings-select"
                value={revisionRuntimeId}
                disabled={saving}
                placement="bottom"
                options={runtimes
                  .filter((runtime) => runtime.status === "available")
                  .map((runtime) => ({ value: runtime.id, label: runtime.displayName }))}
                onChange={(value) => {
                  setRevisionRuntimeId(value);
                  setRevisionModelKey("");
                }}
              />
            </div>
            <div className="setting-row revision-agent-model-setting">
              <span className="setting-copy">
                <strong>{t("general.revisionAgentModel", { ns: "settings" })}</strong>
                <span>{t("general.revisionAgentModelDescription", { ns: "settings" })}</span>
              </span>
              <SelectMenu
                ariaLabel={t("general.revisionAgentModel", { ns: "settings" })}
                className="settings-select revision-agent-settings-select"
                value={revisionModelKey}
                disabled={saving || revisionRuntimeId === ""}
                emptyLabel={t("general.revisionAgentChooseModel", { ns: "settings" })}
                placement="bottom"
                options={[
                  {
                    value: "",
                    label: t("general.revisionAgentChooseModel", { ns: "settings" }),
                    disabled: true,
                  },
                  ...(selectedRevisionRuntime?.models ?? []).map((model) => ({
                    value: `${model.provider.id}\0${model.id}`,
                    label: `${model.provider.displayName} · ${model.displayName}`,
                  })),
                ]}
                onChange={setRevisionModelKey}
              />
            </div>
            <div className="setting-row revision-agent-save-setting">
              <span className="setting-copy">
                <strong>{t("general.revisionAgentSave", { ns: "settings" })}</strong>
                <span>{t("general.revisionAgentSaveDescription", { ns: "settings" })}</span>
              </span>
              <button
                className="secondary-button"
                type="button"
                disabled={saving || revisionRuntimeId === "" || revisionModelKey === ""}
                onClick={() => {
                  const [providerId, modelId] = revisionModelKey.split("\0");
                  if (providerId !== undefined && modelId !== undefined) {
                    void updateRevisionAgent("pinned", {
                      runtimeId: revisionRuntimeId,
                      providerId,
                      modelId,
                    });
                  }
                }}
              >
                {t("general.revisionAgentSave", { ns: "settings" })}
              </button>
            </div>
          </div>
        )}
        <div className="setting-row revision-agent-mode-setting">
          <span className="setting-copy">
            <strong>{t("general.evaluationAgent", { ns: "settings" })}</strong>
            <span>{t("general.evaluationAgentDescription", { ns: "settings" })}</span>
          </span>
          <SelectMenu<"inherit-default" | "pinned">
            ariaLabel={t("general.evaluationAgent", { ns: "settings" })}
            className="settings-select revision-agent-settings-select"
            value={evaluationAgent?.mode ?? "inherit-default"}
            disabled={evaluationAgent === undefined || saving}
            placement="bottom"
            options={[
              {
                value: "inherit-default",
                label: t("general.revisionAgentInherit", { ns: "settings" }),
              },
              { value: "pinned", label: t("general.revisionAgentPinned", { ns: "settings" }) },
            ]}
            onChange={(mode) => {
              if (mode === "inherit-default") void updateEvaluationAgent(mode);
              else
                setEvaluationAgent((current) =>
                  current === undefined ? current : { ...current, mode: "pinned" },
                );
            }}
          />
        </div>
        {evaluationAgent?.mode !== "pinned" ? null : (
          <div className="revision-agent-pinned-settings">
            <div className="setting-row revision-agent-runtime-setting">
              <span className="setting-copy">
                <strong>{t("general.evaluationAgentRuntime", { ns: "settings" })}</strong>
                <span>{t("general.evaluationAgentRuntimeDescription", { ns: "settings" })}</span>
              </span>
              <SelectMenu
                ariaLabel={t("general.evaluationAgentRuntime", { ns: "settings" })}
                className="settings-select revision-agent-settings-select"
                value={evaluationRuntimeId}
                disabled={saving}
                placement="bottom"
                options={runtimes
                  .filter((runtime) => runtime.status === "available")
                  .map((runtime) => ({ value: runtime.id, label: runtime.displayName }))}
                onChange={(value) => {
                  setEvaluationRuntimeId(value);
                  setEvaluationModelKey("");
                }}
              />
            </div>
            <div className="setting-row revision-agent-model-setting">
              <span className="setting-copy">
                <strong>{t("general.evaluationAgentModel", { ns: "settings" })}</strong>
                <span>{t("general.evaluationAgentModelDescription", { ns: "settings" })}</span>
              </span>
              <SelectMenu
                ariaLabel={t("general.evaluationAgentModel", { ns: "settings" })}
                className="settings-select revision-agent-settings-select"
                value={evaluationModelKey}
                disabled={saving || evaluationRuntimeId === ""}
                emptyLabel={t("general.revisionAgentChooseModel", { ns: "settings" })}
                placement="bottom"
                options={[
                  {
                    value: "",
                    label: t("general.revisionAgentChooseModel", { ns: "settings" }),
                    disabled: true,
                  },
                  ...(selectedEvaluationRuntime?.models ?? []).map((model) => ({
                    value: `${model.provider.id}\0${model.id}`,
                    label: `${model.provider.displayName} · ${model.displayName}`,
                  })),
                ]}
                onChange={setEvaluationModelKey}
              />
            </div>
            <div className="setting-row revision-agent-save-setting">
              <span className="setting-copy">
                <strong>{t("general.evaluationAgentSave", { ns: "settings" })}</strong>
                <span>{t("general.evaluationAgentSaveDescription", { ns: "settings" })}</span>
              </span>
              <button
                className="secondary-button"
                type="button"
                disabled={saving || evaluationRuntimeId === "" || evaluationModelKey === ""}
                onClick={() => {
                  const [providerId, modelId] = evaluationModelKey.split("\0");
                  if (providerId !== undefined && modelId !== undefined)
                    void updateEvaluationAgent("pinned", {
                      runtimeId: evaluationRuntimeId,
                      providerId,
                      modelId,
                    });
                }}
              >
                {t("general.evaluationAgentSave", { ns: "settings" })}
              </button>
            </div>
          </div>
        )}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsScreenFrame>
  );
}
