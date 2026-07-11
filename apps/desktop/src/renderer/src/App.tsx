import { useState } from "react";

import { Sidebar, type AppView } from "./components/Sidebar.tsx";
import { SettingsPage } from "./pages/settings/SettingsPage.tsx";
import { StudioPage } from "./pages/studio/StudioPage.tsx";

export function App() {
  const [activeView, setActiveView] = useState<AppView>("studio");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <main className={sidebarCollapsed ? "desktop-shell is-sidebar-collapsed" : "desktop-shell"}>
      <Sidebar
        activeView={activeView}
        collapsed={sidebarCollapsed}
        onNavigate={setActiveView}
        onToggle={() => setSidebarCollapsed((collapsed) => !collapsed)}
      />

      {activeView === "studio" ? <StudioPage /> : <SettingsPage />}
    </main>
  );
}
