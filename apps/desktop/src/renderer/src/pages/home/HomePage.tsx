import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ArrowUp,
  CaretDown,
  Check,
  Folder,
  FolderOpen,
  GitBranch,
  MagnifyingGlass,
  User,
  UsersThree,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import type {
  DesktopRuntimeModel,
  DesktopToolPermissionMode,
  Mission,
  MissionExecutorOption,
  MissionModelOverride,
} from "../../../../shared/desktop-api.ts";
import { ToolPermissionSelect } from "../../components/ToolPermissionSelect.tsx";
import { MissionModelOverrideControls } from "../../components/MissionModelOverrideControls.tsx";
import { errorMessage } from "../../lib/errors.ts";

interface WorkspaceSelection {
  readonly path: string;
  readonly basename: string;
}

export function HomePage(props: {
  readonly initialExecutorRef?: string | undefined;
  readonly onCreated: (mission: Mission) => void | Promise<void>;
  readonly onConfigureModels?: (() => void) | undefined;
}) {
  const { t } = useTranslation("missions");
  const [executors, setExecutors] = useState<readonly MissionExecutorOption[]>([]);
  const [defaultWorkspace, setDefaultWorkspace] = useState<WorkspaceSelection>();
  const [workspaceOverride, setWorkspaceOverride] = useState<WorkspaceSelection>();
  const [executorRef, setExecutorRef] = useState(props.initialExecutorRef ?? "");
  const [defaultExecutorRef, setDefaultExecutorRef] = useState("");
  const [goal, setGoal] = useState("");
  const [toolPermissionMode, setToolPermissionMode] =
    useState<DesktopToolPermissionMode>("request-approval");
  const [models, setModels] = useState<readonly DesktopRuntimeModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelOverride, setModelOverride] = useState<MissionModelOverride>();
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelResetRequired, setModelResetRequired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.pragmaDesktop.listMissionExecutors(),
      window.pragmaDesktop.getMissionCreationDefaults(),
    ])
      .then(([availableExecutors, defaults]) => {
        if (cancelled) return;
        setExecutors(availableExecutors);
        setDefaultWorkspace(defaults.workspace);
        setDefaultExecutorRef(defaults.executorRef);
        setToolPermissionMode(defaults.toolPermissionMode);
        const requested = props.initialExecutorRef ?? defaults.executorRef;
        setExecutorRef(
          availableExecutors.some((executor) => executor.ref === requested)
            ? requested
            : defaults.executorRef,
        );
        setLoaded(true);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, [props.initialExecutorRef]);

  const selectedExecutor = executors.find((executor) => executor.ref === executorRef);
  const hasValidExecutor = selectedExecutor !== undefined;

  useEffect(() => {
    if (hasValidExecutor || executors.length === 0) return;
    const fallback =
      executors.find((executor) => executor.ref === defaultExecutorRef) ?? executors[0];
    setExecutorRef(fallback?.ref ?? "");
  }, [defaultExecutorRef, executorRef, executors, hasValidExecutor]);

  useEffect(() => {
    setModelOverride(undefined);
    setModelError(null);
    setModelResetRequired(false);
    if (
      selectedExecutor === undefined ||
      (selectedExecutor.kind !== "expert" && selectedExecutor.kind !== "team")
    ) {
      setModels([]);
      setModelsLoading(false);
      return;
    }
    let cancelled = false;
    setModels([]);
    setModelsLoading(true);
    void window.pragmaDesktop
      .getMissionModelOptions(selectedExecutor.ref)
      .then((options) => {
        if (cancelled) return;
        setModels(options.models);
        setModelResetRequired(options.status === "reset_required");
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setModelError(errorMessage(loadError));
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedExecutor?.ref, selectedExecutor?.kind]);

  const pickWorkspace = async () => {
    try {
      const result = await window.pragmaDesktop.pickWorkspace();
      if (result.ok && result.path !== undefined && result.basename !== undefined) {
        setWorkspaceOverride({ path: result.path, basename: result.basename });
        setError(null);
      } else if (result.reason !== "cancelled") {
        setError(result.error ?? t("workspaceUnavailable"));
      }
    } catch (pickError) {
      setError(errorMessage(pickError));
    }
  };

  const submit = async () => {
    const workspace = workspaceOverride ?? defaultWorkspace;
    if (workspace === undefined || !hasValidExecutor || goal.trim() === "" || saving) return;
    setSaving(true);
    setError(null);
    try {
      const mission = await window.pragmaDesktop.createMission({
        workspace: workspace.path,
        executor: { ref: executorRef },
        goal: goal.trim(),
        toolPermissionMode,
        ...(modelOverride === undefined ? {} : { modelOverride }),
      });
      await props.onCreated(mission);
    } catch (submitError) {
      setError(errorMessage(submitError));
      setSaving(false);
    }
  };

  return (
    <section className="steward-home home-mission-create">
      <section className="mission-create" aria-labelledby="new-mission-title">
        <header>
          <h1 id="new-mission-title">{t("start")}</h1>
          <p>{t("createDescription")}</p>
        </header>
        <div className="mission-goal-composer">
          <WorkspacePicker
            defaultWorkspace={defaultWorkspace}
            override={workspaceOverride}
            onChoose={() => void pickWorkspace()}
            onUseDefault={() => setWorkspaceOverride(undefined)}
          />
          <div className="mission-goal-field">
            <label htmlFor="mission-goal">{t("prompt")}</label>
            <textarea
              id="mission-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={t("goalPlaceholder")}
              autoFocus
            />
          </div>
          <footer>
            <div className="mission-prompt-tools" aria-label={t("missionOptions")}>
              <MissionExecutorPicker
                executors={executors}
                value={hasValidExecutor ? executorRef : ""}
                defaultExecutorRef={defaultExecutorRef}
                onChange={setExecutorRef}
              />
              {selectedExecutor?.kind === "expert" || selectedExecutor?.kind === "team" ? (
                <MissionModelOverrideControls
                  models={models}
                  loading={modelsLoading}
                  value={modelOverride}
                  onChange={setModelOverride}
                />
              ) : null}
              <ToolPermissionSelect
                value={toolPermissionMode}
                onChange={setToolPermissionMode}
                disabled={saving}
                title={t("permissionOverride")}
              />
            </div>
            <button
              className="mission-submit-button"
              type="button"
              aria-label={saving ? t("starting") : t("startMission")}
              title={saving ? t("starting") : t("startMission")}
              disabled={
                saving ||
                !loaded ||
                defaultWorkspace === undefined ||
                !hasValidExecutor ||
                goal.trim() === ""
              }
              onClick={() => void submit()}
            >
              <ArrowUp size={19} weight="bold" aria-hidden="true" />
            </button>
          </footer>
        </div>
        {loaded && executors.length === 0 ? (
          <p className="mission-form-note">{t("createFirst")}</p>
        ) : null}
        {modelError ? <p className="mission-form-note">{t("modelOptionsUnavailable")}</p> : null}
        {modelResetRequired ? (
          <p className="mission-form-note mission-model-reset-note" role="status">
            <span>{t("modelConfigurationResetRequired")}</span>
            <button className="text-button" type="button" onClick={props.onConfigureModels}>
              {t("configureModels")}
            </button>
          </p>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </section>
  );
}

function WorkspacePicker(props: {
  readonly defaultWorkspace?: WorkspaceSelection | undefined;
  readonly override?: WorkspaceSelection | undefined;
  readonly onChoose: () => void;
  readonly onUseDefault: () => void;
}) {
  const { t } = useTranslation("missions");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const workspace = props.override ?? props.defaultWorkspace;

  useDismissableMenu(open, rootRef, () => setOpen(false));

  return (
    <div
      className={open ? "mission-workspace-picker is-open" : "mission-workspace-picker"}
      ref={rootRef}
    >
      <button
        className="mission-workspace-trigger"
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
      >
        <Folder size={20} aria-hidden="true" />
        <span>
          <strong>
            {props.override === undefined
              ? t("useDefaultWorkspace")
              : props.override.basename || t("taskWorkspace")}
          </strong>
          <small>{workspace?.path ?? t("loadingWorkspace")}</small>
        </span>
        <CaretDown size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div className="mission-workspace-menu" role="menu" aria-label={t("chooseWorkspace")}>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={props.override === undefined}
            onClick={() => {
              props.onUseDefault();
              setOpen(false);
            }}
          >
            <Folder size={18} aria-hidden="true" />
            <span>
              <strong>{t("useDefaultWorkspace")}</strong>
              <small>{props.defaultWorkspace?.path ?? t("loadingWorkspace")}</small>
            </span>
            {props.override === undefined ? <Check size={16} aria-hidden="true" /> : null}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              props.onChoose();
            }}
          >
            <FolderOpen size={18} aria-hidden="true" />
            <span>
              <strong>{t("chooseDifferentWorkspace")}</strong>
              <small>{t("workspaceOverrideDescription")}</small>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MissionExecutorPicker(props: {
  readonly executors: readonly MissionExecutorOption[];
  readonly value: string;
  readonly defaultExecutorRef: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useTranslation("missions");
  const executorLabel = (executor: Pick<MissionExecutorOption, "kind">): string =>
    executor.kind === "expert"
      ? t("expert")
      : executor.kind === "team"
        ? t("expertTeam")
        : t("flow");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = props.executors.find((executor) => executor.ref === props.value);
  const visibleExecutors = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (query === "") return props.executors;
    return props.executors.filter((executor) =>
      [executor.name, executor.description, executor.ref, executor.kind].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    );
  }, [props.executors, search]);
  const SelectedIcon = selected === undefined ? UsersThree : executorIcon(selected);

  useDismissableMenu(open, rootRef, () => {
    setOpen(false);
    setSearch("");
  });

  return (
    <div
      className={open ? "mission-executor-picker is-open" : "mission-executor-picker"}
      ref={rootRef}
    >
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
        <SelectedIcon size={17} aria-hidden="true" />
        <span>{selected?.name ?? t("chooseResource")}</span>
        <CaretDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="mission-executor-menu"
          role="dialog"
          aria-modal="false"
          aria-label={t("chooseMissionExecutor")}
        >
          <header>
            <div>
              <strong>{t("chooseExecutor")}</strong>
              <small>{t("executorDescription")}</small>
            </div>
            <span>{t("availableCount", { count: props.executors.length })}</span>
          </header>
          {props.executors.length > 5 ? (
            <label className="mission-executor-search">
              <MagnifyingGlass size={17} aria-hidden="true" />
              <span className="sr-only">{t("searchExecutors")}</span>
              <input
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("searchExecutors")}
              />
            </label>
          ) : null}
          <div className="mission-executor-options" role="list" aria-label={t("missionExecutors")}>
            {visibleExecutors.map((executor, index) => {
              const Icon = executorIcon(executor);
              const isSelected = executor.ref === props.value;
              const isDefault = executor.ref === props.defaultExecutorRef;
              return (
                <button
                  type="button"
                  aria-pressed={isSelected}
                  autoFocus={props.executors.length <= 5 && index === 0}
                  className={
                    isSelected ? "mission-executor-option is-selected" : "mission-executor-option"
                  }
                  key={executor.ref}
                  onClick={() => {
                    props.onChange(executor.ref);
                    setOpen(false);
                    setSearch("");
                  }}
                >
                  <span className="mission-executor-option-icon">
                    <Icon size={18} aria-hidden="true" />
                  </span>
                  <span>
                    <strong>{executor.name}</strong>
                    <small>{executor.description}</small>
                  </span>
                  <span className="mission-executor-option-kind">
                    {isDefault ? t("defaultExecutor") : executorLabel(executor)}
                  </span>
                  {isSelected ? <Check size={17} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function useDismissableMenu(
  open: boolean,
  rootRef: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [close, open, rootRef]);
}

function executorIcon(executor: Pick<MissionExecutorOption, "kind">) {
  return executor.kind === "expert" ? User : executor.kind === "team" ? UsersThree : GitBranch;
}
