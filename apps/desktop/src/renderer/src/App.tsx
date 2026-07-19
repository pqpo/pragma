import { useState } from "react";

import { Sidebar, type AppView } from "./components/Sidebar.tsx";
import { readSidebarCollapsed, writeSidebarCollapsed } from "./lib/sidebar-preference.ts";
import { SettingsPage, type SettingsView } from "./pages/settings/SettingsPage.tsx";
import { MissionsPage } from "./pages/missions/MissionsPage.tsx";
import { StudioPage } from "./pages/studio/StudioPage.tsx";
import { HomePage } from "./pages/home/HomePage.tsx";

export function App() {
  const [activeView, setActiveView] = useState<AppView>("home");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readSidebarCollapsed(typeof window === "undefined" ? undefined : window.localStorage),
  );
  const [missionExecutorRef, setMissionExecutorRef] = useState<string>();
  const [settingsView, setSettingsView] = useState<SettingsView>("general");

  const navigate = (view: AppView) => {
    if (view !== "missions") setMissionExecutorRef(undefined);
    if (view === "settings") setSettingsView("general");
    setActiveView(view);
  };

  const openSettings = (view: SettingsView) => {
    setSettingsView(view);
    setActiveView("settings");
  };

  const toggleSidebar = () => {
    const nextCollapsed = !sidebarCollapsed;
    writeSidebarCollapsed(
      typeof window === "undefined" ? undefined : window.localStorage,
      nextCollapsed,
    );
    setSidebarCollapsed(nextCollapsed);
  };

  return (
    <main className={sidebarCollapsed ? "desktop-shell is-sidebar-collapsed" : "desktop-shell"}>
      <div className="window-drag-region" aria-hidden="true" />
      <Sidebar
        activeView={activeView}
        collapsed={sidebarCollapsed}
        onNavigate={navigate}
        onToggle={toggleSidebar}
      />

      {activeView === "home" ? (
        <HomePage
          onOpenStudio={() => navigate("studio")}
          onOpenMissions={() => navigate("missions")}
          onOpenModelSettings={() => openSettings("models")}
        />
      ) : activeView === "missions" ? (
        <MissionsPage initialExecutorRef={missionExecutorRef} />
      ) : activeView === "studio" ? (
        <StudioPage
          onTryExpert={(expert) => {
            setMissionExecutorRef(`expert:${expert.id}@${expert.version}`);
            setActiveView("missions");
          }}
        />
      ) : (
        <SettingsPage initialView={settingsView} />
      )}
    </main>
  );
}
