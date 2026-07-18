import { useState } from "react";

import { ModelProvidersFragment } from "./ModelProvidersFragment.tsx";
import { RuntimeEnvironmentsFragment } from "./RuntimeEnvironmentsFragment.tsx";

type SettingsView = "models" | "runtimes";

export function SettingsPage() {
  const [activeView, setActiveView] = useState<SettingsView>("models");

  return (
    <section className="settings-page">
      <nav className="settings-navigation" aria-label="Settings sections">
        <button
          className={activeView === "models" ? "settings-nav-item is-active" : "settings-nav-item"}
          type="button"
          aria-selected={activeView === "models"}
          aria-controls="models-panel"
          onClick={() => setActiveView("models")}
        >
          Models &amp; Providers
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
          Runtime Environments
        </button>
      </nav>

      <div className="settings-content">
        {activeView === "models" ? <ModelProvidersFragment /> : <RuntimeEnvironmentsFragment />}
      </div>
    </section>
  );
}
