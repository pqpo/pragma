import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import {
  ArrowCounterClockwise,
  CheckCircle,
  Folder,
  GitBranch,
  MagnifyingGlass,
  Paperclip,
  Plus,
  Play,
  User,
  UsersThree,
} from "@phosphor-icons/react";
import type { PragmaResource } from "@pragma/interpreter/ast";
import type { HumanInteractionResponse } from "@pragma/shared";

import type {
  Mission,
  MissionHumanInteraction,
  PragmaDesktopAPI,
} from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";

type MissionScreen = "create" | "detail";

export function MissionsPage() {
  const [missions, setMissions] = useState<readonly Mission[]>([]);
  const [executors, setExecutors] = useState<readonly PragmaResource[]>([]);
  const [screen, setScreen] = useState<MissionScreen>("create");
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) return;
    let cancelled = false;
    void Promise.all([api.listMissions(), api.getPragmaProject()])
      .then(([storedMissions, project]) => {
        if (cancelled) return;
        setMissions(storedMissions);
        setExecutors(project.resources);
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

  useEffect(() => {
    const api = desktopApi();
    if (
      api === undefined ||
      (selectedMission?.execution?.status !== "running" &&
        selectedMission?.execution?.status !== "waiting")
    )
      return;
    const timer = setInterval(() => {
      void api.getMission(selectedMission.id).then(replaceMission);
    }, 1_000);
    return () => clearInterval(timer);
  }, [selectedMission?.id, selectedMission?.execution?.status]);

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
            executors={executors}
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
            onRun={async () => {
              const api = desktopApi();
              if (api === undefined) return;
              replaceMission(await api.runMission(selectedMission.id));
            }}
            onHumanResponded={async () => {
              const api = desktopApi();
              if (api !== undefined) replaceMission(await api.getMission(selectedMission.id));
            }}
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
  readonly executors: readonly PragmaResource[];
  readonly onCreated: (mission: Mission) => void;
}) {
  const [workspace, setWorkspace] = useState<{ path: string; basename: string } | null>(null);
  const [executorRef, setExecutorRef] = useState("");
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
    if (api === undefined || workspace === null || executorRef === "" || goal.trim() === "") return;
    setSaving(true);
    setError(null);
    try {
      props.onCreated(
        await api.createMission({
          workspace: workspace.path,
          executor: { ref: executorRef },
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
            <UsersThree size={23} aria-hidden="true" />
          </span>
          <span>
            <small>Executor</small>
            <select value={executorRef} onChange={(event) => setExecutorRef(event.target.value)}>
              <option value="">Choose an expert, team, or flow</option>
              {props.executors.map((executor) => {
                const kind =
                  executor.kind === "Expert"
                    ? "expert"
                    : executor.kind === "ExpertTeam"
                      ? "team"
                      : "flow";
                const ref = `${kind}:${executor.metadata.id}@${executor.metadata.version}`;
                return (
                  <option value={ref} key={ref}>
                    {executor.metadata.name} · {kind}
                  </option>
                );
              })}
            </select>
            <em>Project resource revision is pinned when the mission is created</em>
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
            disabled={saving || workspace === null || executorRef === "" || goal.trim() === ""}
            onClick={() => void submit()}
          >
            {saving ? "Creating…" : "Create mission"}
          </button>
        </footer>
      </div>
      {props.executors.length === 0 ? (
        <p className="mission-form-note">
          Create an expert, team, or flow in Studio before starting a mission.
        </p>
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
  readonly onRun?: () => void | Promise<void>;
  readonly onHumanResponded?: () => void | Promise<void>;
  readonly onLifecycleChange?: () => void | Promise<void>;
}) {
  const [tab, setTab] = useState<"chat" | "work">("chat");
  const [workspaceAvailable, setWorkspaceAvailable] = useState<boolean | null>(null);
  const [interactions, setInteractions] = useState<readonly MissionHumanInteraction[]>([]);
  const [humanNotes, setHumanNotes] = useState<Record<string, string>>({});
  const [humanAnswers, setHumanAnswers] = useState<
    Record<string, Record<string, string | readonly string[]>>
  >({});
  const isTeam = props.mission.executor.kind === "team";
  const isFlow = props.mission.executor.kind === "flow";

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

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined || props.mission.execution?.status !== "waiting") {
      setInteractions([]);
      return;
    }
    void api.listMissionHumanInteractions(props.mission.id).then(setInteractions);
  }, [props.mission.id, props.mission.execution?.status]);

  const respond = async (
    interaction: MissionHumanInteraction,
    response: HumanInteractionResponse,
  ) => {
    const api = desktopApi();
    if (api === undefined) return;
    await api.respondToMissionHumanInteraction({
      missionId: props.mission.id,
      interactionId: interaction.interactionId,
      requestId: crypto.randomUUID(),
      response,
    });
    setInteractions((current) =>
      current.filter((item) => item.interactionId !== interaction.interactionId),
    );
    setHumanNotes((current) => {
      const next = { ...current };
      delete next[interaction.interactionId];
      return next;
    });
    setHumanAnswers((current) => {
      const next = { ...current };
      delete next[interaction.interactionId];
      return next;
    });
    await props.onHumanResponded?.();
  };

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
            ) : isFlow ? (
              <GitBranch size={17} aria-hidden="true" />
            ) : (
              <User size={17} aria-hidden="true" />
            )}
            {props.mission.executor.name}
          </p>
        </div>
        <div className="mission-header-actions">
          {props.mission.lifecycleStatus === "active" ? (
            <button className="primary-button" type="button" onClick={() => void props.onRun?.()}>
              <Play size={17} />
              {props.mission.execution?.status === "running" ||
              props.mission.execution?.status === "waiting"
                ? "Resume"
                : props.mission.execution === undefined
                  ? "Run"
                  : "Run again"}
            </button>
          ) : null}
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
        </div>
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
              <strong>
                {props.mission.execution === undefined
                  ? "Ready to run"
                  : `Execution ${props.mission.execution.status}`}
              </strong>
              <p>
                {props.mission.execution?.error ??
                  `Pinned to ${props.mission.executor.ref} in project revision ${props.mission.project.revision}.`}
              </p>
            </div>
            {interactions.map((interaction) => (
              <section className="mission-human-loop" key={interaction.interactionId}>
                <strong>{interaction.request.title ?? "Human input required"}</strong>
                <p>{interaction.request.prompt ?? "Review the current workflow state."}</p>
                {interaction.request.kind === "question"
                  ? interaction.request.questions?.map((question) => (
                      <label key={question.question}>
                        {question.question}
                        {question.kind === "single_choice" ? (
                          <select
                            value={String(
                              humanAnswers[interaction.interactionId]?.[question.question] ?? "",
                            )}
                            onChange={(event) =>
                              setHumanAnswer(
                                setHumanAnswers,
                                interaction.interactionId,
                                question.question,
                                event.target.value,
                              )
                            }
                          >
                            <option value="">Choose an option</option>
                            {question.options.map((option) => (
                              <option value={option.label} key={option.label}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : question.kind === "multiple_choice" ? (
                          <span>
                            {question.options.map((option) => {
                              const selected =
                                humanAnswers[interaction.interactionId]?.[question.question];
                              const values = Array.isArray(selected) ? selected : [];
                              return (
                                <label key={option.label}>
                                  <input
                                    type="checkbox"
                                    checked={values.includes(option.label)}
                                    onChange={(event) =>
                                      setHumanAnswer(
                                        setHumanAnswers,
                                        interaction.interactionId,
                                        question.question,
                                        event.target.checked
                                          ? [...values, option.label]
                                          : values.filter((value) => value !== option.label),
                                      )
                                    }
                                  />
                                  {option.label}
                                </label>
                              );
                            })}
                          </span>
                        ) : (
                          <textarea
                            value={String(
                              humanAnswers[interaction.interactionId]?.[question.question] ?? "",
                            )}
                            onChange={(event) =>
                              setHumanAnswer(
                                setHumanAnswers,
                                interaction.interactionId,
                                question.question,
                                event.target.value,
                              )
                            }
                          />
                        )}
                      </label>
                    ))
                  : null}
                <textarea
                  value={humanNotes[interaction.interactionId] ?? ""}
                  onChange={(event) =>
                    setHumanNotes((current) => ({
                      ...current,
                      [interaction.interactionId]: event.target.value,
                    }))
                  }
                  placeholder="Optional notes"
                />
                <footer>
                  {interaction.request.kind === "approval" ? (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          void respond(interaction, {
                            approved: false,
                            decision: "rejected",
                            notes: humanNotes[interaction.interactionId] ?? "",
                          })
                        }
                      >
                        Reject
                      </button>
                      <button
                        className="primary-button"
                        type="button"
                        onClick={() =>
                          void respond(interaction, {
                            approved: true,
                            decision: "approved",
                            notes: humanNotes[interaction.interactionId] ?? "",
                          })
                        }
                      >
                        Approve & continue
                      </button>
                    </>
                  ) : (
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() =>
                        void respond(interaction, {
                          answers: humanAnswers[interaction.interactionId] ?? {},
                          notes: humanNotes[interaction.interactionId] ?? "",
                        })
                      }
                    >
                      Submit response
                    </button>
                  )}
                </footer>
              </section>
            ))}
            <div className="mission-disabled-composer" aria-disabled="true">
              <Paperclip size={20} aria-hidden="true" />
              <span>Use Run to start the pinned executor</span>
              <button type="button" disabled>
                Send
              </button>
            </div>
          </div>
        ) : (
          <div className="mission-work-empty">
            <CheckCircle size={31} weight="thin" aria-hidden="true" />
            <h2>
              {props.mission.execution === undefined
                ? "No execution records"
                : `Execution ${props.mission.execution.status}`}
            </h2>
            <p>
              {props.mission.execution === undefined
                ? "Run this mission to create an execution."
                : `Execution ID: ${props.mission.execution.id}`}
            </p>
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

function setHumanAnswer(
  update: Dispatch<SetStateAction<Record<string, Record<string, string | readonly string[]>>>>,
  interactionId: string,
  question: string,
  value: string | readonly string[],
): void {
  update((current) => ({
    ...current,
    [interactionId]: { ...current[interactionId], [question]: value },
  }));
}

function desktopApi(): PragmaDesktopAPI | undefined {
  return typeof window === "undefined" ? undefined : window.pragmaDesktop;
}
