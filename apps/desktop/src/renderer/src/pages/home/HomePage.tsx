import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  ArrowUp,
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  DotsSixVertical,
  Eye,
  EyeSlash,
  FolderOpen,
  GearSix,
  GitBranch,
  Lightbulb,
  MagnifyingGlass,
  Star,
  User,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import type { ExpertPromptAttachment, ExpertPromptAttachmentKind } from "@pragma/shared";
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
import {
  MissionAttachmentList,
  MissionAttachmentPicker,
} from "../../components/MissionAttachments.tsx";
import { MissionModelOverrideControls } from "../../components/MissionModelOverrideControls.tsx";
import { ExpertAvatar } from "../../components/ExpertAvatar.tsx";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { WorkspacePicker, type WorkspaceSelection } from "../../components/WorkspacePicker.tsx";
import { shouldSubmitComposerOnEnter } from "../../lib/composer-keyboard.ts";
import { errorMessage } from "../../lib/errors.ts";
import { readHomeDraft, writeHomeDraft } from "../../lib/home-draft.ts";
import {
  clipboardImageFile,
  mergeMissionAttachmentPreviews,
  mergeMissionAttachments,
  missionImageSupport,
  stageClipboardImage,
} from "../../lib/mission-attachments.ts";
import { localizeSystemExpertCopy } from "../../lib/system-expert-copy.ts";
import { SchemaInputForm, createSchemaInputValue, isSchemaInputValid } from "./SchemaInputForm.tsx";

const HOME_TIP_KEYS = ["context", "favorite", "approval", "attachment"] as const;
const HOME_GREETING_KEYS = ["context", "task", "collaboration", "focus"] as const;
const HOME_GREETING_INDEX = Math.floor(Math.random() * HOME_GREETING_KEYS.length);

function homeTimeGreetingKey(hour = new Date().getHours()): "morning" | "afternoon" | "evening" {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "evening";
}

