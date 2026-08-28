import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Sidebar, type AppView } from "./components/Sidebar.tsx";
import { SidebarResizeHandle } from "./components/SidebarResizeHandle.tsx";
import { readSidebarCollapsed, writeSidebarCollapsed } from "./lib/sidebar-preference.ts";
import {
  SIDEBAR_WIDTH_PREFERENCES,
  usePersistentSidebarWidth,
} from "./lib/sidebar-width-preference.ts";
import { SettingsPage, type SettingsView } from "./pages/settings/SettingsPage.tsx";
import { MissionsPage, type MissionsPageMemoryState } from "./pages/missions/MissionsPage.tsx";
import { StudioPage, type StudioPageMemoryState } from "./pages/studio/StudioPage.tsx";
import { EvaluationsPage } from "./pages/evaluations/EvaluationsPage.tsx";
import { HomePage } from "./pages/home/HomePage.tsx";
import { UsagePage } from "./pages/usage/UsagePage.tsx";
import { MemoryPage } from "./pages/memory/MemoryPage.tsx";
import type { HomeMissionExecutorOption, Mission } from "../../shared/contracts/index.ts";

export function App() {
  const { t } = useTranslation("common");
  const [activeView, setActiveView] = useState<AppView>("home");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readSidebarCollapsed(typeof window === "undefined" ? undefined : window.localStorage),
  );
  const [sidebarWidth, setSidebarWidth] = usePersistentSidebarWidth(SIDEBAR_WIDTH_PREFERENCES.main);
  const [missionExecutorRef, setMissionExecutorRef] = useState<string>();
  const [missionToOpen, setMissionToOpen] = useState<Mission>();
  const [missionsMemoryState, setMissionsMemoryState] = useState<MissionsPageMemoryState>();
  const [studioExpertRef, setStudioExpertRef] = useState<string>();
  const [studioExpertStep, setStudioExpertStep] = useState<"capabilities" | undefined>();
  const [studioResourceRef, setStudioResourceRef] = useState<string>();
  const [studioRevisionStoreId, setStudioRevisionStoreId] = useState<string>();
  const [studioMemoryState, setStudioMemoryState] = useState<StudioPageMemoryState>();
  const [evaluationTargetId, setEvaluationTargetId] = useState<string>();
  const [settingsView, setSettingsView] = useState<SettingsView>("general");
  const [memoryEnabled, setMemoryEnabled] = useState<boolean>();

  useEffect(() => {
    const api = typeof window === "undefined" ? undefined : window.pragmaDesktop;
    if (api === undefined) return;
    let cancelled = false;
    void api
      .getGlobalMemoryPolicy()
      .then((snapshot) => {
        if (!cancelled) setMemoryEnabled(snapshot.policy.enabled === "enabled");
      })
      .catch(() => {
        if (!cancelled) setMemoryEnabled(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (memoryEnabled === false && activeView === "memory") setActiveView("home");
  }, [activeView, memoryEnabled]);

  const navigate = (view: AppView) => {
    setMissionExecutorRef(undefined);
    setStudioExpertRef(undefined);
    setStudioExpertStep(undefined);
    setStudioResourceRef(undefined);
    setStudioRevisionStoreId(undefined);
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

  const openRuntimeSettings = () => {
    setSettingsView("runtimes");
    setActiveView("settings");
  };

  const openKnowledgeBases = () => {
    setStudioExpertRef(undefined);
    setStudioExpertStep(undefined);
    setStudioResourceRef(undefined);
    setStudioRevisionStoreId(undefined);
    setStudioMemoryState({ activeView: "context-stores" });
    setActiveView("studio");
  };

  const openStudioForExecutor = (executor: HomeMissionExecutorOption) => {
    setStudioExpertRef(executor.kind === "expert" ? executor.ref : undefined);
    setStudioExpertStep(executor.kind === "expert" ? "capabilities" : undefined);
    setStudioResourceRef(executor.kind === "team" ? executor.ref : undefined);
    setStudioRevisionStoreId(undefined);
    setActiveView("studio");
  };

  const openMemorySettings = () => {
    setSettingsView("memory");
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
        memoryEnabled={memoryEnabled === true}
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
          onConfigureRuntime={openRuntimeSettings}
          onConfigureExpert={openStudioForExecutor}
          onOpenKnowledgeBases={openKnowledgeBases}
          onCreated={(mission) => {
            setMissionToOpen(mission);
            setMissionExecutorRef(undefined);
            setActiveView("missions");
          }}
        />
      ) : activeView === "missions" ? (
        <MissionsPage
          initialMission={missionToOpen}
          initialMemoryState={missionsMemoryState}
          memoryEnabled={memoryEnabled}
          autoRunInitialMission={missionToOpen !== undefined}
          onMemoryStateChange={setMissionsMemoryState}
          onConfigureModels={openModelSettings}
          onOpenKnowledgeBases={openKnowledgeBases}
          onOpenKnowledgeRevision={(storeId) => {
            setStudioExpertRef(undefined);
            setStudioResourceRef(undefined);
            setStudioRevisionStoreId(storeId);
            setStudioMemoryState({ activeView: "context-stores" });
            setActiveView("studio");
          }}
          onEditExpert={(expertRef) => {
            setStudioExpertRef(expertRef);
            setStudioExpertStep(undefined);
            setStudioResourceRef(undefined);
            setStudioRevisionStoreId(undefined);
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
          initialExpertStep={studioExpertStep}
          initialResourceRef={studioResourceRef}
          initialRevisionStoreId={studioRevisionStoreId}
          initialMemoryState={studioMemoryState}
          onMemoryStateChange={setStudioMemoryState}
          onTryExpert={(expert) => {
            setMissionExecutorRef(`expert:${expert.id}`);
            setMissionToOpen(undefined);
            setActiveView("home");
          }}
          onOpenMission={(missionId) => {
            void window.pragmaDesktop.getMission(missionId).then((mission) => {
              setMissionToOpen(mission);
              setStudioRevisionStoreId(undefined);
              setActiveView("missions");
            });
          }}
        />
      ) : activeView === "evaluations" ? (
        <EvaluationsPage
          initialTargetId={evaluationTargetId}
          onTargetChange={setEvaluationTargetId}
        />
      ) : activeView === "usage" ? (
        <UsagePage />
      ) : activeView === "memory" ? (
        <MemoryPage onConfigureExtraction={openMemorySettings} />
      ) : (
        <SettingsPage initialView={settingsView} onMemoryEnabledChange={setMemoryEnabled} />
      )}
    </main>
  );
}
