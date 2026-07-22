import { CaretDown, FolderOpen, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  DesktopLocalePreference,
  DesktopRuntimeAvailability,
  DesktopSettingsSnapshot,
  DesktopToolPermissionMode,
} from "../../../../shared/desktop-api.ts";
import { localeDisplayNames, setDesktopLocale } from "../../i18n/index.ts";
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
  const [runtimes, setRuntimes] = useState<readonly DesktopRuntimeAvailability[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.pragmaDesktop.getDesktopSettings(),
      window.pragmaDesktop.getRuntimeAvailability(),
    ])
      .then(([snapshot, availability]) => {
        if (cancelled) return;
        setSettings(snapshot);
        setRuntimes(availability);
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

  const updateRuntime = async (runtimeId: string) => {
    if (runtimeId === runtimes.find((runtime) => runtime.isDefault)?.id) return;
    setSaving(true);
    setError(undefined);
    try {
      const availability = await window.pragmaDesktop.setDefaultRuntime({ runtimeId });
      setRuntimes(availability);
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

  const defaultRuntimeId = runtimes.find((runtime) => runtime.isDefault)?.id ?? "";
  const workspace = settings?.defaultWorkspace ?? "";
  const workspaceName = workspace.split(/[\\/]/).at(-1);

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
        <label className="setting-row general-language-setting">
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
          <span className="protocol-select-shell language-select-shell">
            <select
              value={settings?.localePreference ?? "system"}
              disabled={settings === undefined || saving}
              onChange={(event) =>
                void updateLanguage(event.target.value as DesktopLocalePreference)
              }
            >
              <option value="system">{t("general.followSystem", { ns: "settings" })}</option>
              {languageOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <CaretDown size={17} weight="bold" aria-hidden="true" />
          </span>
        </label>
        <label className="setting-row general-language-setting">
          <span className="setting-copy">
            <strong>{t("general.runtime", { ns: "settings" })}</strong>
            <span>{t("general.runtimeDescription", { ns: "settings" })}</span>
          </span>
          <span className="protocol-select-shell language-select-shell">
            <select
              value={defaultRuntimeId}
              disabled={runtimes.length === 0 || saving}
              onChange={(event) => void updateRuntime(event.target.value)}
            >
              {runtimes.map((runtime) => (
                <option
                  key={runtime.id}
                  value={runtime.id}
                  disabled={runtime.status !== "available"}
                >
                  {runtime.displayName}
                  {runtime.status === "available"
                    ? ""
                    : ` · ${t("status.unavailable", { ns: "common" })}`}
                </option>
              ))}
            </select>
            <CaretDown size={17} weight="bold" aria-hidden="true" />
          </span>
        </label>
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
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsScreenFrame>
  );
}