export function HomePage(props: {
  readonly initialExecutorRef?: string | undefined;
  readonly onCreated: (mission: Mission) => void | Promise<void>;
  readonly onConfigureModels?: (() => void) | undefined;
}) {
  const { t } = useTranslation("missions");
  const timeGreeting = t(`homeTimeGreetings.${homeTimeGreetingKey()}`);
  const [executors, setExecutors] = useState<readonly HomeMissionExecutorOption[]>([]);
  const [defaultWorkspace, setDefaultWorkspace] = useState<WorkspaceSelection>();
  const [recentWorkspaces, setRecentWorkspaces] = useState<readonly WorkspaceSelection[]>([]);
  const [workspaceOverride, setWorkspaceOverride] = useState<WorkspaceSelection>();
  const [executorRef, setExecutorRef] = useState(props.initialExecutorRef ?? "");
  const [defaultExecutorRef, setDefaultExecutorRef] = useState("");
  const [goal, setGoal] = useState("");
  const [attachments, setAttachments] = useState<readonly ExpertPromptAttachment[]>([]);
  const [attachmentPreviews, setAttachmentPreviews] = useState<Readonly<Record<string, string>>>(
    {},
  );
  const [flowInput, setFlowInput] = useState<Readonly<Record<string, unknown>>>({});
  const [toolPermissionMode, setToolPermissionMode] =
    useState<DesktopToolPermissionMode>("request-approval");
  const [models, setModels] = useState<readonly DesktopRuntimeModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelOverride, setModelOverride] = useState<MissionModelOverride>();
  const [defaultModelSelection, setDefaultModelSelection] = useState<MissionModelOverride>();
  const [saving, setSaving] = useState(false);
  const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * HOME_TIP_KEYS.length));
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelResetRequired, setModelResetRequired] = useState(false);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [appVersion, setAppVersion] = useState<string>();
  const [executorManagerOpen, setExecutorManagerOpen] = useState(false);
  const modelRuntimeIdRef = useRef<string | undefined>(undefined);
  const inputExecutorRef = useRef(props.initialExecutorRef ?? "");
  const pendingModelOverrideRef = useRef<MissionModelOverride | undefined>(undefined);
  const workspaceAssociationRequestRef = useRef(props.initialExecutorRef ?? "");
  const attachmentIdsRef = useRef<readonly string[]>([]);

  useEffect(() => {
    attachmentIdsRef.current = attachments.map((attachment) => attachment.id);
  }, [attachments]);

  useEffect(
    () => () => {
      if (attachmentIdsRef.current.length > 0) {
        void window.pragmaDesktop.discardMissionAttachmentDrafts({
          attachmentIds: [...attachmentIdsRef.current],
        });
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void window.pragmaDesktop
      .getBridgeSnapshot()
      .then((snapshot) => {
        if (!cancelled) setAppVersion(snapshot.app.version);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTipIndex((current) => {
        if (HOME_TIP_KEYS.length < 2) return current;
        let next = current;
        while (next === current) next = Math.floor(Math.random() * HOME_TIP_KEYS.length);
        return next;
      });
    }, 6_000);
    return () => window.clearInterval(timer);
  }, []);

  const selectedExecutor = executors.find((executor) => executor.ref === executorRef);
  const imageUnsupported =
    missionImageSupport(models, modelOverride, defaultModelSelection) === "unsupported";
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
    if (next?.kind === "flow") clearAttachmentDrafts();
    const associatedWorkspace = preferredWorkspaceForExecutorSelection(next);
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

  const clearAttachmentDrafts = () => {
    const ids = attachments.map((attachment) => attachment.id);
    if (ids.length > 0) {
      void window.pragmaDesktop.discardMissionAttachmentDrafts({ attachmentIds: ids });
    }
    attachmentIdsRef.current = [];
    setAttachments([]);
    setAttachmentPreviews({});
  };

  const addAttachmentResult = (result: Awaited<ReturnType<typeof stageClipboardImage>>) => {
    setAttachments((current) => {
      const next = mergeMissionAttachments(current, result.attachments);
      if (next === undefined) {
        setError(t("attachmentLimit"));
        void window.pragmaDesktop.discardMissionAttachmentDrafts({
          attachmentIds: result.attachments.map((attachment) => attachment.id),
        });
        return current;
      }
      const acceptedIds = new Set(next.map((attachment) => attachment.id));
      const rejectedIds = result.attachments
        .filter((attachment) => !acceptedIds.has(attachment.id))
        .map((attachment) => attachment.id);
      if (rejectedIds.length > 0) {
        void window.pragmaDesktop.discardMissionAttachmentDrafts({ attachmentIds: rejectedIds });
      }
      if (next.length > current.length) {
        setAttachmentPreviews((previews) => mergeMissionAttachmentPreviews(previews, result, next));
        setError(null);
      }
      return next;
    });
  };

  const pickAttachments = async (kind: ExpertPromptAttachmentKind) => {
    if (selectedExecutor?.kind === "flow") return;
    try {
      const result = await window.pragmaDesktop.pickMissionAttachments({ kind });
      addAttachmentResult(result);
    } catch (pickError) {
      setError(errorMessage(pickError));
    }
  };

  const pasteImage = async (file: File) => {
    if (selectedExecutor?.kind === "flow" || saving) return;
    try {
      const result = await stageClipboardImage(file, (input) =>
        window.pragmaDesktop.stageMissionClipboardImage(input),
      );
      addAttachmentResult(result);
    } catch (pasteError) {
      setError(errorMessage(pasteError));
    }
  };

  const updateExecutorPreference = async (
    ref: string,
    update: {
      readonly favoriteScope?: HomeExecutorFavoriteScope;
      readonly favoriteWorkspace?: WorkspaceSelection;
      readonly hidden?: boolean;
    },
  ): Promise<boolean> => {
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
      return true;
    } catch (preferenceError) {
      setError(errorMessage(preferenceError));
      return false;
    }
  };

  const chooseFavoriteWorkspace = async (ref: string): Promise<boolean> => {
    try {
      const result = await window.pragmaDesktop.pickWorkspace();
      if (result.ok && result.path !== undefined && result.basename !== undefined) {
        return await updateExecutorPreference(ref, {
          favoriteScope: "workspace",
          favoriteWorkspace: { path: result.path, basename: result.basename },
          hidden: false,
        });
      }
      if (result.reason !== "cancelled") {
        setError(result.error ?? t("workspaceUnavailable"));
      }
      return false;
    } catch (pickError) {
      setError(errorMessage(pickError));
      return false;
    }
  };

  const reorderFavorites = async (orderedRefs: readonly string[]): Promise<void> => {
    const favorites = rankFavoriteHomeExecutors(executors);
    const byRef = new Map(favorites.map((executor) => [executor.ref, executor]));
    const reordered = orderedRefs
      .map((ref) => byRef.get(ref))
      .filter((executor): executor is HomeMissionExecutorOption => executor !== undefined);
    if (
      reordered.length !== favorites.length ||
      reordered.every((executor, index) => executor.ref === favorites[index]?.ref)
    )
      return;
    const rankByRef = new Map(reordered.map((executor, index) => [executor.ref, index]));

    setExecutors((current) =>
      current.map((executor) => {
        const favoriteRank = rankByRef.get(executor.ref);
        return favoriteRank === undefined
          ? executor
          : { ...executor, preference: { ...executor.preference, favoriteRank } };
      }),
    );
    try {
      await Promise.all(
        reordered.map((executor, favoriteRank) =>
          window.pragmaDesktop.updateHomeExecutorPreference({ ref: executor.ref, favoriteRank }),
        ),
      );
    } catch (reorderError) {
      setError(errorMessage(reorderError));
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
            : { kind: "prompt", value: goal.trim(), attachments: [...attachments] },
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
      attachmentIdsRef.current = [];
      setAttachments([]);
      setAttachmentPreviews({});
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
        <header className="home-welcome">
          <h1 id="new-mission-title">
            {t(`homeGreetings.${HOME_GREETING_KEYS[HOME_GREETING_INDEX]}`, {
              greeting: timeGreeting,
            })}
          </h1>
        </header>
        <div className="home-workspace-context">
          <MissionExecutorPicker
            executors={executors}
            value={hasValidExecutor ? executorRef : ""}
            defaultExecutorRef={defaultExecutorRef}
            workspace={workspaceOverride ?? defaultWorkspace}
            recentWorkspaces={recentWorkspaces}
            onChange={selectExecutor}
            onPreferenceChange={updateExecutorPreference}
            onChooseFavoriteWorkspace={chooseFavoriteWorkspace}
            managerOpen={executorManagerOpen}
            onManagerOpenChange={setExecutorManagerOpen}
          />
          <WorkspacePicker
            defaultWorkspace={defaultWorkspace}
            recentWorkspaces={recentWorkspaces}
            selection={workspaceOverride}
            defaultSelected={workspaceOverride === undefined}
            onChoose={() => void pickWorkspace()}
            onSelect={setWorkspaceOverride}
            onUseDefault={() => setWorkspaceOverride(undefined)}
          />
          <p className="home-inline-tip" aria-live="polite">
            <Lightbulb size={15} weight="regular" aria-hidden="true" />
            <span className="home-inline-tip-viewport">
              <span className="home-inline-tip-copy" key={tipIndex}>
                {t(`homeTips.${HOME_TIP_KEYS[tipIndex]}`)}
              </span>
            </span>
          </p>
        </div>
        <div className="mission-goal-composer">
          <MissionAttachmentList
            attachments={attachments}
            previews={attachmentPreviews}
            imageUnsupported={imageUnsupported}
            onRemove={(id) => {
              void window.pragmaDesktop.discardMissionAttachmentDrafts({ attachmentIds: [id] });
              setAttachments((current) => current.filter((attachment) => attachment.id !== id));
              setAttachmentPreviews((current) => {
                const next = { ...current };
                delete next[id];
                return next;
              });
            }}
          />
          {flowInputSchema === undefined ? (
            <div className="mission-goal-field">
              <textarea
                id="mission-goal"
                aria-label={t("goalPlaceholder")}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                onPaste={(event) => {
                  const file = clipboardImageFile(event.clipboardData);
                  if (file === undefined || selectedExecutor?.kind === "flow" || saving) return;
                  event.preventDefault();
                  void pasteImage(file);
                }}
                onKeyDown={(event) => {
                  if (shouldSubmitComposerOnEnter(event.nativeEvent)) {
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
              <MissionAttachmentPicker
                disabled={saving || selectedExecutor?.kind === "flow"}
                compact
                onPick={pickAttachments}
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
                detailed
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
        <HomeFavorites
          executors={executors}
          onSelect={selectExecutor}
          onReorder={(orderedRefs) => void reorderFavorites(orderedRefs)}
          onManage={() => setExecutorManagerOpen(true)}
        />
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
      {appVersion !== undefined ? <p className="home-app-version">v{appVersion}</p> : null}
    </section>
  );
}

function HomeFavorites(props: {
  readonly executors: readonly HomeMissionExecutorOption[];
  readonly onSelect: (ref: string) => void;
  readonly onReorder: (orderedRefs: readonly string[]) => void;
  readonly onManage: () => void;
}) {
  const { t } = useTranslation("missions");
  const { t: tCommon } = useTranslation("common");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draggedRef, setDraggedRef] = useState<string>();
  const [dragOrder, setDragOrder] = useState<readonly string[]>();
  const dragOrderRef = useRef<readonly string[] | undefined>(undefined);
  const dragInitialOrderRef = useRef<readonly string[] | undefined>(undefined);
  const favoriteItemRefs = useRef(new Map<string, HTMLElement>());
  const favoriteItemPositions = useRef(new Map<string, DOMRect>());
  const favorites = rankFavoriteHomeExecutors(props.executors);
  const favoritesByRef = new Map(favorites.map((executor) => [executor.ref, executor]));
  const dialogFavorites =
    dragOrder === undefined
      ? favorites
      : dragOrder
          .map((ref) => favoritesByRef.get(ref))
          .filter((executor): executor is HomeMissionExecutorOption => executor !== undefined);
  const compactFavorites = favorites.length > 6 ? favorites.slice(0, 5) : favorites.slice(0, 6);
  const pragmaCopy = {
    name: tCommon("builtInExperts.pragma.name"),
    description: tCommon("builtInExperts.pragma.description"),
    scope: tCommon("builtInExperts.pragma.scope"),
  };
  const displayCopy = (executor: HomeMissionExecutorOption) =>
    localizeSystemExpertCopy(executor, pragmaCopy);
  const kindLabel = (executor: HomeMissionExecutorOption) =>
    executor.kind === "expert"
      ? t("expert")
      : executor.kind === "team"
        ? t("expertTeam")
        : t("flow");

  useEffect(() => {
    if (!dialogOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDialogOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [dialogOpen]);

  useLayoutEffect(() => {
    if (!dialogOpen || draggedRef === undefined) {
      favoriteItemPositions.current.clear();
      return;
    }
    const previousPositions = favoriteItemPositions.current;
    const nextPositions = new Map<string, DOMRect>();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const [ref, item] of favoriteItemRefs.current) {
      const nextPosition = item.getBoundingClientRect();
      nextPositions.set(ref, nextPosition);
      const previousPosition = previousPositions.get(ref);
      const verticalDistance =
        previousPosition?.top === undefined ? 0 : previousPosition.top - nextPosition.top;
      if (verticalDistance !== 0 && !reduceMotion) {
        item.animate(
          [{ transform: `translateY(${verticalDistance}px)` }, { transform: "translateY(0)" }],
          { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
      }
    }
    favoriteItemPositions.current = nextPositions;
  }, [dialogOpen, draggedRef, dragOrder]);

  const clearDragPreview = () => {
    setDraggedRef(undefined);
    setDragOrder(undefined);
    dragOrderRef.current = undefined;
    dragInitialOrderRef.current = undefined;
    favoriteItemPositions.current.clear();
  };

  const commitDragPreview = () => {
    const orderedRefs = dragOrderRef.current;
    const initialOrder = dragInitialOrderRef.current;
    if (
      orderedRefs === undefined ||
      initialOrder === undefined ||
      orderedRefs.every((ref, index) => ref === initialOrder[index])
    ) {
      clearDragPreview();
      return;
    }
    props.onReorder(orderedRefs);
    setDraggedRef(undefined);
  };

  useEffect(() => {
    if (draggedRef === undefined) return;
    const updatePreview = (event: PointerEvent) => {
      const current = dragOrderRef.current ?? favorites.map((favorite) => favorite.ref);
      const targetItems = [...favoriteItemRefs.current]
        .filter(([ref]) => ref !== draggedRef)
        .map(([, item]) => ({ bounds: item.getBoundingClientRect() }))
        .toSorted((left, right) => left.bounds.top - right.bounds.top);
      const insertionIndex = targetItems.findIndex(
        ({ bounds }) => event.clientY <= bounds.top + bounds.height * 0.42,
      );
      const next = [...current.filter((ref) => ref !== draggedRef)];
      next.splice(insertionIndex < 0 ? next.length : insertionIndex, 0, draggedRef);
      if (next.every((ref, index) => ref === current[index])) return;
      dragOrderRef.current = next;
      setDragOrder(next);
    };
    window.addEventListener("pointermove", updatePreview);
    window.addEventListener("pointerup", commitDragPreview, { once: true });
    window.addEventListener("pointercancel", clearDragPreview, { once: true });
    return () => {
      window.removeEventListener("pointermove", updatePreview);
      window.removeEventListener("pointerup", commitDragPreview);
      window.removeEventListener("pointercancel", clearDragPreview);
    };
  }, [clearDragPreview, commitDragPreview, draggedRef, favorites]);

  useEffect(() => {
    if (draggedRef !== undefined || dragOrder === undefined) return;
    const currentOrder = favorites.map((favorite) => favorite.ref);
    if (!dragOrder.every((ref, index) => ref === currentOrder[index])) return;
    const timer = window.setTimeout(() => {
      setDragOrder(undefined);
      dragOrderRef.current = undefined;
      dragInitialOrderRef.current = undefined;
    }, 220);
    return () => window.clearTimeout(timer);
  }, [dragOrder, draggedRef, favorites]);

  if (favorites.length === 0) return null;

  const renderFavorite = (executor: HomeMissionExecutorOption, draggable = false) => {
    const Icon = executorIcon(executor);
    const copy = displayCopy(executor);
    const workspaceName =
      executor.preference.favoriteScope === "workspace"
        ? executor.preference.favoriteWorkspace?.basename
        : undefined;
    return (
      <article
        className={
          draggedRef === executor.ref ? "home-favorite-item is-dragging" : "home-favorite-item"
        }
        key={executor.ref}
        ref={(item) => {
          if (item === null) favoriteItemRefs.current.delete(executor.ref);
          else favoriteItemRefs.current.set(executor.ref, item);
        }}
      >
        {draggable ? (
          <button
            className="home-favorite-drag"
            type="button"
            aria-label={t("homeFavoritesDialogDescription")}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              const initialOrder = favorites.map((favorite) => favorite.ref);
              setDraggedRef(executor.ref);
              dragOrderRef.current = initialOrder;
              dragInitialOrderRef.current = initialOrder;
              setDragOrder(initialOrder);
            }}
          >
            <DotsSixVertical size={20} aria-hidden="true" />
          </button>
        ) : null}
        <button
          className="home-favorite-card"
          type="button"
          title={
            workspaceName === undefined
              ? copy.description
              : t("favoriteSwitchWorkspace", { workspace: workspaceName })
          }
          onClick={() => {
            props.onSelect(executor.ref);
            setDialogOpen(false);
          }}
        >
          <span className="home-favorite-avatar">
            {executor.kind === "flow" ? (
              <Icon size={draggable ? 26 : 24} aria-hidden="true" />
            ) : (
              <ExpertAvatar
                avatarId={executor.avatarId}
                team={executor.kind === "team"}
                size="sm"
              />
            )}
          </span>
          <span className="home-favorite-copy">
            <strong>{copy.name}</strong>
            <small>{workspaceName ?? kindLabel(executor)}</small>
          </span>
        </button>
      </article>
    );
  };

  return (
    <>
      <section className="home-favorites" aria-labelledby="home-favorites-title">
        <div className="home-favorites-heading">
          <div>
            <h2 id="home-favorites-title">{t("homeFavorites")}</h2>
            <button
              className="home-favorites-manage-button"
              type="button"
              aria-label={t("manageExecutors")}
              title={t("manageExecutors")}
              onClick={props.onManage}
            >
              <GearSix size={15} aria-hidden="true" />
            </button>
          </div>
          <span>{t("homeFavoritesHint")}</span>
        </div>
        <div className="home-favorites-list">
          {compactFavorites.map((executor) => renderFavorite(executor))}
          {favorites.length > 6 ? (
            <button
              className="home-favorite-more"
              type="button"
              onClick={() => setDialogOpen(true)}
            >
              {t("homeFavoritesMore", { count: favorites.length - compactFavorites.length })}
            </button>
          ) : null}
        </div>
      </section>
      {dialogOpen ? (
        <div
          className="home-favorites-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDialogOpen(false);
          }}
        >
          <section
            className="home-favorites-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="home-favorites-dialog-title"
          >
            <header>
              <div>
                <h2 id="home-favorites-dialog-title">{t("homeFavorites")}</h2>
                <p>{t("homeFavoritesDialogDescription")}</p>
              </div>
              <button
                type="button"
                aria-label={tCommon("actions.close")}
                onClick={() => setDialogOpen(false)}
              >
                <X size={19} aria-hidden="true" />
              </button>
            </header>
            <div className="home-favorites-dialog-list" role="list">
              {dialogFavorites.map((executor) => renderFavorite(executor, true))}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

export function previewFavoriteDragOrder(
  order: readonly string[],
  sourceRef: string,
  targetRef: string,
  placeAfter: boolean,
): readonly string[] {
  if (sourceRef === targetRef) return order;
  const sourceIndex = order.indexOf(sourceRef);
  if (sourceIndex < 0 || !order.includes(targetRef)) return order;
  const withoutSource = order.filter((ref) => ref !== sourceRef);
  const targetIndex = withoutSource.indexOf(targetRef);
  const next = [...withoutSource];
  next.splice(targetIndex + (placeAfter ? 1 : 0), 0, sourceRef);
  return next;
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
  ) => Promise<boolean>;
  readonly onChooseFavoriteWorkspace: (ref: string) => Promise<boolean>;
  readonly managerOpen: boolean;
  readonly onManagerOpenChange: Dispatch<SetStateAction<boolean>>;
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
  const [managerSearch, setManagerSearch] = useState("");
  const [managerView, setManagerView] = useState<"favorites" | "all" | "hidden">("all");
  const [managerKind, setManagerKind] = useState<"all" | HomeMissionExecutorOption["kind"]>("all");
  const [managerTag, setManagerTag] = useState("all");
  const overlayOwnerId = useId();
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

  useDismissableMenu(
    open,
    rootRef,
    () => {
      setOpen(false);
      setSearch("");
      setSelectionKind("all");
      setSelectionTag("all");
    },
    overlayOwnerId,
  );

  const closeManager = useCallback(() => {
    props.onManagerOpenChange(false);
    setManagerSearch("");
    setManagerView("all");
    setManagerKind("all");
    setManagerTag("all");
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, [props]);

  useEffect(() => {
    if (!props.managerOpen) return;
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
  }, [closeManager, props.managerOpen]);

  return (
    <>
      <div
        className={open ? "mission-executor-picker is-open" : "mission-executor-picker"}
        data-ui-overlay-id={overlayOwnerId}
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
          {selected !== undefined && selected.kind !== "flow" ? (
            <ExpertAvatar avatarId={selected.avatarId} team={selected.kind === "team"} size="xs" />
          ) : (
            <SelectedIcon size={17} aria-hidden="true" />
          )}
          <span>{selectedCopy?.name ?? t("chooseResource")}</span>
          <CaretDown size={14} aria-hidden="true" />
        </button>
        {open ? (
          <>
            <div
              className="mission-executor-selection-backdrop"
              role="presentation"
              onMouseDown={() => {
                setOpen(false);
                setSearch("");
                setSelectionKind("all");
                setSelectionTag("all");
              }}
            />
            <div
              className="mission-executor-menu"
              role="dialog"
              aria-modal="false"
              aria-label={t("chooseMissionExecutor")}
            >
              <header>
                <strong>{t("choose")}</strong>
                <button
                  className="mission-executor-close-button"
                  type="button"
                  aria-label={tCommon("actions.close")}
                  title={tCommon("actions.close")}
                  onClick={() => {
                    setOpen(false);
                    setSearch("");
                    setSelectionKind("all");
                    setSelectionTag("all");
                  }}
                >
                  <X size={17} aria-hidden="true" />
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
                <div>
                  <span className="sr-only">{t("filterExecutorKind")}</span>
                  <SelectMenu<"all" | HomeMissionExecutorOption["kind"]>
                    ariaLabel={t("filterExecutorKind")}
                    className="form-select"
                    overlayOwnerId={overlayOwnerId}
                    value={selectionKind}
                    options={[
                      { value: "all", label: t("allKinds") },
                      { value: "expert", label: t("expert") },
                      { value: "team", label: t("expertTeam") },
                      { value: "flow", label: t("flow") },
                    ]}
                    onChange={setSelectionKind}
                  />
                </div>
                {tags.length > 0 ? (
                  <div>
                    <span className="sr-only">{t("filterExecutorTag")}</span>
                    <SelectMenu
                      ariaLabel={t("filterExecutorTag")}
                      className="form-select"
                      overlayOwnerId={overlayOwnerId}
                      value={selectionTag}
                      options={[
                        { value: "all", label: t("allTags") },
                        ...tags.map((candidate) => ({ value: candidate, label: candidate })),
                      ]}
                      onChange={setSelectionTag}
                    />
                  </div>
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
                          {executor.kind === "flow" ? (
                            <Icon size={22} aria-hidden="true" />
                          ) : (
                            <ExpertAvatar
                              avatarId={executor.avatarId}
                              team={executor.kind === "team"}
                              size="sm"
                            />
                          )}
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
          </>
        ) : null}
      </div>
      {props.managerOpen ? (
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
                <h2 id="mission-executor-manager-title">{t("manageExecutors")}</h2>
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
                  <div>
                    <span className="sr-only">{t("filterExecutorKind")}</span>
                    <SelectMenu<"all" | HomeMissionExecutorOption["kind"]>
                      ariaLabel={t("filterExecutorKind")}
                      className="form-select"
                      value={managerKind}
                      options={[
                        { value: "all", label: t("allKinds") },
                        { value: "expert", label: t("expert") },
                        { value: "team", label: t("expertTeam") },
                        { value: "flow", label: t("flow") },
                      ]}
                      onChange={setManagerKind}
                    />
                  </div>
                  {tags.length > 0 ? (
                    <div>
                      <span className="sr-only">{t("filterExecutorTag")}</span>
                      <SelectMenu
                        ariaLabel={t("filterExecutorTag")}
                        className="form-select"
                        value={managerTag}
                        options={[
                          { value: "all", label: t("allTags") },
                          ...tags.map((candidate) => ({ value: candidate, label: candidate })),
                        ]}
                        onChange={setManagerTag}
                      />
                    </div>
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
                        {executor.kind === "flow" ? (
                          <Icon size={22} aria-hidden="true" />
                        ) : (
                          <ExpertAvatar
                            avatarId={executor.avatarId}
                            team={executor.kind === "team"}
                            size="sm"
                          />
                        )}
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
                      <ExecutorFavoriteMenu
                        executor={executor}
                        name={copy.name}
                        workspaces={executorFavoriteWorkspaces}
                        disabled={executor.preference.hidden || executor.alwaysVisible}
                        onPreferenceChange={(update) =>
                          props.onPreferenceChange(executor.ref, update)
                        }
                        onChooseWorkspace={() => props.onChooseFavoriteWorkspace(executor.ref)}
                      />
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
                            void props.onPreferenceChange(executor.ref, {
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

function ExecutorFavoriteMenu(props: {
  readonly executor: HomeMissionExecutorOption;
  readonly name: string;
  readonly workspaces: readonly WorkspaceSelection[];
  readonly disabled: boolean;
  readonly onPreferenceChange: (update: {
    readonly favoriteScope: HomeExecutorFavoriteScope;
    readonly favoriteWorkspace?: WorkspaceSelection;
  }) => Promise<boolean>;
  readonly onChooseWorkspace: () => Promise<boolean>;
}) {
  const { t } = useTranslation("missions");
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"scope" | "workspace">("scope");
  const [saving, setSaving] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const preference = props.executor.preference;
  const selectedLabel =
    preference.favoriteScope === "workspace"
      ? (preference.favoriteWorkspace?.basename ?? t("favoriteScope.workspace"))
      : t(`favoriteScope.${preference.favoriteScope}`);
  const isFavorite = preference.favoriteScope !== "none";

  const close = useCallback(() => {
    setOpen(false);
    setView("scope");
  }, []);

  const positionMenu = useCallback(() => {
    const trigger = triggerRef.current;
    if (trigger === null) return;
    const triggerRect = trigger.getBoundingClientRect();
    const menuWidth = 188;
    const menuHeight = menuRef.current?.getBoundingClientRect().height ?? 150;
    const left = Math.max(
      12,
      Math.min(triggerRect.right - menuWidth, window.innerWidth - menuWidth - 12),
    );
    const below = triggerRect.bottom + 6;
    const top =
      below + menuHeight <= window.innerHeight - 12
        ? below
        : Math.max(12, triggerRect.top - menuHeight - 6);
    setPosition({ top, left });
  }, []);

  useDismissableMenu(open, rootRef, close);

  useLayoutEffect(() => {
    if (!open) return;
    positionMenu();
  }, [open, positionMenu, view]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => positionMenu();
    window.addEventListener("resize", reposition);
    document.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      document.removeEventListener("scroll", reposition, true);
    };
  }, [open, positionMenu]);

  const applyPreference = async (update: {
    readonly favoriteScope: HomeExecutorFavoriteScope;
    readonly favoriteWorkspace?: WorkspaceSelection;
  }) => {
    setSaving(true);
    const updated = await props.onPreferenceChange(update);
    setSaving(false);
    if (updated) close();
  };

  const chooseWorkspace = async () => {
    setSaving(true);
    const updated = await props.onChooseWorkspace();
    setSaving(false);
    if (updated) close();
  };

  return (
    <div className="mission-executor-favorite-control" ref={rootRef}>
      <button
        className={
          isFavorite
            ? "mission-executor-favorite-trigger is-favorite"
            : "mission-executor-favorite-trigger"
        }
        type="button"
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("favoriteNamed", { name: props.name })}
        disabled={props.disabled || saving}
        onClick={() => {
          setView("scope");
          setOpen((current) => !current);
        }}
      >
        <Star size={15} weight={isFavorite ? "fill" : "regular"} aria-hidden="true" />
        <span>{selectedLabel}</span>
        <CaretDown size={12} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="mission-executor-favorite-menu"
          ref={menuRef}
          role="menu"
          aria-label={
            view === "scope"
              ? t("favoriteNamed", { name: props.name })
              : t("favoriteWorkspaceNamed", { name: props.name })
          }
          style={position}
        >
          {view === "scope" ? (
            <>
              {(["none", "global"] as const).map((scope) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={preference.favoriteScope === scope}
                  disabled={saving}
                  key={scope}
                  onClick={() => void applyPreference({ favoriteScope: scope })}
                >
                  <Star
                    size={15}
                    weight={scope === "global" ? "fill" : "regular"}
                    aria-hidden="true"
                  />
                  <span>{t(`favoriteScope.${scope}`)}</span>
                  {preference.favoriteScope === scope ? (
                    <Check size={14} aria-hidden="true" />
                  ) : (
                    <span aria-hidden="true" />
                  )}
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                disabled={saving}
                onClick={() => setView("workspace")}
              >
                <GitBranch size={15} aria-hidden="true" />
                <span>{t("favoriteScope.workspace")}</span>
                <CaretRight size={14} aria-hidden="true" />
              </button>
            </>
          ) : (
            <>
              <button
                className="mission-executor-favorite-menu-back"
                type="button"
                role="menuitem"
                onClick={() => setView("scope")}
              >
                <CaretLeft size={14} aria-hidden="true" />
                <span>{t("selectFavoriteWorkspace")}</span>
                <span aria-hidden="true" />
              </button>
              {props.workspaces.map((workspace) => {
                const selected =
                  preference.favoriteScope === "workspace" &&
                  workspacePathsEqual(preference.favoriteWorkspace?.path, workspace.path);
                return (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    disabled={saving}
                    key={workspace.path}
                    onClick={() =>
                      void applyPreference({
                        favoriteScope: "workspace",
                        favoriteWorkspace: workspace,
                      })
                    }
                  >
                    <GitBranch size={15} aria-hidden="true" />
                    <span>{workspace.basename}</span>
                    {selected ? (
                      <Check size={14} aria-hidden="true" />
                    ) : (
                      <span aria-hidden="true" />
                    )}
                  </button>
                );
              })}
              <button
                className="mission-executor-favorite-menu-choose"
                type="button"
                role="menuitem"
                disabled={saving}
                onClick={() => void chooseWorkspace()}
              >
                <FolderOpen size={15} aria-hidden="true" />
                <span>{t("chooseDifferentWorkspace")}</span>
                <span aria-hidden="true" />
              </button>
            </>
          )}
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

export function rankFavoriteHomeExecutors(
  executors: readonly HomeMissionExecutorOption[],
): readonly HomeMissionExecutorOption[] {
  return executors
    .filter(
      (executor) => !executor.preference.hidden && executor.preference.favoriteScope !== "none",
    )
    .toSorted((left, right) => {
      const rankDifference =
        (left.preference.favoriteRank ?? Number.MAX_SAFE_INTEGER) -
        (right.preference.favoriteRank ?? Number.MAX_SAFE_INTEGER);
      if (rankDifference !== 0) return rankDifference;
      const recentDifference =
        Date.parse(right.preference.lastUsedAt ?? "1970-01-01T00:00:00.000Z") -
        Date.parse(left.preference.lastUsedAt ?? "1970-01-01T00:00:00.000Z");
      return recentDifference !== 0 ? recentDifference : left.name.localeCompare(right.name);
    });
}

export function preferredWorkspaceForExecutorSelection(
  executor: HomeMissionExecutorOption | undefined,
): WorkspaceSelection | undefined {
  return executor?.preference.favoriteScope === "workspace"
    ? executor.preference.favoriteWorkspace
    : executor?.preference.lastWorkspace;
}

export function isHomeExecutorFavorite(
  executor: HomeMissionExecutorOption,
  workspacePath: string | undefined,
): boolean {
  return (
    executor.preference.favoriteScope === "global" ||
    (executor.preference.favoriteScope === "workspace" &&
      workspacePathsEqual(executor.preference.favoriteWorkspace?.path, workspacePath))
  );
}

export function workspacePathsEqual(left: string | undefined, right: string | undefined): boolean {
  return (
    left !== undefined && right !== undefined && workspacePathKey(left) === workspacePathKey(right)
  );
}

function workspacePathKey(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/");
  const withoutTrailingSeparators =
    normalized.length > 1 ? normalized.replace(/\/+$/u, "") : normalized;
  return withoutTrailingSeparators.replace(
    /^([A-Z]):/u,
    (_match, drive: string) => `${drive.toLocaleLowerCase()}:`,
  );
}

export function uniqueWorkspaces(
  workspaces: readonly WorkspaceSelection[],
): readonly WorkspaceSelection[] {
  const unique = new Map<string, WorkspaceSelection>();
  for (const workspace of workspaces) {
    const key = workspacePathKey(workspace.path);
    if (!unique.has(key)) unique.set(key, workspace);
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
  overlayOwnerId?: string,
): void {
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || rootRef.current?.contains(event.target)) return;
      const overlay =
        event.target instanceof Element ? event.target.closest("[data-ui-overlay-owner]") : null;
      if (overlay !== null && belongsToUiOverlayOwner(overlay, overlayOwnerId)) return;
      close();
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
  }, [close, open, overlayOwnerId, rootRef]);
}

export function belongsToUiOverlayOwner(element: Element, overlayOwnerId?: string): boolean {
  return element.getAttribute("data-ui-overlay-owner") === overlayOwnerId;
}

function executorIcon(executor: Pick<HomeMissionExecutorOption, "kind">) {
  return executor.kind === "expert" ? User : executor.kind === "team" ? UsersThree : GitBranch;
}
