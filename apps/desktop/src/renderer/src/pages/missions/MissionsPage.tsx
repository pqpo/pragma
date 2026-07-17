import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";

import {
  ArrowCounterClockwise,
  Brain,
  Books,
  CaretDown,
  Check,
  CheckCircle,
  Files,
  Folder,
  GitBranch,
  MagnifyingGlass,
  Paperclip,
  PaperPlaneTilt,
  Plus,
  Play,
  Stack,
  StopCircle,
  Toolbox,
  Trash,
  User,
  UsersThree,
} from "@phosphor-icons/react";
import type { PragmaInvocableResource, PragmaResource } from "@pragma/interpreter/ast";
import type { HumanInteractionResponse } from "@pragma/shared";

import {
  isMissionExecutorResource,
  missionExecutorKind,
  missionExecutorRef,
  type Mission,
  type MissionChatEntry,
  type MissionChatSnapshot,
  type MissionHumanInteraction,
  type MissionSummary,
  type MissionWorkItem,
  type PragmaDesktopAPI,
} from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";
import { formatMissionDateTime, formatMissionTime } from "../../lib/mission-time.ts";

type MissionScreen = "create" | "detail";

export function MissionsPage(props: { readonly initialExecutorRef?: string | undefined }) {
  const [missions, setMissions] = useState<readonly MissionSummary[]>([]);
  const [selectedMission, setSelectedMission] = useState<Mission | null>(null);
  const [executors, setExecutors] = useState<readonly PragmaResource[]>([]);
  const [screen, setScreen] = useState<MissionScreen>("create");
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<MissionSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const selectedMissionIdRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) return;
    let cancelled = false;
    void Promise.all([api.listMissions(), api.getPragmaProject()])
      .then(([storedMissions, project]) => {
        if (cancelled) return;
        setMissions(storedMissions);
        setExecutors(project.resources.filter(isMissionExecutorResource));
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
    setSelectedMission((current) => (current?.id === updated.id ? updated : current));
    setMissions((current) =>
      [
        ...current.filter((mission) => mission.id !== updated.id),
        missionToSummary(updated),
      ].toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    );
  };

  return (
    <section className="missions-page">
      <MissionRail
        missions={visibleMissions}
        search={search}
        now={now}
        selectedMissionId={screen === "detail" ? selectedMissionId : null}
        onSearch={setSearch}
        onCreate={() => {
          selectedMissionIdRef.current = null;
          setScreen("create");
          setSelectedMissionId(null);
          setSelectedMission(null);
          setError(null);
        }}
        onOpen={(summary) => {
          selectedMissionIdRef.current = summary.id;
          setSelectedMissionId(summary.id);
          setSelectedMission(null);
          setScreen("detail");
          setError(null);
          const api = desktopApi();
          if (api !== undefined) {
            void api
              .getMission(summary.id)
              .then((mission) => {
                if (selectedMissionIdRef.current === summary.id) setSelectedMission(mission);
              })
              .catch((loadError: unknown) => {
                if (selectedMissionIdRef.current === summary.id) {
                  setError(errorMessage(loadError));
                }
              });
          }
        }}
        onDelete={setDeleteCandidate}
      />

      <div className="mission-main">
        {screen === "create" ? (
          <CreateMissionFragment
            executors={executors}
            initialExecutorRef={props.initialExecutorRef}
            onCreated={async (mission) => {
              setMissions((current) => [missionToSummary(mission), ...current]);
              selectedMissionIdRef.current = mission.id;
              setSelectedMissionId(mission.id);
              setSelectedMission(mission);
              setScreen("detail");
              setError(null);
              const api = desktopApi();
              if (api === undefined) return;
              try {
                replaceMission(await api.runMission(mission.id));
              } catch (runError) {
                setError(errorMessage(runError));
              }
            }}
          />
        ) : selectedMission !== null ? (
          <MissionDetailFragment
            mission={selectedMission}
            onSend={async (content) => {
              const api = desktopApi();
              if (api === undefined) return;
              try {
                replaceMission(
                  await api.sendMissionMessage({
                    id: selectedMission.id,
                    content,
                    requestId: crypto.randomUUID(),
                  }),
                );
                setError(null);
              } catch (sendError) {
                setError(errorMessage(sendError));
                throw sendError;
              }
            }}
            onRun={async () => {
              const api = desktopApi();
              if (api === undefined) return;
              replaceMission(await api.runMission(selectedMission.id));
            }}
            onInterrupt={async () => {
              const api = desktopApi();
              if (api === undefined) return;
              replaceMission(await api.interruptMission(selectedMission.id));
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
      {deleteCandidate !== null ? (
        <div className="mission-dialog-backdrop">
          <section
            className="mission-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-mission-title"
            aria-describedby="delete-mission-description"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !deleting) setDeleteCandidate(null);
            }}
          >
            <h2 id="delete-mission-title">Delete this mission?</h2>
            <p id="delete-mission-description">
              “{deleteCandidate.title}” and its conversation will be removed from Missions. This
              cannot be undone.
            </p>
            <footer>
              <button
                className="secondary-button"
                type="button"
                disabled={deleting}
                autoFocus
                onClick={() => setDeleteCandidate(null)}
              >
                Cancel
              </button>
              <button
                className="danger-button"
                type="button"
                disabled={deleting}
                onClick={() => {
                  const api = desktopApi();
                  if (api === undefined) return;
                  setDeleting(true);
                  void api
                    .deleteMission(deleteCandidate.id)
                    .then(() => {
                      setMissions((current) =>
                        current.filter((mission) => mission.id !== deleteCandidate.id),
                      );
                      if (selectedMissionId === deleteCandidate.id) {
                        selectedMissionIdRef.current = null;
                        setSelectedMissionId(null);
                        setSelectedMission(null);
                        setScreen("create");
                      }
                      setDeleteCandidate(null);
                      setError(null);
                    })
                    .catch((deleteError: unknown) => {
                      setError(errorMessage(deleteError));
                      setDeleteCandidate(null);
                    })
                    .finally(() => setDeleting(false));
                }}
              >
                <Trash size={17} aria-hidden="true" />
                {deleting ? "Deleting…" : "Delete mission"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function MissionRail(props: {
  readonly missions: readonly MissionSummary[];
  readonly search: string;
  readonly now: number;
  readonly selectedMissionId: string | null;
  readonly onSearch: (value: string) => void;
  readonly onCreate: () => void;
  readonly onOpen: (mission: MissionSummary) => void;
  readonly onDelete: (mission: MissionSummary) => void;
}) {
  const active = props.missions.filter((mission) => mission.lifecycleStatus === "active");
  const completed = props.missions.filter((mission) => mission.lifecycleStatus === "completed");
  return (
    <aside className="mission-rail">
      <h1>Missions</h1>
      <button className="mission-new-button" type="button" onClick={props.onCreate}>
        <Plus size={18} aria-hidden="true" />
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
        now={props.now}
        selectedMissionId={props.selectedMissionId}
        onOpen={props.onOpen}
        onDelete={props.onDelete}
      />
      <MissionRailGroup
        label="Completed"
        missions={completed}
        now={props.now}
        selectedMissionId={props.selectedMissionId}
        onOpen={props.onOpen}
        onDelete={props.onDelete}
      />
    </aside>
  );
}

function MissionRailGroup(props: {
  readonly label: string;
  readonly missions: readonly MissionSummary[];
  readonly now: number;
  readonly selectedMissionId: string | null;
  readonly onOpen: (mission: MissionSummary) => void;
  readonly onDelete: (mission: MissionSummary) => void;
}) {
  return (
    <section className="mission-rail-group">
      <h2>{props.label}</h2>
      {props.missions.length === 0 ? (
        <p className="mission-rail-empty">No {props.label.toLocaleLowerCase()} missions</p>
      ) : (
        props.missions.map((mission) => {
          const executionActive =
            mission.execution !== undefined &&
            ["queued", "running", "waiting"].includes(mission.execution.status);
          return (
            <div
              className={
                mission.id === props.selectedMissionId ? "mission-row is-active" : "mission-row"
              }
              key={mission.id}
            >
              <button
                className="mission-row-open"
                type="button"
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
                  <small>
                    <span>{missionStatusLabel(mission)}</span>
                    <time
                      dateTime={mission.updatedAt}
                      title={formatMissionDateTime(mission.updatedAt)}
                    >
                      {formatMissionTime(mission.updatedAt, props.now)}
                    </time>
                  </small>
                </span>
              </button>
              <button
                className="mission-row-delete"
                type="button"
                disabled={executionActive}
                title={executionActive ? "Wait for this execution to finish" : "Delete mission"}
                aria-label={`Delete ${mission.title}`}
                onClick={() => props.onDelete(mission)}
              >
                <Trash size={15} aria-hidden="true" />
              </button>
            </div>
          );
        })
      )}
    </section>
  );
}

export function CreateMissionFragment(props: {
  readonly executors: readonly PragmaResource[];
  readonly initialExecutorRef?: string | undefined;
  readonly onCreated: (mission: Mission) => void | Promise<void>;
}) {
  const [workspace, setWorkspace] = useState<{ path: string; basename: string } | null>(null);
  const [executorRef, setExecutorRef] = useState(props.initialExecutorRef ?? "");
  const [goal, setGoal] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const executors = useMemo(
    () => props.executors.filter(isMissionExecutorResource),
    [props.executors],
  );
  const selectedExecutor = executors.find(
    (executor) => missionExecutorRef(executor) === executorRef,
  );
  const hasValidExecutor = selectedExecutor !== undefined;

  useEffect(() => {
    if (hasValidExecutor) return;
    const requested = executors.find(
      (executor) => missionExecutorRef(executor) === props.initialExecutorRef,
    );
    const fallback = requested ?? (executors.length === 1 ? executors[0] : undefined);
    const nextRef = fallback === undefined ? "" : missionExecutorRef(fallback);
    if (nextRef !== executorRef) setExecutorRef(nextRef);
  }, [executorRef, executors, hasValidExecutor, props.initialExecutorRef]);

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
    if (api === undefined || workspace === null || !hasValidExecutor || goal.trim() === "") return;
    setSaving(true);
    setError(null);
    try {
      const mission = await api.createMission({
        workspace: workspace.path,
        executor: { ref: executorRef },
        goal: goal.trim(),
      });
      await props.onCreated(mission);
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
          <span className="mission-selector-copy">
            <small>Workspace</small>
            <strong>{workspace?.basename ?? "Choose a folder"}</strong>
            <em>{workspace?.path ?? "One working directory per mission"}</em>
          </span>
        </button>
        <MissionExecutorPicker
          executors={executors}
          value={hasValidExecutor ? executorRef : ""}
          onChange={setExecutorRef}
        />
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
          <div className="mission-prompt-tools" aria-label="Mission context and tools">
            <button
              type="button"
              aria-disabled="true"
              title={
                !hasValidExecutor
                  ? "Choose an executor to inherit its context"
                  : "Context is inherited from the selected executor"
              }
            >
              <Stack size={18} aria-hidden="true" />
              Context
            </button>
            <button
              className={workspace === null ? "" : "is-active"}
              type="button"
              onClick={() => void pickWorkspace()}
              title={workspace?.path ?? "Choose files through a mission workspace"}
            >
              <Files size={18} aria-hidden="true" />
              Files
            </button>
            <button
              type="button"
              aria-disabled="true"
              title={
                !hasValidExecutor
                  ? "Choose an executor to inherit its knowledge"
                  : "Knowledge is managed by the selected executor"
              }
            >
              <Books size={18} aria-hidden="true" />
              Knowledge
            </button>
            <button
              type="button"
              aria-disabled="true"
              title={
                !hasValidExecutor
                  ? "Choose an executor to inherit its tools"
                  : "Tools are managed by the selected executor"
              }
            >
              <Toolbox size={18} aria-hidden="true" />
              Tools
            </button>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={saving || workspace === null || !hasValidExecutor || goal.trim() === ""}
            onClick={() => void submit()}
          >
            {saving ? "Starting…" : "Start mission"}
          </button>
        </footer>
      </div>
      {executors.length === 0 ? (
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

function MissionExecutorPicker(props: {
  readonly executors: readonly PragmaInvocableResource[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = props.executors.find((executor) => missionExecutorRef(executor) === props.value);
  const visibleExecutors = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (query === "") return props.executors;
    return props.executors.filter((executor) =>
      [
        executor.metadata.name,
        executor.metadata.description,
        executor.metadata.id,
        missionExecutorKind(executor),
      ].some((value) => value.toLocaleLowerCase().includes(query)),
    );
  }, [props.executors, search]);
  const SelectedIcon = selected === undefined ? UsersThree : executorIcon(selected);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
        setSearch("");
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div
      className={
        open
          ? "mission-selector mission-executor-picker is-open"
          : "mission-selector mission-executor-picker"
      }
      ref={rootRef}
    >
      <span className="mission-selector-icon">
        <SelectedIcon size={23} aria-hidden="true" />
      </span>
      <div className="mission-selector-copy">
        <small>Executor</small>
        <button
          className="mission-executor-trigger"
          type="button"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => {
            setOpen((current) => !current);
            setSearch("");
          }}
        >
          <strong>{selected?.metadata.name ?? "Choose an expert, team, or flow"}</strong>
          <CaretDown size={16} aria-hidden="true" />
        </button>
        <em>
          {selected === undefined
            ? "Only executable Studio resources are shown"
            : `${executorLabel(selected)} · ${selected.metadata.version}`}
        </em>
        {open ? (
          <div
            className="mission-executor-menu"
            role="dialog"
            aria-modal="false"
            aria-label="Choose mission executor"
          >
            <header>
              <div>
                <strong>Choose executor</strong>
                <small>Experts, teams, and flows can run missions.</small>
              </div>
              <span>{props.executors.length} available</span>
            </header>
            {props.executors.length > 5 ? (
              <label className="mission-executor-search">
                <MagnifyingGlass size={17} aria-hidden="true" />
                <span className="sr-only">Search executors</span>
                <input
                  autoFocus
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search executors"
                />
              </label>
            ) : null}
            <div className="mission-executor-options" role="list" aria-label="Mission executors">
              {visibleExecutors.map((executor, index) => {
                const ref = missionExecutorRef(executor);
                const kind = missionExecutorKind(executor);
                const Icon = executorIcon(executor);
                const isSelected = ref === props.value;
                return (
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    autoFocus={props.executors.length <= 5 && index === 0}
                    className={
                      isSelected ? "mission-executor-option is-selected" : "mission-executor-option"
                    }
                    key={ref}
                    onClick={() => {
                      props.onChange(ref);
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <span className="mission-executor-option-icon">
                      <Icon size={18} aria-hidden="true" />
                    </span>
                    <span>
                      <strong>{executor.metadata.name}</strong>
                      <small>{executor.metadata.description}</small>
                    </span>
                    <span className="mission-executor-option-kind">{kind}</span>
                    {isSelected ? <Check size={17} aria-hidden="true" /> : null}
                  </button>
                );
              })}
              {visibleExecutors.length === 0 ? (
                <div className="mission-executor-empty">
                  <strong>No executors found</strong>
                  <span>Try another name or description.</span>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function executorIcon(resource: PragmaInvocableResource) {
  return resource.kind === "Expert"
    ? User
    : resource.kind === "ExpertTeam"
      ? UsersThree
      : GitBranch;
}

function executorLabel(resource: PragmaInvocableResource): string {
  return resource.kind === "Expert"
    ? "Expert"
    : resource.kind === "ExpertTeam"
      ? "Expert team"
      : "Flow";
}

export function MissionDetailFragment(props: {
  readonly mission: Mission;
  readonly onRun?: () => void | Promise<void>;
  readonly onInterrupt?: () => void | Promise<void>;
  readonly onSend?: (content: string) => void | Promise<void>;
  readonly onHumanResponded?: () => void | Promise<void>;
  readonly onLifecycleChange?: () => void | Promise<void>;
}) {
  const [tab, setTab] = useState<"chat" | "work">("chat");
  const [workspaceAvailable, setWorkspaceAvailable] = useState<boolean | null>(null);
  const [chat, setChat] = useState<MissionChatSnapshot | null>(null);
  const [workItems, setWorkItems] = useState<readonly MissionWorkItem[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [responding, setResponding] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [humanQuestionIndex, setHumanQuestionIndex] = useState(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [humanNotes, setHumanNotes] = useState<Record<string, string>>({});
  const [humanAnswers, setHumanAnswers] = useState<
    Record<string, Record<string, string | readonly string[]>>
  >({});
  const isTeam = props.mission.executor.kind === "team";
  const isFlow = props.mission.executor.kind === "flow";
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);
  const prependScrollHeightRef = useRef<number | null>(null);
  const executionStatus = chat?.execution?.status ?? props.mission.execution?.status;
  const executionActive =
    executionStatus !== undefined && ["queued", "running", "waiting"].includes(executionStatus);
  const interactions = chat?.pendingInteractions ?? [];
  const interruptible = chat?.execution?.interruptible ?? false;

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
    setChat(null);
    setHistoryError(null);
    setHumanQuestionIndex(0);
    followLatestRef.current = true;
    setShowJumpToLatest(false);
    if (api === undefined) return;
    let cancelled = false;
    let refreshing = false;
    let refreshQueued = false;
    const refresh = async (): Promise<void> => {
      if (refreshing) {
        refreshQueued = true;
        return;
      }
      refreshing = true;
      try {
        const snapshot = await api.getMissionChat({ id: props.mission.id, limit: 50 });
        if (!cancelled) setChat((current) => mergeLatestChatPage(current, snapshot));
      } catch (loadError) {
        if (!cancelled) console.error("Failed to refresh Mission chat.", loadError);
      } finally {
        refreshing = false;
        if (refreshQueued && !cancelled) {
          refreshQueued = false;
          void refresh();
        }
      }
    };
    const unsubscribe = api.subscribeMissionChat(props.mission.id, () => void refresh());
    void refresh();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [props.mission.id]);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined || tab !== "work" || props.mission.execution === undefined) {
      setWorkItems([]);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void api
        .listMissionWorkItems(props.mission.id)
        .then((items) => {
          if (!cancelled) setWorkItems(items);
        })
        .catch((loadError: unknown) => {
          if (!cancelled) console.error("Failed to refresh Mission work items.", loadError);
        });
    };
    refresh();
    const timer = executionActive ? setInterval(refresh, 1_000) : undefined;
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [executionActive, props.mission.id, props.mission.execution?.id, tab]);

  const send = async () => {
    const content = draft.trim();
    if (content === "" || sending || executionActive || isFlow) return;
    setSending(true);
    try {
      await props.onSend?.(content);
      setDraft("");
    } finally {
      setSending(false);
    }
  };

  const interrupt = async () => {
    if (interrupting || !interruptible) return;
    setInterrupting(true);
    try {
      await props.onInterrupt?.();
    } finally {
      setInterrupting(false);
    }
  };

  const respond = async (
    interaction: MissionHumanInteraction,
    response: HumanInteractionResponse,
  ) => {
    const api = desktopApi();
    if (api === undefined || responding) return;
    setResponding(true);
    try {
      await api.respondToMissionHumanInteraction({
        missionId: props.mission.id,
        interactionId: interaction.interactionId,
        requestId: crypto.randomUUID(),
        response,
      });
      setChat((current) =>
        current === null
          ? current
          : {
              ...current,
              pendingInteractions: current.pendingInteractions.filter(
                (item) => item.interactionId !== interaction.interactionId,
              ),
            },
      );
      setHumanQuestionIndex(0);
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
    } finally {
      setResponding(false);
    }
  };

  const displayEntries = chat?.entries ?? [];
  const lastEntry = displayEntries.at(-1);
  const lastEntryFingerprint =
    lastEntry === undefined
      ? "empty"
      : `${lastEntry.id}:${lastEntry.kind}:${entryContentLength(lastEntry)}`;

  const loadEarlier = async (): Promise<void> => {
    const api = desktopApi();
    const beforeSequence = chat?.page.nextBeforeSequence;
    if (api === undefined || beforeSequence === undefined || loadingEarlier) return;
    setLoadingEarlier(true);
    setHistoryError(null);
    const element = scrollRef.current;
    prependScrollHeightRef.current = element?.scrollHeight ?? null;
    followLatestRef.current = false;
    try {
      const earlier = await api.getMissionChat({
        id: props.mission.id,
        beforeSequence,
        limit: 50,
      });
      setChat((current) => (current === null ? earlier : prependChatPage(current, earlier)));
    } catch (loadError) {
      setHistoryError(errorMessage(loadError));
    } finally {
      setLoadingEarlier(false);
    }
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    if (prependScrollHeightRef.current !== null) {
      element.scrollTop += element.scrollHeight - prependScrollHeightRef.current;
      prependScrollHeightRef.current = null;
      setShowJumpToLatest(true);
      return;
    }
    if (followLatestRef.current) {
      element.scrollTop = element.scrollHeight;
      setShowJumpToLatest(false);
    } else {
      setShowJumpToLatest(true);
    }
  }, [displayEntries.length, lastEntryFingerprint, interactions.length]);

  return (
    <section className="mission-detail">
      <header className="mission-detail-header">
        <div>
          <h1>{props.mission.title}</h1>
          <p>
            <span className="mission-ready-dot" aria-hidden="true" />
            {missionStatusLabel(props.mission)}
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
          {props.mission.lifecycleStatus === "active" &&
          (props.mission.execution === undefined ||
            (!executionActive && isFlow) ||
            (executionActive && !interruptible)) ? (
            <button className="primary-button" type="button" onClick={() => void props.onRun?.()}>
              <Play size={17} />
              {executionActive
                ? "Resume"
                : props.mission.execution === undefined
                  ? "Run"
                  : "Run workflow again"}
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
          <div className="mission-chat-shell">
            <div
              className="mission-chat-scroll"
              ref={scrollRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                const nearBottom =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 72;
                followLatestRef.current = nearBottom;
                if (nearBottom) setShowJumpToLatest(false);
              }}
            >
              <div className="mission-chat-list">
                {chat?.page.nextBeforeSequence !== undefined ? (
                  <button
                    className="mission-load-earlier"
                    type="button"
                    disabled={loadingEarlier}
                    onClick={() => void loadEarlier()}
                  >
                    {loadingEarlier ? "Loading…" : "Load earlier messages"}
                  </button>
                ) : null}
                {historyError === null ? null : (
                  <p className="mission-history-error" role="alert">
                    {historyError}
                  </p>
                )}
                {displayEntries.map((entry) => (
                  <MissionChatEntryView
                    entry={entry}
                    executorName={props.mission.executor.name}
                    isTeam={isTeam}
                    isFlow={isFlow}
                    key={entry.id}
                  />
                ))}
              </div>
              {showJumpToLatest ? (
                <button
                  className="mission-jump-latest"
                  type="button"
                  onClick={() => {
                    const element = scrollRef.current;
                    if (element !== null) element.scrollTop = element.scrollHeight;
                    followLatestRef.current = true;
                    setShowJumpToLatest(false);
                  }}
                >
                  <CaretDown size={15} aria-hidden="true" /> Jump to latest
                </button>
              ) : null}
            </div>
            <div className="mission-chat-footer">
              {missionFooterTip(props.mission, chat) ? (
                <small className="mission-chat-footer-tip">
                  {missionFooterTip(props.mission, chat)}
                </small>
              ) : null}
              {interactions[0] !== undefined ? (
                <MissionHumanComposer
                  interaction={interactions[0]}
                  answers={humanAnswers[interactions[0].interactionId] ?? {}}
                  notes={humanNotes[interactions[0].interactionId] ?? ""}
                  questionIndex={humanQuestionIndex}
                  interactionPosition={{ current: 1, total: interactions.length }}
                  responding={responding}
                  interruptible={interruptible}
                  interrupting={interrupting}
                  onQuestionIndex={setHumanQuestionIndex}
                  onAnswer={(question, value) =>
                    setHumanAnswer(setHumanAnswers, interactions[0]!.interactionId, question, value)
                  }
                  onNotes={(value) =>
                    setHumanNotes((current) => ({
                      ...current,
                      [interactions[0]!.interactionId]: value,
                    }))
                  }
                  onRespond={(response) => void respond(interactions[0]!, response)}
                  onInterrupt={() => void interrupt()}
                />
              ) : (
                <div className="mission-chat-composer">
                  {isFlow ? (
                    <GitBranch size={20} aria-hidden="true" />
                  ) : (
                    <Paperclip size={20} aria-hidden="true" />
                  )}
                  <textarea
                    value={draft}
                    disabled={
                      isFlow ||
                      sending ||
                      executionActive ||
                      props.mission.lifecycleStatus === "completed"
                    }
                    placeholder={
                      executionActive
                        ? interruptible
                          ? `${props.mission.executor.name} is working…`
                          : "Resume this execution to manage it"
                        : props.mission.lifecycleStatus === "completed"
                          ? "Reopen this mission to continue the conversation"
                          : isFlow
                            ? "Flow input continues through workflow steps"
                            : `Message ${props.mission.executor.name}`
                    }
                    aria-label={`Message ${props.mission.executor.name}`}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                  />
                  {executionActive ? (
                    <button
                      className="is-interrupt"
                      type="button"
                      aria-label="Interrupt execution"
                      title={
                        interruptible
                          ? "Interrupt execution"
                          : "Resume this execution before interrupting it"
                      }
                      disabled={!interruptible || interrupting}
                      onClick={() => void interrupt()}
                    >
                      <StopCircle size={19} weight="fill" aria-hidden="true" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label="Send message"
                      disabled={
                        isFlow ||
                        draft.trim() === "" ||
                        sending ||
                        props.mission.lifecycleStatus === "completed"
                      }
                      onClick={() => void send()}
                    >
                      <PaperPlaneTilt size={18} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : workItems.length === 0 ? (
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
        ) : (
          <div className="mission-work-list" aria-label="Mission execution work">
            <header>
              <h2>Execution map</h2>
              <p>Workflow steps and delegated experts share the same execution tree.</p>
            </header>
            <ol>
              {workItems.map((item) => (
                <li
                  key={item.invocationId}
                  style={
                    { "--mission-work-depth": workItemDepth(item, workItems) } as CSSProperties
                  }
                >
                  <span className={`mission-work-status is-${item.status}`} aria-hidden="true" />
                  <div>
                    <strong>{item.nodeId ?? item.executorId ?? item.kind}</strong>
                    <small>
                      {item.kind} · {item.status}
                    </small>
                    <p>{item.outputSummary ?? item.inputSummary}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </section>
  );
}

function MissionChatEntryView(props: {
  readonly entry: MissionChatEntry;
  readonly executorName: string;
  readonly isTeam: boolean;
  readonly isFlow: boolean;
}) {
  const name = props.entry.executorName ?? props.entry.executorId ?? props.executorName;
  if (props.entry.kind === "user") {
    return (
      <div className="mission-user-message">
        <span aria-hidden="true">You</span>
        <div>
          <strong>You</strong>
          <p>{props.entry.content}</p>
        </div>
      </div>
    );
  }
  if (props.entry.kind === "thinking") {
    return (
      <details className="mission-chat-activity mission-thinking-entry">
        <summary>
          <Brain size={17} aria-hidden="true" />
          <span>{props.entry.streaming ? `${name} is thinking…` : `Thinking · ${name}`}</span>
          <CaretDown size={15} aria-hidden="true" />
        </summary>
        <p>{props.entry.content}</p>
      </details>
    );
  }
  if (props.entry.kind === "tool") {
    return (
      <details className={`mission-chat-activity mission-tool-entry is-${props.entry.status}`}>
        <summary>
          <Toolbox size={17} aria-hidden="true" />
          <span>{props.entry.toolName}</span>
          <small>{toolStatusLabel(props.entry.status)}</small>
          {props.entry.status === "succeeded" ? (
            <Check size={15} aria-hidden="true" />
          ) : (
            <CaretDown size={15} aria-hidden="true" />
          )}
        </summary>
        {props.entry.inputPreview !== undefined ? (
          <div>
            <strong>Input</strong>
            <pre>{props.entry.inputPreview}</pre>
          </div>
        ) : null}
        {props.entry.outputPreview !== undefined ? (
          <div>
            <strong>Output</strong>
            <pre>{props.entry.outputPreview}</pre>
          </div>
        ) : null}
        {props.entry.error !== undefined ? <p role="alert">{props.entry.error}</p> : null}
      </details>
    );
  }
  return (
    <div className="mission-assistant-message">
      <span aria-hidden="true">
        {props.isTeam ? (
          <UsersThree size={18} />
        ) : props.isFlow ? (
          <GitBranch size={18} />
        ) : (
          <User size={18} />
        )}
      </span>
      <div>
        <strong>{name}</strong>
        <p>{props.entry.content}</p>
      </div>
    </div>
  );
}

type MissionHumanQuestion = NonNullable<MissionHumanInteraction["request"]["questions"]>[number];

function MissionHumanComposer(props: {
  readonly interaction: MissionHumanInteraction;
  readonly answers: Readonly<Record<string, string | readonly string[]>>;
  readonly notes: string;
  readonly questionIndex: number;
  readonly interactionPosition: { readonly current: number; readonly total: number };
  readonly responding: boolean;
  readonly interruptible: boolean;
  readonly interrupting: boolean;
  readonly onQuestionIndex: (index: number) => void;
  readonly onAnswer: (question: string, value: string | readonly string[]) => void;
  readonly onNotes: (value: string) => void;
  readonly onRespond: (response: HumanInteractionResponse) => void;
  readonly onInterrupt: () => void;
}) {
  const request = props.interaction.request;
  const questions = request.questions ?? [];
  const index = Math.min(props.questionIndex, Math.max(questions.length - 1, 0));
  const question = questions[index];
  const answer = question === undefined ? undefined : props.answers[question.question];
  const answerValid = question === undefined ? true : humanAnswerValid(question, answer);

  return (
    <section className="mission-human-composer" aria-labelledby="mission-human-title">
      <header>
        <div>
          <small>
            User input · {props.interactionPosition.current}/{props.interactionPosition.total}
          </small>
          <strong id="mission-human-title">{request.title ?? "Human input required"}</strong>
          <p>{request.prompt ?? "Review the current execution before continuing."}</p>
        </div>
        <button
          className="mission-human-interrupt"
          type="button"
          disabled={!props.interruptible || props.interrupting}
          onClick={props.onInterrupt}
        >
          <StopCircle size={17} weight="fill" aria-hidden="true" /> Interrupt
        </button>
      </header>
      {request.kind === "approval" ? (
        <>
          {request.data === undefined ? null : <pre>{formatInteractionData(request.data)}</pre>}
          <textarea
            value={props.notes}
            onChange={(event) => props.onNotes(event.target.value)}
            placeholder="Optional notes"
          />
          <footer>
            <button
              type="button"
              disabled={props.responding}
              onClick={() =>
                props.onRespond({
                  approved: false,
                  decision: "rejected",
                  notes: props.notes,
                })
              }
            >
              Reject
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={props.responding}
              onClick={() =>
                props.onRespond({
                  approved: true,
                  decision: "approved",
                  notes: props.notes,
                })
              }
            >
              {props.responding ? "Submitting…" : "Approve & continue"}
            </button>
          </footer>
        </>
      ) : question === undefined ? (
        <footer>
          <button
            className="primary-button"
            type="button"
            disabled={props.responding}
            onClick={() => props.onRespond({ notes: props.notes })}
          >
            Continue
          </button>
        </footer>
      ) : (
        <>
          <div className="mission-human-question">
            <small>
              Question {index + 1} of {questions.length} · {question.header}
            </small>
            <strong>{question.question}</strong>
            <HumanQuestionInput question={question} answer={answer} onAnswer={props.onAnswer} />
          </div>
          <textarea
            value={props.notes}
            onChange={(event) => props.onNotes(event.target.value)}
            placeholder="Optional notes"
          />
          <footer>
            <button
              type="button"
              disabled={index === 0 || props.responding}
              onClick={() => props.onQuestionIndex(index - 1)}
            >
              Back
            </button>
            {index < questions.length - 1 ? (
              <button
                className="primary-button"
                type="button"
                disabled={!answerValid || props.responding}
                onClick={() => props.onQuestionIndex(index + 1)}
              >
                Next
              </button>
            ) : (
              <button
                className="primary-button"
                type="button"
                disabled={!answerValid || props.responding}
                onClick={() =>
                  props.onRespond({
                    answers: props.answers,
                    notes: props.notes,
                  })
                }
              >
                {props.responding ? "Submitting…" : "Submit response"}
              </button>
            )}
          </footer>
        </>
      )}
    </section>
  );
}

function HumanQuestionInput(props: {
  readonly question: MissionHumanQuestion;
  readonly answer: string | readonly string[] | undefined;
  readonly onAnswer: (question: string, value: string | readonly string[]) => void;
}) {
  if (props.question.kind === "text") {
    return (
      <textarea
        value={typeof props.answer === "string" ? props.answer : ""}
        onChange={(event) => props.onAnswer(props.question.question, event.target.value)}
        autoFocus
      />
    );
  }
  if (props.question.kind === "single_choice") {
    return (
      <div className="mission-human-options">
        {props.question.options.map((option) => (
          <button
            className={props.answer === option.label ? "is-selected" : ""}
            type="button"
            key={option.label}
            onClick={() => props.onAnswer(props.question.question, option.label)}
          >
            <strong>{option.label}</strong>
            {option.description === "" ? null : <small>{option.description}</small>}
          </button>
        ))}
      </div>
    );
  }
  const selected = Array.isArray(props.answer) ? props.answer : [];
  return (
    <div className="mission-human-options is-multiple">
      {props.question.options.map((option) => (
        <label key={option.label}>
          <input
            type="checkbox"
            checked={selected.includes(option.label)}
            onChange={(event) =>
              props.onAnswer(
                props.question.question,
                event.target.checked
                  ? [...selected, option.label]
                  : selected.filter((value) => value !== option.label),
              )
            }
          />
          <span>
            <strong>{option.label}</strong>
            {option.description === "" ? null : <small>{option.description}</small>}
          </span>
        </label>
      ))}
    </div>
  );
}

function humanAnswerValid(
  question: MissionHumanQuestion,
  answer: string | readonly string[] | undefined,
): boolean {
  if (question.kind === "multiple_choice") return Array.isArray(answer) && answer.length > 0;
  return typeof answer === "string" && answer.trim() !== "";
}

function entryContentLength(entry: MissionChatEntry): number {
  if (entry.kind === "tool") {
    return (entry.inputPreview?.length ?? 0) + (entry.outputPreview?.length ?? 0);
  }
  return entry.content.length;
}

function mergeLatestChatPage(
  current: MissionChatSnapshot | null,
  latest: MissionChatSnapshot,
): MissionChatSnapshot {
  if (current === null) return latest;
  const latestOldest = latest.page.oldestSequence;
  const retainedOlder =
    latestOldest === undefined
      ? []
      : current.entries.filter(
          (entry) => entry.timelineSequence !== undefined && entry.timelineSequence < latestOldest,
        );
  return { ...latest, entries: uniqueChatEntries([...retainedOlder, ...latest.entries]) };
}

function prependChatPage(
  current: MissionChatSnapshot,
  earlier: MissionChatSnapshot,
): MissionChatSnapshot {
  return {
    ...current,
    revision: Math.max(current.revision, earlier.revision),
    entries: uniqueChatEntries([...earlier.entries, ...current.entries]),
    page: {
      ...(earlier.page.oldestSequence === undefined
        ? {}
        : { oldestSequence: earlier.page.oldestSequence }),
      ...(current.page.newestSequence === undefined
        ? {}
        : { newestSequence: current.page.newestSequence }),
      ...(earlier.page.nextBeforeSequence === undefined
        ? {}
        : { nextBeforeSequence: earlier.page.nextBeforeSequence }),
    },
  };
}

function uniqueChatEntries(entries: readonly MissionChatEntry[]): MissionChatEntry[] {
  const byId = new Map<string, MissionChatEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
}

function missionFooterTip(mission: Mission, chat: MissionChatSnapshot | null): string | null {
  if (mission.lifecycleStatus === "completed") {
    return "Reopen this mission to continue the conversation.";
  }
  const execution = chat?.execution ?? mission.execution;
  if (execution === undefined) return null;
  if (execution.status === "failed") return execution.error ?? "Execution failed.";
  if (execution.status === "cancelled") {
    return "Execution interrupted. You can continue the conversation.";
  }
  if (
    ["queued", "running", "waiting"].includes(execution.status) &&
    chat?.execution?.interruptible === false
  ) {
    return "Resume this execution before interrupting it.";
  }
  return null;
}

function toolStatusLabel(status: Extract<MissionChatEntry, { kind: "tool" }>["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "approval_required":
      return "Approval required";
    case "succeeded":
      return "Completed";
    case "failed":
      return "Failed";
  }
}

function formatInteractionData(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function workItemDepth(item: MissionWorkItem, items: readonly MissionWorkItem[]): number {
  const byId = new Map(items.map((candidate) => [candidate.invocationId, candidate]));
  let depth = 0;
  let parentId = item.parentInvocationId;
  const visited = new Set<string>();
  while (parentId !== undefined && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parentInvocationId;
  }
  return Math.min(depth, 6);
}

function missionStatusLabel(mission: Mission | MissionSummary): string {
  if (mission.lifecycleStatus === "completed") return "Completed";
  switch (mission.execution?.status) {
    case "queued":
      return "Queued";
    case "running":
      return "Working";
    case "waiting":
      return "Needs input";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Ready";
  }
}

function missionToSummary(mission: Mission): MissionSummary {
  return {
    id: mission.id,
    title: mission.title,
    workspace: { basename: mission.workspace.basename },
    executor: { kind: mission.executor.kind, name: mission.executor.name },
    ...(mission.execution === undefined ? {} : { execution: { status: mission.execution.status } }),
    lifecycleStatus: mission.lifecycleStatus,
    updatedAt: mission.updatedAt,
  };
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
