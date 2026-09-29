import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { X } from "@phosphor-icons/react";

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
import type { ContextStoreLeaveGuard } from "./pages/studio/ContextStoreFragment.tsx";
import { EvaluationsPage } from "./pages/evaluations/EvaluationsPage.tsx";
import { HomePage } from "./pages/home/HomePage.tsx";
import { UsagePage } from "./pages/usage/UsagePage.tsx";
import { MemoryPage } from "./pages/memory/MemoryPage.tsx";
import type {
  AssetGitStatus,
  AssetGitTarget,
  HomeMissionExecutorOption,
  Mission,
} from "../../shared/contracts/index.ts";

export function App() {
  const { t } = useTranslation("common");
  const [activeView, setActiveView] = useState<AppView>("home");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readSidebarCollapsed(typeof window === "undefined" ? undefined : window.localStorage),
  );
  const [sidebarWidth, setSidebarWidth] = usePersistentSidebarWidth(SIDEBAR_WIDTH_PREFERENCES.main);
  const [missionExecutorRef, setMissionExecutorRef] = useState<string>();
  const [missionToOpen, setMissionToOpen] = useState<Mission>();
  const [missionComposerDraftToOpen, setMissionComposerDraftToOpen] = useState<string>();
  const [autoRunMissionOnOpen, setAutoRunMissionOnOpen] = useState(false);
  const [missionsMemoryState, setMissionsMemoryState] = useState<MissionsPageMemoryState>();
  const [studioExpertRef, setStudioExpertRef] = useState<string>();
  const [studioExpertStep, setStudioExpertStep] = useState<"capabilities" | undefined>();
  const [studioResourceRef, setStudioResourceRef] = useState<string>();
  const [studioRevisionStoreId, setStudioRevisionStoreId] = useState<string>();
  const [studioAssetGitTarget, setStudioAssetGitTarget] = useState<{
    readonly target: AssetGitTarget;
    readonly requestId: number;
  }>();
  const [studioMemoryState, setStudioMemoryState] = useState<StudioPageMemoryState>();
  const [evaluationTargetId, setEvaluationTargetId] = useState<string>();
  const [settingsView, setSettingsView] = useState<SettingsView>("general");
  const [memoryEnabled, setMemoryEnabled] = useState<boolean>();
  const [assetGitIssues, setAssetGitIssues] = useState<readonly AssetGitStatus[]>([]);
  const assetGitNavigationSequence = useRef(0);
  const leaveGuardRef = useRef<ContextStoreLeaveGuard | null>(null);

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
    const api = typeof window === "undefined" ? undefined : window.pragmaDesktop;
    if (api === undefined) return;
    return api.subscribeAssetGitStatusUpdates((status) => {
      setAssetGitIssues((current) => updateAssetGitIssues(current, status));
    });
  }, []);

  useEffect(() => {
    const sync = () => {
      void window.pragmaDesktop.refreshCoreAssets().catch(() => undefined);
    };
    window.addEventListener("focus", sync);
    window.addEventListener("online", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("online", sync);
    };
  }, []);

  useEffect(() => {
    if (memoryEnabled === false && activeView === "memory") setActiveView("home");
  }, [activeView, memoryEnabled]);

  useEffect(() => {
    if (missionComposerDraftToOpen === undefined) return;
    setMissionComposerDraftToOpen(undefined);
  }, [missionComposerDraftToOpen]);

  const navigate = (view: AppView) => {
    const perform = () => {
      setMissionExecutorRef(undefined);
      setMissionComposerDraftToOpen(undefined);
      setAutoRunMissionOnOpen(false);
      setStudioExpertRef(undefined);
      setStudioExpertStep(undefined);
      setStudioResourceRef(undefined);
      setStudioRevisionStoreId(undefined);
      setStudioAssetGitTarget(undefined);
      if (view === "missions") setMissionToOpen(undefined);
      if (view === "settings") setSettingsView("general");
      setActiveView(view);
    };
    const guard = leaveGuardRef.current;
    if (guard === null) perform();
    else guard(perform);
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
    setStudioAssetGitTarget(undefined);
    setStudioMemoryState({ activeView: "context-stores" });
    setActiveView("studio");
  };

  const openStudioForExecutor = (executor: HomeMissionExecutorOption) => {
    setStudioExpertRef(executor.kind === "expert" ? executor.ref : undefined);
    setStudioExpertStep(executor.kind === "expert" ? "capabilities" : undefined);
    setStudioResourceRef(executor.kind === "team" ? executor.ref : undefined);
    setStudioRevisionStoreId(undefined);
    setStudioAssetGitTarget(undefined);
    setActiveView("studio");
  };

  const openMemorySettings = () => {
    setSettingsView("memory");
    setActiveView("settings");
  };

  const openAssetGitIssue = (status: AssetGitStatus) => {
    const perform = () => {
      assetGitNavigationSequence.current += 1;
      setStudioExpertRef(undefined);
      setStudioExpertStep(undefined);
      setStudioResourceRef(undefined);
      setStudioRevisionStoreId(undefined);
      setStudioMemoryState({
        activeView: status.target.kind === "knowledge" ? "context-stores" : "skills",
      });
      setStudioAssetGitTarget({
        target: status.target,
        requestId: assetGitNavigationSequence.current,
      });
      setAssetGitIssues((current) => removeAssetGitIssue(current, status.target));
      setActiveView("studio");
    };
    const guard = leaveGuardRef.current;
    if (guard === null) perform();
    else guard(perform);
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
            setMissionComposerDraftToOpen(undefined);
            setAutoRunMissionOnOpen(true);
            setMissionExecutorRef(undefined);
            setActiveView("missions");
          }}
        />
      ) : activeView === "missions" ? (
        <MissionsPage
          initialMission={missionToOpen}
          initialComposerDraft={missionComposerDraftToOpen}
          initialMemoryState={missionsMemoryState}
          memoryEnabled={memoryEnabled}
          autoRunInitialMission={autoRunMissionOnOpen}
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
            setMissionComposerDraftToOpen(undefined);
            setAutoRunMissionOnOpen(false);
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
          initialAssetGitTarget={studioAssetGitTarget}
          initialMemoryState={studioMemoryState}
          memoryEnabled={memoryEnabled === true}
          onMemoryStateChange={setStudioMemoryState}
          onLeaveGuardChange={(guard) => {
            leaveGuardRef.current = guard;
          }}
          onTryExpert={(expert) => {
            setMissionExecutorRef(`expert:${expert.id}`);
            setMissionToOpen(undefined);
            setMissionComposerDraftToOpen(undefined);
            setAutoRunMissionOnOpen(false);
            setActiveView("home");
          }}
          onOpenMission={(missionId, composerDraft) => {
            void window.pragmaDesktop.getMission(missionId).then((mission) => {
              setMissionToOpen(mission);
              setMissionComposerDraftToOpen(composerDraft);
              setAutoRunMissionOnOpen(false);
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
      <div className="application-notices">
        {assetGitIssues[0] === undefined ? null : (
          <AssetGitIssueNotice
            status={assetGitIssues[0]}
            additionalCount={assetGitIssues.length - 1}
            onOpen={() => openAssetGitIssue(assetGitIssues[0]!)}
            onDismiss={() =>
              setAssetGitIssues((current) =>
                removeAssetGitIssue(current, assetGitIssues[0]!.target),
              )
            }
          />
        )}
      </div>
    </main>
  );
}

export function updateAssetGitIssues(
  current: readonly AssetGitStatus[],
  status: AssetGitStatus,
): readonly AssetGitStatus[] {
  const remaining = removeAssetGitIssue(current, status.target);
  return status.status === "conflict" || status.status === "error"
    ? [...remaining, status]
    : remaining;
}

export function removeAssetGitIssue(
  current: readonly AssetGitStatus[],
  target: AssetGitTarget,
): readonly AssetGitStatus[] {
  return current.filter(
    (status) => status.target.kind !== target.kind || status.target.id !== target.id,
  );
}

export function AssetGitIssueNotice(props: {
  readonly status: AssetGitStatus;
  readonly additionalCount: number;
  readonly onOpen: () => void;
  readonly onDismiss: () => void;
}) {
  const { t } = useTranslation("common");
  const asset = t(`assetGitNotice.asset.${props.status.target.kind}`);
  const message = t(`assetGitNotice.${props.status.status === "conflict" ? "conflict" : "error"}`, {
    asset,
  });

  return (
    <aside className="asset-git-issue-notice" role="alert">
      <span>
        {message}
        {props.additionalCount > 0
          ? ` ${t("assetGitNotice.additional", { count: props.additionalCount })}`
          : ""}
      </span>
      <button className="primary-button" type="button" onClick={props.onOpen}>
        {t("assetGitNotice.openSettings")}
      </button>
      <button
        className="icon-button asset-git-issue-dismiss"
        type="button"
        aria-label={t("assetGitNotice.dismiss")}
        title={t("assetGitNotice.dismiss")}
        onClick={props.onDismiss}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </aside>
  );
}
