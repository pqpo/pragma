import { useEffect, useMemo, useState } from "react";

import {
  ArrowCounterClockwise,
  CheckCircle,
  Folder,
  MagnifyingGlass,
  Paperclip,
  Plus,
  User,
  UsersThree,
} from "@phosphor-icons/react";

import type { ExpertSummary, Mission, PragmaDesktopAPI } from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";

type MissionScreen = "create" | "detail";

export function MissionsPage() {
  const [missions, setMissions] = useState<readonly Mission[]>([]);
  const [experts, setExperts] = useState<readonly ExpertSummary[]>([]);
  const [screen, setScreen] = useState<MissionScreen>("create");
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) return;
    let cancelled = false;
    void Promise.all([api.listMissions(), api.listExperts()])
      .then(([storedMissions, storedExperts]) => {
        if (cancelled) return;
        setMissions(storedMissions);
        setExperts(storedExperts);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleMissions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (query === "") return missions;
    return missions.filter((mission) =>
      [mission.title, mission.workspace.basename, mission.executor.name].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    );
  }, [missions, search]);
  const selectedMission = missions.find((mission) => mission.id === selectedMissionId) ?? null;

  const replaceMission = (updated: Mission) => {
    setMissions((current) =>
      current
        .map((mission) => (mission.id === updated.id ? updated : mission))
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    );
  };

  return (
    <section className="missions-page">
      <MissionRail
        missions={visibleMissions}
        search={search}
        selectedMissionId={screen === "detail" ? selectedMissionId : null}
        onSearch={setSearch}
        onCreate={() => {
          setScreen("create");
          setSelectedMissionId(null);
          setError(null);
        }}
        onOpen={(mission) => {
          setSelectedMissionId(mission.id);
          setScreen("detail");
          setError(null);
        }}
      />

      <div className="mission-main">
        {screen === "create" ? (
          <CreateMissionFragment
            experts={experts}
            onCreated={(mission) => {
              setMissions((current) => [mission, ...current]);
              setSelectedMissionId(mission.id);
              setScreen("detail");
              setError(null);
            }}
          />
        ) : selectedMission !== null ? (
          <MissionDetailFragment
            mission={selectedMission}
            onLifecycleChange={async () => {
              const api = desktopApi();
              if (api === undefined) return;
              try {
                const updated =
                  selectedMission.lifecycleStatus === "active"
                    ? await api.markMissionComplete(selectedMission.id)
                    : await api.reopenMission(selectedMission.id);
                replaceMission(updated);
                setError(null);
              } catch (actionError) {
                setError(errorMessage(actionError));
              }
            }}
          />
        ) : (
          <div className="mission-empty-detail">
            <h1>Mission not found</h1>
            <p>Select another mission or create a new one.</p>
          </div>
        )}
        {error ? (
          <p className="mission-page-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function MissionRail(props: {
  readonly missions: readonly Mission[];
  readonly search: string;
  readonly selectedMissionId: string | null;
  readonly onSearch: (value: string) => void;
  readonly onCreate: () => void;
  readonly onOpen: (mission: Mission) => void;
}) {
  const active = props.missions.filter((mission) => mission.lifecycleStatus === "active");
  const completed = props.missions.filter((mission) => mission.lifecycleStatus === "completed");
  return (
    <aside className="mission-rail">
      <h1>Missions</h1>
      <button className="mission-new-button" type="button" onClick={props.onCreate}>
        <Plus size={18} weight="bold" aria-hidden="true" />
        New mission
      </button>
      <label className="mission-search">
        <MagnifyingGlass size={18} aria-hidden="true" />
        <span className="sr-only">Search missions</span>
        <input
          value={props.search}
          onChange={(event) => props.onSearch(event.target.value)}
          placeholder="Search missions"
        />
      </label>
      <MissionRailGroup
        label="Active"
        missions={active}
        selectedMissionId={props.selectedMissionId}
        onOpen={props.onOpen}
      />
      <MissionRailGroup
        label="Completed"
        missions={completed}
        selectedMissionId={props.selectedMissionId}
        onOpen={props.onOpen}
      />
    </aside>
  );
}

function MissionRailGroup(props: {
  readonly label: string;
  readonly missions: readonly Mission[];
  readonly selectedMissionId: string | null;
  readonly onOpen: (mission: Mission) => void;
}) {
  return (
    <section className="mission-rail-group">
      <h2>{props.label}</h2>
      {props.missions.length === 0 ? (
        <p className="mission-rail-empty">No {props.label.toLocaleLowerCase()} missions</p>
      ) : (
        props.missions.map((mission) => (
          <button
            className={
              mission.id === props.selectedMissionId ? "mission-row is-active" : "mission-row"
            }
            type="button"
            key={mission.id}
            onClick={() => props.onOpen(mission)}
          >
            <span
              className={
                mission.lifecycleStatus === "active"
                  ? "mission-status-dot is-active"
                  : "mission-status-dot"
              }
              aria-hidden="true"
            />
            <span>
              <strong>{mission.title}</strong>
              <small>{mission.lifecycleStatus === "active" ? "Ready" : "Completed"}</small>
            </span>
          </button>
        ))
      )}
    </section>
  );
}

function CreateMissionFragment(props: {
  readonly experts: readonly ExpertSummary[];
  readonly onCreated: (mission: Mission) => void;
}) {
  const [workspace, setWorkspace] = useState<{ path: string; basename: string } | null>(null);
  const [expertId, setExpertId] = useState("");
  const [goal, setGoal] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickWorkspace = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    try {
      const result = await api.pickWorkspace();
      if (result.ok && result.path !== undefined && result.basename !== undefined) {
        setWorkspace({ path: result.path, basename: result.basename });
        setError(null);
      } else if (result.reason !== "cancelled") {
        setError(result.error ?? "The selected workspace is not available.");
      }
    } catch (pickError) {
      setError(errorMessage(pickError));
    }
  };

  const submit = async () => {
    const api = desktopApi();
    if (api === undefined || workspace === null || expertId === "" || goal.trim() === "") return;
    setSaving(true);
    setError(null);
    try {
      props.onCreated(
        await api.createMission({
          workspace: workspace.path,
          executor: { kind: "expert", id: expertId },
          goal: goal.trim(),
        }),
      );
    } catch (submitError) {
      setError(errorMessage(submitError));
      setSaving(false);
    }
  };

  return (
    <section className="mission-create" aria-labelledby="new-mission-title">
      <header>
        <h1 id="new-mission-title">Start a mission</h1>
        <p>Choose a workspace and an executor, then describe the outcome.</p>
      </header>
      <div className="mission-create-selectors">
        <button className="mission-selector" type="button" onClick={() => void pickWorkspace()}>
          <span className="mission-selector-icon">
            <Folder size={23} aria-hidden="true" />
          </span>
          <span>
            <small>Workspace</small>
            <strong>{workspace?.basename ?? "Choose a folder"}</strong>
            <em>{workspace?.path ?? "One working directory per mission"}</em>
          </span>
        </button>
        <label className="mission-selector">
          <span className="mission-selector-icon">
            <User size={23} aria-hidden="true" />
          </span>
          <span>
            <small>Executor</small>
            <select value={expertId} onChange={(event) => setExpertId(event.target.value)}>
              <option value="">Choose an expert</option>
              {props.experts.map((expert) => (
                <option value={expert.id} key={expert.id}>
                  {expert.name}
                </option>
              ))}
            </select>
            <em>Expert</em>
          </span>
        </label>
      </div>
      <div className="mission-goal-composer">
        <label htmlFor="mission-goal">What do you want to accomplish?</label>
        <textarea
          id="mission-goal"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="Describe the outcome you want this expert to deliver."
          autoFocus
        />
        <footer>
          <span className="mission-context-disabled" title="Files are accessed from the workspace">
            <Paperclip size={19} aria-hidden="true" />
            Workspace context
          </span>
          <button
            className="primary-button"
            type="button"
            disabled={saving || workspace === null || expertId === "" || goal.trim() === ""}
            onClick={() => void submit()}
          >
            {saving ? "Creating…" : "Create mission"}
          </button>
        </footer>
      </div>
      {props.experts.length === 0 ? (
        <p className="mission-form-note">Create an expert in Studio before starting a mission.</p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function MissionDetailFragment(props: {
  readonly mission: Mission;
  readonly onLifecycleChange?: () => void | Promise<void>;
}) {
  const [tab, setTab] = useState<"chat" | "work">("chat");
  const [workspaceAvailable, setWorkspaceAvailable] = useState<boolean | null>(null);
  const isTeam = props.mission.executor.kind === "expert_team";

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) return;
    let cancelled = false;
    void api.validateWorkspace(props.mission.workspace.path).then((result) => {
      if (!cancelled) setWorkspaceAvailable(result.ok);
    });
    return () => {
      cancelled = true;
    };
  }, [props.mission.workspace.path]);

  return (
    <section className={isTeam ? "mission-detail has-team-inspector" : "mission-detail"}>
      <header className="mission-detail-header">
        <div>
          <h1>{props.mission.title}</h1>
          <p>
            <span className="mission-ready-dot" aria-hidden="true" />
            {props.mission.lifecycleStatus === "active" ? "Ready" : "Completed"}
            <span aria-hidden="true">·</span>
            <Folder size={16} aria-hidden="true" />
            {props.mission.workspace.basename}
            {workspaceAvailable === false ? <strong>Workspace unavailable</strong> : null}
            <span aria-hidden="true">·</span>
            {isTeam ? (
              <UsersThree size={17} aria-hidden="true" />
            ) : (
              <User size={17} aria-hidden="true" />
            )}
            {props.mission.executor.name}
          </p>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void props.onLifecycleChange?.()}
        >
          {props.mission.lifecycleStatus === "active" ? (
            <>
              <CheckCircle size={17} aria-hidden="true" /> Mark complete
            </>
          ) : (
            <>
              <ArrowCounterClockwise size={17} aria-hidden="true" /> Reopen
            </>
          )}
        </button>
      </header>
      <div className="mission-detail-tabs" role="tablist" aria-label="Mission detail views">
        <button
          className={tab === "chat" ? "is-active" : ""}
          type="button"
          role="tab"
          aria-selected={tab === "chat"}
          onClick={() => setTab("chat")}
        >
          {isTeam ? "Team channel" : "Chat"}
        </button>
        <button
          className={tab === "work" ? "is-active" : ""}
          type="button"
          role="tab"
          aria-selected={tab === "work"}
          onClick={() => setTab("work")}
        >
          Work
        </button>
      </div>
      <div className="mission-detail-body">
        {tab === "chat" ? (
          <div className="mission-chat">
            <div className="mission-user-message">
              <span aria-hidden="true">AC</span>
              <div>
                <strong>You</strong>
                <p>{props.mission.goal}</p>
              </div>
            </div>
            <div className="mission-execution-notice">
              <strong>Mission created</strong>
              <p>Execution will be available after Workflow continuation support is added.</p>
            </div>
            <div className="mission-disabled-composer" aria-disabled="true">
              <Paperclip size={20} aria-hidden="true" />
              <span>Mission execution is not available yet</span>
              <button type="button" disabled>
                Send
              </button>
            </div>
          </div>
        ) : (
          <div className="mission-work-empty">
            <CheckCircle size={31} weight="thin" aria-hidden="true" />
            <h2>No execution records</h2>
            <p>Runs, tool activity, and artifacts will appear here after execution is enabled.</p>
          </div>
        )}
      </div>
      {isTeam ? (
        <aside className="mission-team-inspector">
          <h2>Experts</h2>
          <p>Team members will appear here.</p>
        </aside>
      ) : null}
    </section>
  );
}

function desktopApi(): PragmaDesktopAPI | undefined {
  return typeof window === "undefined" ? undefined : window.pragmaDesktop;
}
