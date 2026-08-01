import { useState } from "react";
import { useTranslation } from "react-i18next";

import { GeneralSettingsFragment } from "./GeneralSettingsFragment.tsx";
import { MemorySettingsFragment } from "./MemorySettingsFragment.tsx";
import { ModelProvidersFragment } from "./ModelProvidersFragment.tsx";
import { RuntimeEnvironmentsFragment } from "./RuntimeEnvironmentsFragment.tsx";

export type SettingsView = "general" | "memory" | "models" | "runtimes";

export function SettingsPage(props: { readonly initialView?: SettingsView } = {}) {
  const { t } = useTranslation("settings");
  const [activeView, setActiveView] = useState<SettingsView>(props.initialView ?? "general");

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
          className={activeView === "memory" ? "settings-nav-item is-active" : "settings-nav-item"}
          type="button"
          aria-selected={activeView === "memory"}
          aria-controls="memory-panel"
          onClick={() => setActiveView("memory")}
        >
          {t("memory.navigation")}
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
        ) : activeView === "memory" ? (
          <MemorySettingsFragment />
        ) : activeView === "models" ? (
          <ModelProvidersFragment />
        ) : (
          <RuntimeEnvironmentsFragment />
        )}
      </div>
    </section>
  );
}
