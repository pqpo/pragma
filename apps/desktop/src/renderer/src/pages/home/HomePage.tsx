import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ArrowUp,
  CaretDown,
  Check,
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
  const [executors, setExecutors] = useState<readonly MissionExecutorOption[]>([]);
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

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.pragmaDesktop.listMissionExecutors(),
      window.pragmaDesktop.getMissionCreationDefaults(),
    ])
      .then(([availableExecutors, defaults]) => {
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
        setWorkspaceOverride(persisted?.workspaceOverride);
        setExecutorRef(selected?.ref ?? "");
        inputExecutorRef.current = selected?.ref ?? "";
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
        if (persisted?.workspaceOverride !== undefined) {
          void window.pragmaDesktop
            .validateWorkspace(persisted.workspaceOverride.path)
            .then((validation) => {
              if (!cancelled && !validation.ok) setWorkspaceOverride(undefined);
            })
            .catch(() => {
              if (!cancelled) setWorkspaceOverride(undefined);
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
                onChange={setExecutorRef}
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
  readonly executors: readonly MissionExecutorOption[];
  readonly value: string;
  readonly defaultExecutorRef: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useTranslation("missions");
  const { t: tCommon } = useTranslation("common");
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
  const pragmaCopy = {
    name: tCommon("builtInExperts.pragma.name"),
    description: tCommon("builtInExperts.pragma.description"),
    scope: tCommon("builtInExperts.pragma.scope"),
  };
  const displayCopy = (executor: MissionExecutorOption) =>
    localizeSystemExpertCopy(executor, pragmaCopy);
  const selectedCopy = selected === undefined ? undefined : displayCopy(selected);
  const query = search.trim().toLocaleLowerCase();
  const visibleExecutors = filterMissionExecutors(props.executors, query, displayCopy);
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
                <button
                  type="button"
                  aria-pressed={isSelected}
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
                    <strong>{copy.name}</strong>
                    <small>{copy.description}</small>
                  </span>
                  <span className="mission-executor-option-meta">
                    <Check
                      className={isSelected ? "is-visible" : undefined}
                      size={17}
                      aria-hidden="true"
                    />
                    <span className="mission-executor-option-kind">
                      {isDefault ? t("defaultExecutor") : executorLabel(executor)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function filterMissionExecutors(
  executors: readonly MissionExecutorOption[],
  query: string,
  displayCopy: (
    executor: MissionExecutorOption,
  ) => Pick<MissionExecutorOption, "name" | "description"> = (executor) => executor,
): readonly MissionExecutorOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return executors
    .filter((executor) => {
      if (normalizedQuery === "") return true;
      const copy = displayCopy(executor);
      return [copy.name, copy.description, executor.ref, executor.kind].some((value) =>
        value.toLocaleLowerCase().includes(normalizedQuery),
      );
    })
    .slice(0, 5);
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
