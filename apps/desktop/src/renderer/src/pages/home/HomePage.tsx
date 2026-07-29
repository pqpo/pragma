import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  ArrowUp,
  CaretDown,
  Check,
  Eye,
  EyeSlash,
  GitBranch,
  MagnifyingGlass,
  Star,
  User,
  UsersThree,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import type {
  DesktopRuntimeModel,
  DesktopToolPermissionMode,
  HomeExecutorFavoriteScope,
  HomeMissionExecutorOption,
  Mission,
  MissionModelOverride,
} from "../../../../shared/contracts/index.ts";
import { ToolPermissionSelect } from "../../components/ToolPermissionSelect.tsx";
import { MissionModelOverrideControls } from "../../components/MissionModelOverrideControls.tsx";
import { WorkspacePicker, type WorkspaceSelection } from "../../components/WorkspacePicker.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { readHomeDraft, writeHomeDraft } from "../../lib/home-draft.ts";
import { localizeSystemExpertCopy } from "../../lib/system-expert-copy.ts";
import { SchemaInputForm, createSchemaInputValue, isSchemaInputValid } from "./SchemaInputForm.tsx";

export function HomePage(props: {
  readonly initialExecutorRef?: string | undefined;
  readonly onCreated: (mission: Mission) => void | Promise<void>;
  readonly onConfigureModels?: (() => void) | undefined;
}) {
  const { t } = useTranslation("missions");
  const [executors, setExecutors] = useState<readonly HomeMissionExecutorOption[]>([]);
  const [defaultWorkspace, setDefaultWorkspace] = useState<WorkspaceSelection>();
  const [recentWorkspaces, setRecentWorkspaces] = useState<readonly WorkspaceSelection[]>([]);
  const [workspaceOverride, setWorkspaceOverride] = useState<WorkspaceSelection>();
  const [executorRef, setExecutorRef] = useState(props.initialExecutorRef ?? "");
  const [defaultExecutorRef, setDefaultExecutorRef] = useState("");
  const [goal, setGoal] = useState("");
  const [flowInput, setFlowInput] = useState<Readonly<Record<string, unknown>>>({});
  const [toolPermissionMode, setToolPermissionMode] =
    useState<DesktopToolPermissionMode>("request-approval");
  const [models, setModels] = useState<readonly DesktopRuntimeModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelOverride, setModelOverride] = useState<MissionModelOverride>();
  const [defaultModelSelection, setDefaultModelSelection] = useState<MissionModelOverride>();
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelResetRequired, setModelResetRequired] = useState(false);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const modelRuntimeIdRef = useRef<string | undefined>(undefined);
  const inputExecutorRef = useRef(props.initialExecutorRef ?? "");
  const pendingModelOverrideRef = useRef<MissionModelOverride | undefined>(undefined);
  const workspaceAssociationRequestRef = useRef(props.initialExecutorRef ?? "");

  useEffect(() => {
    let cancelled = false;
    void window.pragmaDesktop
      .getHomeMissionExecutorCatalog()
      .then(({ executors: availableExecutors, defaults }) => {
        if (cancelled) return;
        const persisted = readHomeDraft(
          typeof window === "undefined" ? undefined : window.localStorage,
        );
        const requested =
          props.initialExecutorRef ?? persisted?.executorRef ?? defaults.executorRef;
        const selected =
          availableExecutors.find((executor) => executor.ref === requested) ??
          availableExecutors.find((executor) => executor.ref === defaults.executorRef) ??
          availableExecutors[0];
        const restoresPersistedInput =
          persisted !== undefined &&
          persisted.executorRef === selected?.ref &&
          (props.initialExecutorRef === undefined ||
            props.initialExecutorRef === persisted.executorRef);
        setExecutors(availableExecutors);
        setDefaultWorkspace(defaults.workspace);
        setRecentWorkspaces(defaults.recentWorkspaces);
        setDefaultExecutorRef(defaults.executorRef);
        setToolPermissionMode(persisted?.toolPermissionMode ?? defaults.toolPermissionMode);
        const restoredWorkspace =
          selected?.preference.lastWorkspace ?? persisted?.workspaceOverride;
        setWorkspaceOverride(restoredWorkspace);
        setExecutorRef(selected?.ref ?? "");
        inputExecutorRef.current = selected?.ref ?? "";
        workspaceAssociationRequestRef.current = selected?.ref ?? "";
        setGoal(restoresPersistedInput && selected?.kind !== "flow" ? persisted.goal : "");
        setFlowInput(
          selected?.kind === "flow" && selected.inputSchema !== undefined
            ? restoresPersistedInput &&
              isSchemaInputValid(selected.inputSchema, persisted.flowInput)
              ? persisted.flowInput
              : createSchemaInputValue(selected.inputSchema)
            : {},
        );
        pendingModelOverrideRef.current = restoresPersistedInput
          ? persisted.modelOverride
          : undefined;
        setPersistenceReady(
          selected === undefined || (selected.kind !== "expert" && selected.kind !== "team"),
        );
        setLoaded(true);
        if (restoredWorkspace !== undefined) {
          void window.pragmaDesktop
            .validateWorkspace(restoredWorkspace.path)
            .then((validation) => {
              if (
                cancelled ||
                validation.ok ||
                workspaceAssociationRequestRef.current !== selected?.ref
              )
                return;
              setWorkspaceOverride(undefined);
              if (selected?.preference.lastWorkspace?.path === restoredWorkspace.path) {
                void clearExecutorWorkspaceAssociation(selected.ref, setExecutors);
              }
            })
            .catch(() => {
              if (!cancelled && workspaceAssociationRequestRef.current === selected?.ref)
                setWorkspaceOverride(undefined);
            });
        }
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
  const flowInputSchema =
    selectedExecutor?.kind === "flow" ? selectedExecutor.inputSchema : undefined;
  const hasStructuredFlowInput = flowInputSchema !== undefined;
  const structuredFlowInputValid =
    flowInputSchema === undefined || isSchemaInputValid(flowInputSchema, flowInput);

  useEffect(() => {
    if (hasValidExecutor || executors.length === 0) return;
    const fallback =
      executors.find((executor) => executor.ref === defaultExecutorRef) ?? executors[0];
    setExecutorRef(fallback?.ref ?? "");
  }, [defaultExecutorRef, executorRef, executors, hasValidExecutor]);

  useEffect(() => {
    setPersistenceReady(false);
    setModelOverride(undefined);
    setDefaultModelSelection(undefined);
    setModelError(null);
    setModelResetRequired(false);
    modelRuntimeIdRef.current = undefined;
    if (
      selectedExecutor === undefined ||
      (selectedExecutor.kind !== "expert" && selectedExecutor.kind !== "team")
    ) {
      setModels([]);
      setModelsLoading(false);
      pendingModelOverrideRef.current = undefined;
      setPersistenceReady(true);
      return;
    }
    let cancelled = false;
    const loadModelOptions = (showLoading: boolean) => {
      if (showLoading) {
        setModels([]);
        setModelsLoading(true);
      }
      void window.pragmaDesktop
        .getMissionModelOptions(selectedExecutor.ref)
        .then((options) => {
          if (cancelled) return;
          modelRuntimeIdRef.current = options.runtime.id;
          setModels(options.models);
          setDefaultModelSelection(options.defaultSelection);
          setModelResetRequired(options.status === "reset_required");
          const pendingOverride = pendingModelOverrideRef.current;
          pendingModelOverrideRef.current = undefined;
          setModelOverride(
            pendingOverride !== undefined &&
              missionModelOverrideAvailable(options.models, pendingOverride)
              ? pendingOverride
              : undefined,
          );
          setModelError(null);
        })
        .catch((loadError: unknown) => {
          if (!cancelled) setModelError(errorMessage(loadError));
        })
        .finally(() => {
          if (!cancelled) {
            if (showLoading) setModelsLoading(false);
            setPersistenceReady(true);
          }
        });
    };
    const unsubscribe = window.pragmaDesktop.subscribeRuntimeModelCatalog((runtimeId) => {
      if (modelRuntimeIdRef.current === undefined || modelRuntimeIdRef.current === runtimeId) {
        loadModelOptions(false);
      }
    });
    loadModelOptions(true);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [selectedExecutor?.ref, selectedExecutor?.kind]);

  useEffect(() => {
    if (!loaded || selectedExecutor?.ref === inputExecutorRef.current) return;
    inputExecutorRef.current = selectedExecutor?.ref ?? "";
    pendingModelOverrideRef.current = undefined;
    setGoal("");
    setFlowInput(
      selectedExecutor?.kind === "flow" && selectedExecutor.inputSchema !== undefined
        ? createSchemaInputValue(selectedExecutor.inputSchema)
        : {},
    );
  }, [loaded, selectedExecutor?.ref]);

  useEffect(() => {
    if (!loaded || !persistenceReady || executorRef === "") return;
    const persistedModelOverride = modelOverride ?? pendingModelOverrideRef.current;
    writeHomeDraft(typeof window === "undefined" ? undefined : window.localStorage, {
      executorRef,
      ...(workspaceOverride === undefined ? {} : { workspaceOverride }),
      goal,
      flowInput,
      toolPermissionMode,
      ...(persistedModelOverride === undefined ? {} : { modelOverride: persistedModelOverride }),
    });
  }, [
    executorRef,
    flowInput,
    goal,
    loaded,
    modelOverride,
    persistenceReady,
    toolPermissionMode,
    workspaceOverride,
  ]);

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

  const selectExecutor = (ref: string) => {
    const next = executors.find((executor) => executor.ref === ref);
    workspaceAssociationRequestRef.current = ref;
    setExecutorRef(ref);
    const associatedWorkspace = next?.preference.lastWorkspace;
    if (associatedWorkspace === undefined) return;
    void window.pragmaDesktop
      .validateWorkspace(associatedWorkspace.path)
      .then((validation) => {
        if (workspaceAssociationRequestRef.current !== ref) return;
        if (validation.ok) {
          setWorkspaceOverride(associatedWorkspace);
          setError(null);
          return;
        }
        void clearExecutorWorkspaceAssociation(ref, setExecutors);
      })
      .catch(() => undefined);
  };

  const updateExecutorPreference = async (
    ref: string,
    favoriteScope: HomeExecutorFavoriteScope,
    hidden: boolean,
  ) => {
    const workspace = workspaceOverride ?? defaultWorkspace;
    try {
      const preference = await window.pragmaDesktop.updateHomeExecutorPreference({
        ref,
        favoriteScope,
        hidden,
        ...(favoriteScope === "workspace" && workspace !== undefined
          ? { workspace: workspace.path }
          : {}),
      });
      setExecutors((current) =>
        current.map((executor) => (executor.ref === ref ? { ...executor, preference } : executor)),
      );
      setError(null);
    } catch (preferenceError) {
      setError(errorMessage(preferenceError));
    }
  };

  const submit = async () => {
    const workspace = workspaceOverride ?? defaultWorkspace;
    if (
      workspace === undefined ||
      !hasValidExecutor ||
      (!hasStructuredFlowInput && goal.trim() === "") ||
      !structuredFlowInputValid ||
      saving
    )
      return;
    setSaving(true);
    setError(null);
    try {
      const mission = await window.pragmaDesktop.createMission({
        workspace: workspace.path,
        executor: { ref: executorRef },
        input:
          selectedExecutor.kind === "flow"
            ? {
                kind: "flow",
                value: hasStructuredFlowInput
                  ? flowInput
                  : { goal: goal.trim(), workspace: workspace.path },
              }
            : { kind: "prompt", value: goal.trim() },
        toolPermissionMode,
        ...(modelOverride === undefined ? {} : { modelOverride }),
      });
      const clearedFlowInput =
        selectedExecutor.kind === "flow" && selectedExecutor.inputSchema !== undefined
          ? createSchemaInputValue(selectedExecutor.inputSchema)
          : {};
      const persistedModelOverride = modelOverride ?? pendingModelOverrideRef.current;
      writeHomeDraft(typeof window === "undefined" ? undefined : window.localStorage, {
        executorRef,
        ...(workspaceOverride === undefined ? {} : { workspaceOverride }),
        goal: "",
        flowInput: clearedFlowInput,
        toolPermissionMode,
        ...(persistedModelOverride === undefined ? {} : { modelOverride: persistedModelOverride }),
      });
      setGoal("");
      setFlowInput(clearedFlowInput);
      await props.onCreated(mission);
    } catch (submitError) {
      setError(errorMessage(submitError));
      setSaving(false);
    }
  };

  return (
    <section className="default-agent-home home-mission-create">
      <section className="mission-create" aria-labelledby="new-mission-title">
        <header>
          <h1 id="new-mission-title">{t("start")}</h1>
          <p>{t("createDescription")}</p>
        </header>
        <div className="mission-goal-composer">
          <WorkspacePicker
            defaultWorkspace={defaultWorkspace}
            recentWorkspaces={recentWorkspaces}
            selection={workspaceOverride}
            defaultSelected={workspaceOverride === undefined}
            onChoose={() => void pickWorkspace()}
            onSelect={setWorkspaceOverride}
            onUseDefault={() => setWorkspaceOverride(undefined)}
          />
          {flowInputSchema === undefined ? (
            <div className="mission-goal-field">
              <textarea
                id="mission-goal"
                aria-label={t("goalPlaceholder")}
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
          ) : (
            <SchemaInputForm
              schema={flowInputSchema}
              value={flowInput}
              disabled={saving}
              onChange={setFlowInput}
            />
          )}
          <footer>
            <div className="mission-prompt-tools" aria-label={t("missionOptions")}>
              <MissionExecutorPicker
                executors={executors}
                value={hasValidExecutor ? executorRef : ""}
                defaultExecutorRef={defaultExecutorRef}
                workspace={workspaceOverride ?? defaultWorkspace}
                onChange={selectExecutor}
                onPreferenceChange={(ref, favoriteScope, hidden) =>
                  void updateExecutorPreference(ref, favoriteScope, hidden)
                }
              />
              {selectedExecutor?.kind === "expert" || selectedExecutor?.kind === "team" ? (
                <MissionModelOverrideControls
                  models={models}
                  loading={modelsLoading}
                  value={modelOverride}
                  defaultValue={defaultModelSelection}
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
                (!hasStructuredFlowInput && goal.trim() === "") ||
                !structuredFlowInputValid
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

export function missionModelOverrideAvailable(
  models: readonly DesktopRuntimeModel[],
  override: MissionModelOverride,
): boolean {
  const model = models.find(
    (candidate) =>
      candidate.id === override.modelId && candidate.provider.id === override.providerId,
  );
  if (model === undefined || override.thinkingLevel === undefined) return model !== undefined;
  return (
    model.thinking?.supportedLevels.some((level) => level.value === override.thinkingLevel) ?? false
  );
}

function MissionExecutorPicker(props: {
  readonly executors: readonly HomeMissionExecutorOption[];
  readonly value: string;
  readonly defaultExecutorRef: string;
  readonly workspace: WorkspaceSelection | undefined;
  readonly onChange: (value: string) => void;
  readonly onPreferenceChange: (
    ref: string,
    favoriteScope: HomeExecutorFavoriteScope,
    hidden: boolean,
  ) => void;
}) {
  const { t } = useTranslation("missions");
  const { t: tCommon } = useTranslation("common");
  const executorLabel = (executor: Pick<HomeMissionExecutorOption, "kind">): string =>
    executor.kind === "expert"
      ? t("expert")
      : executor.kind === "team"
        ? t("expertTeam")
        : t("flow");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"recommended" | "favorites" | "all" | "hidden">("recommended");
  const [kind, setKind] = useState<"all" | HomeMissionExecutorOption["kind"]>("all");
  const [tag, setTag] = useState("all");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = props.executors.find((executor) => executor.ref === props.value);
  const pragmaCopy = {
    name: tCommon("builtInExperts.pragma.name"),
    description: tCommon("builtInExperts.pragma.description"),
    scope: tCommon("builtInExperts.pragma.scope"),
  };
  const displayCopy = (executor: HomeMissionExecutorOption) =>
    localizeSystemExpertCopy(executor, pragmaCopy);
  const selectedCopy = selected === undefined ? undefined : displayCopy(selected);
  const query = search.trim().toLocaleLowerCase();
  const tags = [...new Set(props.executors.flatMap((executor) => executor.tags))].toSorted(
    (left, right) => left.localeCompare(right),
  );
  const filteredExecutors = filterMissionExecutors(props.executors, query, displayCopy)
    .filter((executor) => kind === "all" || executor.kind === kind)
    .filter((executor) => tag === "all" || executor.tags.includes(tag))
    .filter((executor) => {
      if (view === "hidden") return executor.preference.hidden;
      if (executor.preference.hidden) return false;
      if (view === "favorites") return executor.preference.favoriteScope !== "none";
      if (view === "all" || query !== "" || kind !== "all" || tag !== "all") return true;
      return isRecommendedExecutor(executor, props.workspace?.path);
    });
  const visibleExecutors = rankHomeMissionExecutors(
    filteredExecutors,
    props.workspace?.path,
    displayCopy,
  );
  const collapsedTeamMemberCount = props.executors.filter(
    (executor) =>
      !executor.preference.hidden &&
      executor.teamMemberships.length > 0 &&
      !isRecommendedExecutor(executor, props.workspace?.path),
  ).length;
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
          setView("recommended");
          setKind("all");
          setTag("all");
        }}
      >
        <SelectedIcon size={17} aria-hidden="true" />
        <span>{selectedCopy?.name ?? t("chooseResource")}</span>
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
            <small>{t("executorDescription")}</small>
            <span>{t("availableCount", { count: props.executors.length })}</span>
          </header>
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
          <div className="mission-executor-controls">
            <div className="mission-executor-views" role="group" aria-label={t("executorViews")}>
              {(["recommended", "favorites", "all", "hidden"] as const).map((candidate) => (
                <button
                  type="button"
                  aria-pressed={view === candidate}
                  className={view === candidate ? "is-active" : undefined}
                  key={candidate}
                  onClick={() => setView(candidate)}
                >
                  {t(`executorView.${candidate}`)}
                </button>
              ))}
            </div>
            <div className="mission-executor-filters">
              <label>
                <span className="sr-only">{t("filterExecutorKind")}</span>
                <select
                  value={kind}
                  onChange={(event) =>
                    setKind(event.target.value as "all" | HomeMissionExecutorOption["kind"])
                  }
                >
                  <option value="all">{t("allKinds")}</option>
                  <option value="expert">{t("expert")}</option>
                  <option value="team">{t("expertTeam")}</option>
                  <option value="flow">{t("flow")}</option>
                </select>
              </label>
              {tags.length > 0 ? (
                <label>
                  <span className="sr-only">{t("filterExecutorTag")}</span>
                  <select value={tag} onChange={(event) => setTag(event.target.value)}>
                    <option value="all">{t("allTags")}</option>
                    {tags.map((candidate) => (
                      <option value={candidate} key={candidate}>
                        {candidate}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          </div>
          <div className="mission-executor-options" role="list" aria-label={t("missionExecutors")}>
            {visibleExecutors.length === 0 ? (
              <p className="mission-executor-empty">
                {t("noExecutors")}
                <span>{t("tryAnother")}</span>
              </p>
            ) : null}
            {visibleExecutors.map((executor) => {
              const Icon = executorIcon(executor);
              const copy = displayCopy(executor);
              const isSelected = executor.ref === props.value;
              const isDefault = executor.ref === props.defaultExecutorRef;
              return (
                <div
                  className={
                    isSelected ? "mission-executor-option is-selected" : "mission-executor-option"
                  }
                  key={executor.ref}
                >
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    className="mission-executor-option-main"
                    onClick={() => {
                      props.onChange(executor.ref);
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <span className="mission-executor-option-icon">
                      <Icon size={18} aria-hidden="true" />
                    </span>
                    <span className="mission-executor-option-copy">
                      <strong>{copy.name}</strong>
                      <small>{copy.description}</small>
                      <span className="mission-executor-option-badges">
                        <span>{isDefault ? t("defaultExecutor") : executorLabel(executor)}</span>
                        {executor.teamMemberships.length > 0 ? (
                          <span>
                            {t("managedByTeams", { count: executor.teamMemberships.length })}
                          </span>
                        ) : null}
                        {executor.preference.lastWorkspace !== undefined ? (
                          <span>{executor.preference.lastWorkspace.basename}</span>
                        ) : null}
                      </span>
                    </span>
                    <Check
                      className={isSelected ? "is-visible" : undefined}
                      size={17}
                      aria-hidden="true"
                    />
                  </button>
                  <span className="mission-executor-option-actions">
                    <label title={t("favoriteExecutor")}>
                      <Star
                        size={15}
                        weight={executor.preference.favoriteScope === "none" ? "regular" : "fill"}
                        aria-hidden="true"
                      />
                      <span className="sr-only">{t("favoriteExecutor")}</span>
                      <select
                        aria-label={t("favoriteNamed", { name: copy.name })}
                        disabled={executor.preference.hidden}
                        value={executor.preference.favoriteScope}
                        onChange={(event) =>
                          props.onPreferenceChange(
                            executor.ref,
                            event.target.value as HomeExecutorFavoriteScope,
                            executor.preference.hidden,
                          )
                        }
                      >
                        <option value="none">{t("favoriteScope.none")}</option>
                        <option value="workspace" disabled={props.workspace === undefined}>
                          {t("favoriteScope.workspace")}
                        </option>
                        <option value="global">{t("favoriteScope.global")}</option>
                      </select>
                    </label>
                    {!executor.alwaysVisible ? (
                      <button
                        type="button"
                        aria-label={
                          executor.preference.hidden
                            ? t("restoreNamed", { name: copy.name })
                            : t("hideNamed", { name: copy.name })
                        }
                        title={
                          executor.preference.hidden ? t("restoreExecutor") : t("hideExecutor")
                        }
                        onClick={() =>
                          props.onPreferenceChange(
                            executor.ref,
                            executor.preference.favoriteScope,
                            !executor.preference.hidden,
                          )
                        }
                      >
                        {executor.preference.hidden ? (
                          <Eye size={16} aria-hidden="true" />
                        ) : (
                          <EyeSlash size={16} aria-hidden="true" />
                        )}
                      </button>
                    ) : null}
                  </span>
                </div>
              );
            })}
            {view === "recommended" && collapsedTeamMemberCount > 0 && query === "" ? (
              <button
                className="mission-executor-managed-toggle"
                type="button"
                onClick={() => setView("all")}
              >
                {t("showManagedExperts", { count: collapsedTeamMemberCount })}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function filterMissionExecutors(
  executors: readonly HomeMissionExecutorOption[],
  query: string,
  displayCopy: (
    executor: HomeMissionExecutorOption,
  ) => Pick<HomeMissionExecutorOption, "name" | "description"> = (executor) => executor,
): readonly HomeMissionExecutorOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return executors.filter((executor) => {
    if (normalizedQuery === "") return true;
    const copy = displayCopy(executor);
    return [
      copy.name,
      copy.description,
      executor.ref,
      executor.kind,
      ...executor.tags,
      ...executor.teamMemberships.flatMap((team) => [team.name, team.ref]),
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
}

export function rankHomeMissionExecutors(
  executors: readonly HomeMissionExecutorOption[],
  workspacePath: string | undefined,
  displayCopy: (executor: HomeMissionExecutorOption) => Pick<HomeMissionExecutorOption, "name"> = (
    executor,
  ) => executor,
): readonly HomeMissionExecutorOption[] {
  const rank = (executor: HomeMissionExecutorOption): number => {
    if (executor.alwaysVisible || executor.preference.favoriteScope === "global") return 0;
    if (
      executor.preference.favoriteScope === "workspace" &&
      executor.preference.lastWorkspace?.path === workspacePath
    )
      return 1;
    if (executor.preference.lastWorkspace?.path === workspacePath) return 2;
    if (executor.preference.lastUsedAt !== undefined) return 3;
    if (executor.teamMemberships.length > 0) return 5;
    return 4;
  };
  return executors.toSorted((left, right) => {
    const rankDifference = rank(left) - rank(right);
    if (rankDifference !== 0) return rankDifference;
    const recentDifference =
      Date.parse(right.preference.lastUsedAt ?? "1970-01-01T00:00:00.000Z") -
      Date.parse(left.preference.lastUsedAt ?? "1970-01-01T00:00:00.000Z");
    return recentDifference !== 0
      ? recentDifference
      : displayCopy(left).name.localeCompare(displayCopy(right).name);
  });
}

function isRecommendedExecutor(
  executor: HomeMissionExecutorOption,
  workspacePath: string | undefined,
): boolean {
  return (
    executor.alwaysVisible ||
    executor.teamMemberships.length === 0 ||
    executor.preference.favoriteScope !== "none" ||
    executor.preference.lastUsedAt !== undefined ||
    executor.preference.lastWorkspace?.path === workspacePath
  );
}

async function clearExecutorWorkspaceAssociation(
  ref: string,
  setExecutors: Dispatch<SetStateAction<readonly HomeMissionExecutorOption[]>>,
): Promise<void> {
  try {
    const preference = await window.pragmaDesktop.updateHomeExecutorPreference({
      ref,
      clearWorkspace: true,
    });
    setExecutors((current) =>
      current.map((executor) => (executor.ref === ref ? { ...executor, preference } : executor)),
    );
  } catch {
    // A stale association is ignored even when its best-effort cleanup fails.
  }
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

function executorIcon(executor: Pick<HomeMissionExecutorOption, "kind">) {
  return executor.kind === "expert" ? User : executor.kind === "team" ? UsersThree : GitBranch;
}
