import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Sidebar, type AppView } from "./components/Sidebar.tsx";
import { SidebarResizeHandle } from "./components/SidebarResizeHandle.tsx";
import { readSidebarCollapsed, writeSidebarCollapsed } from "./lib/sidebar-preference.ts";
import {
  SIDEBAR_WIDTH_PREFERENCES,
  usePersistentSidebarWidth,
} from "./lib/sidebar-width-preference.ts";
import { SettingsPage, type SettingsView } from "./pages/settings/SettingsPage.tsx";
import { MissionsPage } from "./pages/missions/MissionsPage.tsx";
import { StudioPage } from "./pages/studio/StudioPage.tsx";
import { EvaluationsPage } from "./pages/evaluations/EvaluationsPage.tsx";
import { HomePage } from "./pages/home/HomePage.tsx";
import { UsagePage } from "./pages/usage/UsagePage.tsx";
import type { Mission } from "../../shared/contracts/index.ts";

export function App() {
  const { t } = useTranslation("common");
  const [activeView, setActiveView] = useState<AppView>("home");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readSidebarCollapsed(typeof window === "undefined" ? undefined : window.localStorage),
  );
  const [sidebarWidth, setSidebarWidth] = usePersistentSidebarWidth(SIDEBAR_WIDTH_PREFERENCES.main);
  const [missionExecutorRef, setMissionExecutorRef] = useState<string>();
  const [missionToOpen, setMissionToOpen] = useState<Mission>();
  const [studioExpertRef, setStudioExpertRef] = useState<string>();
  const [settingsView, setSettingsView] = useState<SettingsView>("general");

  const navigate = (view: AppView) => {
    setMissionExecutorRef(undefined);
    setStudioExpertRef(undefined);
    if (view === "missions") setMissionToOpen(undefined);
    if (view === "settings") setSettingsView("general");
    setActiveView(view);
  };

  const toggleSidebar = () => {
    const nextCollapsed = !sidebarCollapsed;
    writeSidebarCollapsed(
      typeof window === "undefined" ? undefined : window.localStorage,
      nextCollapsed,
    );
    setSidebarCollapsed(nextCollapsed);
  };

  const openModelSettings = () => {
    setSettingsView("models");
    setActiveView("settings");
  };

  return (
    <main
      className={sidebarCollapsed ? "desktop-shell is-sidebar-collapsed" : "desktop-shell"}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
    >
      <div className="window-drag-region" aria-hidden="true" />
      <Sidebar
        activeView={activeView}
        collapsed={sidebarCollapsed}
        onNavigate={navigate}
        onToggle={toggleSidebar}
      />
      {!sidebarCollapsed ? (
        <SidebarResizeHandle
          label={t("navigation.resize")}
          width={sidebarWidth}
          preference={SIDEBAR_WIDTH_PREFERENCES.main}
          onResize={setSidebarWidth}
        />
      ) : null}

      {activeView === "home" ? (
        <HomePage
          initialExecutorRef={missionExecutorRef}
          onConfigureModels={openModelSettings}
          onCreated={(mission) => {
            setMissionToOpen(mission);
            setMissionExecutorRef(undefined);
            setActiveView("missions");
          }}
        />
      ) : activeView === "missions" ? (
        <MissionsPage
          initialMission={missionToOpen}
          autoRunInitialMission={missionToOpen !== undefined}
          onConfigureModels={openModelSettings}
          onEditExpert={(expertRef) => {
            setStudioExpertRef(expertRef);
            setActiveView("studio");
          }}
          onCreate={() => {
            setMissionToOpen(undefined);
            setMissionExecutorRef(undefined);
            setActiveView("home");
          }}
        />
      ) : activeView === "studio" ? (
        <StudioPage
          initialExpertRef={studioExpertRef}
          onTryExpert={(expert) => {
            setMissionExecutorRef(`expert:${expert.id}`);
            setMissionToOpen(undefined);
            setActiveView("home");
          }}
        />
      ) : activeView === "evaluations" ? (
        <EvaluationsPage />
      ) : activeView === "usage" ? (
        <UsagePage />
      ) : (
        <SettingsPage initialView={settingsView} />
      )}
    </main>
  );
}
