import { useState } from "react";

import { Sidebar, type AppView } from "./components/Sidebar.tsx";
import { SettingsPage } from "./pages/settings/SettingsPage.tsx";
import { MissionsPage } from "./pages/missions/MissionsPage.tsx";
import { StudioPage } from "./pages/studio/StudioPage.tsx";

export function App() {
  const [activeView, setActiveView] = useState<AppView>("studio");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [missionExecutorRef, setMissionExecutorRef] = useState<string>();

  const navigate = (view: AppView) => {
    if (view !== "missions") setMissionExecutorRef(undefined);
    setActiveView(view);
  };

  return (
    <main className={sidebarCollapsed ? "desktop-shell is-sidebar-collapsed" : "desktop-shell"}>
      <Sidebar
        activeView={activeView}
        collapsed={sidebarCollapsed}
        onNavigate={navigate}
        onToggle={() => setSidebarCollapsed((collapsed) => !collapsed)}
      />

      {activeView === "missions" ? (
        <MissionsPage initialExecutorRef={missionExecutorRef} />
      ) : activeView === "studio" ? (
        <StudioPage
          onTryExpert={(expert) => {
            setMissionExecutorRef(`expert:${expert.id}@${expert.version}`);
            setActiveView("missions");
          }}
        />
      ) : (
        <SettingsPage />
      )}
    </main>
  );
}
