import { CaretDown } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  DesktopLocalePreference,
  DesktopSettingsSnapshot,
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void window.pragmaDesktop
      .getDesktopSettings()
      .then((snapshot) => {
        if (!cancelled) setSettings(snapshot);
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
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsScreenFrame>
  );
}
