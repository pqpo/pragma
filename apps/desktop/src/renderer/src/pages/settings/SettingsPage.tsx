import { useState } from "react";
import { useTranslation } from "react-i18next";

import { GeneralSettingsFragment } from "./GeneralSettingsFragment.tsx";
import { ModelProvidersFragment } from "./ModelProvidersFragment.tsx";
import { RuntimeEnvironmentsFragment } from "./RuntimeEnvironmentsFragment.tsx";

type SettingsView = "general" | "models" | "runtimes";

export function SettingsPage() {
  const { t } = useTranslation("settings");
  const [activeView, setActiveView] = useState<SettingsView>("general");

  return (
    <section className="settings-page">
      <nav className="settings-navigation" aria-label={t("navigationLabel")}>
        <button
          className={activeView === "general" ? "settings-nav-item is-active" : "settings-nav-item"}
          type="button"
          aria-selected={activeView === "general"}
          aria-controls="general-panel"
          onClick={() => setActiveView("general")}
        >
          {t("general.title")}
        </button>
        <button
          className={activeView === "models" ? "settings-nav-item is-active" : "settings-nav-item"}
          type="button"
          aria-selected={activeView === "models"}
          aria-controls="models-panel"
          onClick={() => setActiveView("models")}
        >
          {t("models.navigation")}
        </button>
        <button
          className={
            activeView === "runtimes" ? "settings-nav-item is-active" : "settings-nav-item"
          }
          type="button"
          aria-selected={activeView === "runtimes"}
          aria-controls="runtimes-panel"
          onClick={() => setActiveView("runtimes")}
        >
          {t("runtimes.navigation")}
        </button>
      </nav>

      <div className="settings-content">
        {activeView === "general" ? (
          <GeneralSettingsFragment />
        ) : activeView === "models" ? (
          <ModelProvidersFragment />
        ) : (
          <RuntimeEnvironmentsFragment />
        )}
      </div>
    </section>
  );
}
