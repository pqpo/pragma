import {
  useCallback,
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
  GearSix,
  GitBranch,
  MagnifyingGlass,
  Star,
  User,
  UsersThree,
  X,
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

const CHOOSE_FAVORITE_WORKSPACE_VALUE = "__pragma_choose_directory__";

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
    update: {
      readonly favoriteScope?: HomeExecutorFavoriteScope;
      readonly favoriteWorkspace?: WorkspaceSelection;
      readonly hidden?: boolean;
    },
  ) => {
    try {
      const preference = await window.pragmaDesktop.updateHomeExecutorPreference({
        ref,
        ...(update.favoriteScope === undefined ? {} : { favoriteScope: update.favoriteScope }),
        ...(update.favoriteWorkspace === undefined
          ? {}
          : { favoriteWorkspace: update.favoriteWorkspace.path }),
        ...(update.hidden === undefined ? {} : { hidden: update.hidden }),
      });
      setExecutors((current) =>
        current.map((executor) => (executor.ref === ref ? { ...executor, preference } : executor)),
      );
      setError(null);
    } catch (preferenceError) {
      setError(errorMessage(preferenceError));
    }
  };

  const chooseFavoriteWorkspace = async (ref: string) => {
    try {
      const result = await window.pragmaDesktop.pickWorkspace();
      if (result.ok && result.path !== undefined && result.basename !== undefined) {
        await updateExecutorPreference(ref, {
          favoriteScope: "workspace",
          favoriteWorkspace: { path: result.path, basename: result.basename },
          hidden: false,
        });
      } else if (result.reason !== "cancelled") {
        setError(result.error ?? t("workspaceUnavailable"));
      }
    } catch (pickError) {
      setError(errorMessage(pickError));
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
                recentWorkspaces={recentWorkspaces}
                onChange={selectExecutor}
                onPreferenceChange={(ref, update) => void updateExecutorPreference(ref, update)}
                onChooseFavoriteWorkspace={(ref) => void chooseFavoriteWorkspace(ref)}
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
  readonly recentWorkspaces: readonly WorkspaceSelection[];
  readonly onChange: (value: string) => void;
  readonly onPreferenceChange: (
    ref: string,
    update: {
      readonly favoriteScope?: HomeExecutorFavoriteScope;
      readonly favoriteWorkspace?: WorkspaceSelection;
      readonly hidden?: boolean;
    },
  ) => void;
  readonly onChooseFavoriteWorkspace: (ref: string) => void;
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
  const [selectionKind, setSelectionKind] = useState<"all" | HomeMissionExecutorOption["kind"]>(
    "all",
  );
  const [selectionTag, setSelectionTag] = useState("all");
  const [managerOpen, setManagerOpen] = useState(false);
  const [managerSearch, setManagerSearch] = useState("");
  const [managerView, setManagerView] = useState<"favorites" | "all" | "hidden">("all");
  const [managerKind, setManagerKind] = useState<"all" | HomeMissionExecutorOption["kind"]>("all");
  const [managerTag, setManagerTag] = useState("all");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const managerDialogRef = useRef<HTMLElement | null>(null);
  const selected = props.executors.find((executor) => executor.ref === props.value);
  const pragmaCopy = {
    name: tCommon("builtInExperts.pragma.name"),
    description: tCommon("builtInExperts.pragma.description"),
    scope: tCommon("builtInExperts.pragma.scope"),
  };
  const displayCopy = (executor: HomeMissionExecutorOption) =>
    localizeSystemExpertCopy(executor, pragmaCopy);
  const selectedCopy = selected === undefined ? undefined : displayCopy(selected);
  const tags = [...new Set(props.executors.flatMap((executor) => executor.tags))].toSorted(
    (left, right) => left.localeCompare(right),
  );
  const selectableExecutors = selectHomeMissionExecutors(
    props.executors,
    search,
    selectionKind,
    selectionTag,
    props.workspace?.path,
    displayCopy,
  );
  const managedExecutors = rankHomeMissionExecutors(
    filterMissionExecutors(props.executors, managerSearch, displayCopy)
      .filter((executor) => managerKind === "all" || executor.kind === managerKind)
      .filter((executor) => managerTag === "all" || executor.tags.includes(managerTag))
      .filter((executor) => {
        if (managerView === "hidden") return executor.preference.hidden;
        if (executor.preference.hidden) return false;
        return managerView !== "favorites" || executor.preference.favoriteScope !== "none";
      }),
    props.workspace?.path,
    displayCopy,
  );
  const favoriteWorkspaceOptions = uniqueWorkspaces([
    ...(props.workspace === undefined ? [] : [props.workspace]),
    ...props.recentWorkspaces,
  ]);
  const SelectedIcon = selected === undefined ? UsersThree : executorIcon(selected);

  useDismissableMenu(open, rootRef, () => {
    setOpen(false);
    setSearch("");
    setSelectionKind("all");
    setSelectionTag("all");
  });

  const closeManager = useCallback(() => {
    setManagerOpen(false);
    setManagerSearch("");
    setManagerView("all");
    setManagerKind("all");
    setManagerTag("all");
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!managerOpen) return;
    const handleManagerKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeManager();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = managerDialogRef.current;
      if (dialog === null) return;
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const focusIsOutside = !dialog.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || focusIsOutside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || focusIsOutside)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleManagerKeyDown);
    return () => window.removeEventListener("keydown", handleManagerKeyDown);
  }, [closeManager, managerOpen]);

  return (
    <>
      <div
        className={open ? "mission-executor-picker is-open" : "mission-executor-picker"}
        ref={rootRef}
      >
        <button
          className="mission-executor-trigger"
          type="button"
          ref={triggerRef}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => {
            setSearch("");
            setSelectionKind("all");
            setSelectionTag("all");
            setOpen((current) => !current);
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
              <strong>{t("chooseMissionExecutor")}</strong>
              <button
                className="mission-executor-manage-button"
                type="button"
                onClick={() => {
                  setOpen(false);
                  setSearch("");
                  setSelectionKind("all");
                  setSelectionTag("all");
                  setManagerOpen(true);
                }}
              >
                <GearSix size={15} aria-hidden="true" />
                {t("manageExecutors")}
              </button>
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
            <div className="mission-executor-filters mission-executor-selection-filters">
              <label>
                <span className="sr-only">{t("filterExecutorKind")}</span>
                <select
                  value={selectionKind}
                  onChange={(event) =>
                    setSelectionKind(
                      event.target.value as "all" | HomeMissionExecutorOption["kind"],
                    )
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
                  <select
                    value={selectionTag}
                    onChange={(event) => setSelectionTag(event.target.value)}
                  >
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
            <div
              className="mission-executor-options mission-executor-selection-options"
              role="list"
              aria-label={t("missionExecutors")}
            >
              {selectableExecutors.length === 0 ? (
                <p className="mission-executor-empty">
                  {t("noExecutors")}
                  <span>{t("tryAnother")}</span>
                </p>
              ) : null}
              {selectableExecutors.map((executor) => {
                const Icon = executorIcon(executor);
                const copy = displayCopy(executor);
                const isSelected = executor.ref === props.value;
                const isPinned = isHomeExecutorFavorite(executor, props.workspace?.path);
                return (
                  <div
                    className={
                      isSelected
                        ? "mission-executor-option is-selection is-selected"
                        : "mission-executor-option is-selection"
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
                        setSelectionKind("all");
                        setSelectionTag("all");
                      }}
                    >
                      <span className="mission-executor-option-icon">
                        <Icon size={18} aria-hidden="true" />
                      </span>
                      <span className="mission-executor-option-copy">
                        <strong>{copy.name}</strong>
                        <small>{copy.description}</small>
                      </span>
                      <span className="mission-executor-option-status">
                        {isPinned ? (
                          <Star
                            className="mission-executor-pinned-star"
                            size={15}
                            weight="fill"
                            aria-label={t("favoritePinned")}
                          />
                        ) : null}
                        <Check
                          className={isSelected ? "is-visible" : undefined}
                          size={17}
                          aria-hidden="true"
                        />
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
      {managerOpen ? (
        <div
          className="mission-executor-manager-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeManager();
          }}
        >
          <section
            className="mission-executor-manager-dialog"
            ref={managerDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mission-executor-manager-title"
            aria-describedby="mission-executor-manager-description"
            tabIndex={-1}
          >
            <header>
              <div>
                <h2 id="mission-executor-manager-title">{t("manageMissionExecutors")}</h2>
                <p id="mission-executor-manager-description">
                  {t("executorManagementDescription")}
                </p>
              </div>
              <button type="button" aria-label={tCommon("actions.close")} onClick={closeManager}>
                <X size={19} aria-hidden="true" />
              </button>
            </header>
            <div className="mission-executor-manager-tools">
              <label className="mission-executor-search">
                <MagnifyingGlass size={17} aria-hidden="true" />
                <span className="sr-only">{t("searchExecutors")}</span>
                <input
                  autoFocus
                  value={managerSearch}
                  onChange={(event) => setManagerSearch(event.target.value)}
                  placeholder={t("searchExecutors")}
                />
              </label>
              <div className="mission-executor-controls">
                <div
                  className="mission-executor-views"
                  role="group"
                  aria-label={t("executorViews")}
                >
                  {(["all", "favorites", "hidden"] as const).map((candidate) => (
                    <button
                      type="button"
                      aria-pressed={managerView === candidate}
                      className={managerView === candidate ? "is-active" : undefined}
                      key={candidate}
                      onClick={() => setManagerView(candidate)}
                    >
                      {t(`executorView.${candidate}`)}
                    </button>
                  ))}
                </div>
                <div className="mission-executor-filters">
                  <label>
                    <span className="sr-only">{t("filterExecutorKind")}</span>
                    <select
                      value={managerKind}
                      onChange={(event) =>
                        setManagerKind(
                          event.target.value as "all" | HomeMissionExecutorOption["kind"],
                        )
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
                      <select
                        value={managerTag}
                        onChange={(event) => setManagerTag(event.target.value)}
                      >
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
            </div>
            <div
              className="mission-executor-options mission-executor-manager-options"
              role="list"
              aria-label={t("missionExecutors")}
            >
              {managedExecutors.length === 0 ? (
                <p className="mission-executor-empty">
                  {t("noExecutors")}
                  <span>{t("tryAnother")}</span>
                </p>
              ) : null}
              {managedExecutors.map((executor) => {
                const Icon = executorIcon(executor);
                const copy = displayCopy(executor);
                const isDefault = executor.ref === props.defaultExecutorRef;
                const executorFavoriteWorkspaces = uniqueWorkspaces([
                  ...(executor.preference.favoriteWorkspace === undefined
                    ? []
                    : [executor.preference.favoriteWorkspace]),
                  ...favoriteWorkspaceOptions,
                ]);
                return (
                  <div className="mission-executor-option" key={executor.ref}>
                    <div className="mission-executor-option-main">
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
                          {executor.preference.favoriteWorkspace !== undefined ? (
                            <span>
                              {t("favoriteWorkspaceBadge", {
                                workspace: executor.preference.favoriteWorkspace.basename,
                              })}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <span aria-hidden="true" />
                    </div>
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
                          onChange={(event) => {
                            const favoriteScope = event.target.value as HomeExecutorFavoriteScope;
                            if (favoriteScope !== "workspace") {
                              props.onPreferenceChange(executor.ref, { favoriteScope });
                              return;
                            }
                            const favoriteWorkspace =
                              executor.preference.favoriteWorkspace ??
                              props.workspace ??
                              favoriteWorkspaceOptions[0];
                            if (favoriteWorkspace === undefined) {
                              props.onChooseFavoriteWorkspace(executor.ref);
                              return;
                            }
                            props.onPreferenceChange(executor.ref, {
                              favoriteScope,
                              favoriteWorkspace,
                            });
                          }}
                        >
                          <option value="none">{t("favoriteScope.none")}</option>
                          <option value="workspace">{t("favoriteScope.workspace")}</option>
                          <option value="global">{t("favoriteScope.global")}</option>
                        </select>
                      </label>
                      {executor.preference.favoriteScope === "workspace" ? (
                        <label
                          className="mission-executor-favorite-workspace"
                          title={t("favoriteWorkspaceNamed", { name: copy.name })}
                        >
                          <GitBranch size={15} aria-hidden="true" />
                          <span className="sr-only">
                            {t("favoriteWorkspaceNamed", { name: copy.name })}
                          </span>
                          <select
                            aria-label={t("favoriteWorkspaceNamed", { name: copy.name })}
                            value={executor.preference.favoriteWorkspace?.path ?? ""}
                            onChange={(event) => {
                              if (event.target.value === CHOOSE_FAVORITE_WORKSPACE_VALUE) {
                                props.onChooseFavoriteWorkspace(executor.ref);
                                return;
                              }
                              const favoriteWorkspace = executorFavoriteWorkspaces.find(
                                (candidate) => candidate.path === event.target.value,
                              );
                              if (favoriteWorkspace !== undefined) {
                                props.onPreferenceChange(executor.ref, {
                                  favoriteScope: "workspace",
                                  favoriteWorkspace,
                                });
                              }
                            }}
                          >
                            {executorFavoriteWorkspaces.map((candidate) => (
                              <option value={candidate.path} key={candidate.path}>
                                {candidate.basename} — {candidate.path}
                              </option>
                            ))}
                            <option value={CHOOSE_FAVORITE_WORKSPACE_VALUE}>
                              {t("chooseFavoriteWorkspace")}
                            </option>
                          </select>
                        </label>
                      ) : null}
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
                            props.onPreferenceChange(executor.ref, {
                              hidden: !executor.preference.hidden,
                            })
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
            </div>
          </section>
        </div>
      ) : null}
    </>
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
    if (isHomeExecutorFavorite(executor, workspacePath)) return 0;
    if (executor.alwaysVisible) return 1;
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

export function isHomeExecutorFavorite(
  executor: HomeMissionExecutorOption,
  workspacePath: string | undefined,
): boolean {
  return (
    executor.preference.favoriteScope === "global" ||
    (executor.preference.favoriteScope === "workspace" &&
      executor.preference.favoriteWorkspace?.path === workspacePath)
  );
}

export function uniqueWorkspaces(
  workspaces: readonly WorkspaceSelection[],
): readonly WorkspaceSelection[] {
  const unique = new Map<string, WorkspaceSelection>();
  for (const workspace of workspaces) {
    if (!unique.has(workspace.path)) unique.set(workspace.path, workspace);
  }
  return [...unique.values()];
}

export function selectHomeMissionExecutors(
  executors: readonly HomeMissionExecutorOption[],
  query: string,
  kind: "all" | HomeMissionExecutorOption["kind"],
  tag: string,
  workspacePath: string | undefined,
  displayCopy: (
    executor: HomeMissionExecutorOption,
  ) => Pick<HomeMissionExecutorOption, "name" | "description"> = (executor) => executor,
): readonly HomeMissionExecutorOption[] {
  return rankHomeMissionExecutors(
    filterMissionExecutors(executors, query, displayCopy)
      .filter((executor) => !executor.preference.hidden)
      .filter((executor) => kind === "all" || executor.kind === kind)
      .filter((executor) => tag === "all" || executor.tags.includes(tag)),
    workspacePath,
    displayCopy,
  );
}

async function clearExecutorWorkspaceAssociation(
  ref: string,
  setExecutors: Dispatch<SetStateAction<readonly HomeMissionExecutorOption[]>>,
): Promise<void> {
  try {
    const preference = await window.pragmaDesktop.updateHomeExecutorPreference({
      ref,
      clearLastWorkspace: true,
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
