import { useEffect, useMemo, useRef, useState } from "react";
import {
  Books,
  CaretDown,
  Check,
  Files,
  Folder,
  GitBranch,
  MagnifyingGlass,
  Stack,
  Toolbox,
  User,
  UsersThree,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import type {
  DesktopToolPermissionMode,
  DesktopRuntimeAvailability,
  ExpertModelConfig,
  Mission,
  MissionExecutorOption,
} from "../../../../shared/desktop-api.ts";
import { ToolPermissionSelect } from "../../components/ToolPermissionSelect.tsx";
import { errorMessage } from "../../lib/errors.ts";

export function HomePage(props: {
  readonly initialExecutorRef?: string | undefined;
  readonly onCreated: (mission: Mission) => void | Promise<void>;
}) {
  const { t } = useTranslation("missions");
  const [executors, setExecutors] = useState<readonly MissionExecutorOption[]>([]);
  const [runtimes, setRuntimes] = useState<readonly DesktopRuntimeAvailability[]>([]);
  const [workspace, setWorkspace] = useState<{ path: string; basename: string } | null>(null);
  const [executorRef, setExecutorRef] = useState(props.initialExecutorRef ?? "");
  const [defaultExecutorRef, setDefaultExecutorRef] = useState("");
  const [goal, setGoal] = useState("");
  const [toolPermissionMode, setToolPermissionMode] =
    useState<DesktopToolPermissionMode>("request-approval");
  const [modelOverride, setModelOverride] = useState<ExpertModelConfig>();
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.pragmaDesktop.listMissionExecutors(),
      window.pragmaDesktop.getMissionCreationDefaults(),
      window.pragmaDesktop.getRuntimeAvailability(),
    ])
      .then(([availableExecutors, defaults, runtimeAvailability]) => {
        if (cancelled) return;
        setExecutors(availableExecutors);
        setRuntimes(runtimeAvailability);
        setWorkspace(defaults.workspace);
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

  useEffect(() => setModelOverride(undefined), [executorRef]);

  const pickWorkspace = async () => {
    try {
      const result = await window.pragmaDesktop.pickWorkspace();
      if (result.ok && result.path !== undefined && result.basename !== undefined) {
        setWorkspace({ path: result.path, basename: result.basename });
        setError(null);
      } else if (result.reason !== "cancelled") {
        setError(result.error ?? t("workspaceUnavailable"));
      }
    } catch (pickError) {
      setError(errorMessage(pickError));
    }
  };

  const submit = async () => {
    if (workspace === null || !hasValidExecutor || goal.trim() === "" || saving) return;
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
        <div className="mission-create-selectors">
          <button className="mission-selector" type="button" onClick={() => void pickWorkspace()}>
            <span className="mission-selector-icon">
              <Folder size={23} aria-hidden="true" />
            </span>
            <span className="mission-selector-copy">
              <small>{t("workspace")}</small>
              <strong>{workspace?.basename ?? t("chooseFolder")}</strong>
              <em>{workspace?.path ?? t("oneDirectory")}</em>
            </span>
          </button>
          <MissionExecutorPicker
            executors={executors}
            value={hasValidExecutor ? executorRef : ""}
            onChange={setExecutorRef}
          />
        </div>
        {selectedExecutor?.kind === "expert" || selectedExecutor?.kind === "team" ? (
          <MissionModelOverrideControls
            runtimes={runtimes}
            value={modelOverride}
            onChange={setModelOverride}
          />
        ) : null}
        <div className="mission-goal-composer">
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
          <footer>
            <div className="mission-prompt-tools" aria-label={t("contextTools")}>
              <button type="button" aria-disabled="true" title={t("inheritedContext")}>
                <Stack size={18} aria-hidden="true" />
                {t("context")}
              </button>
              <button
                className={workspace === null ? "" : "is-active"}
                type="button"
                onClick={() => void pickWorkspace()}
                title={workspace?.path ?? t("chooseWorkspaceFiles")}
              >
                <Files size={18} aria-hidden="true" />
                {t("files")}
              </button>
              <button type="button" aria-disabled="true" title={t("managedKnowledge")}>
                <Books size={18} aria-hidden="true" />
                {t("knowledge")}
              </button>
              <button type="button" aria-disabled="true" title={t("managedTools")}>
                <Toolbox size={18} aria-hidden="true" />
                {t("tools")}
              </button>
              <ToolPermissionSelect
                value={toolPermissionMode}
                onChange={setToolPermissionMode}
                disabled={saving}
                title={t("permissionOverride")}
              />
            </div>
            <button
              className="primary-button"
              type="button"
              disabled={saving || workspace === null || !hasValidExecutor || goal.trim() === ""}
              onClick={() => void submit()}
            >
              {saving ? t("starting") : t("startMission")}
            </button>
          </footer>
        </div>
        {loaded && executors.length === 0 ? (
          <p className="mission-form-note">{t("createFirst")}</p>
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

export function MissionModelOverrideControls(props: {
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly value?: ExpertModelConfig | undefined;
  readonly onChange: (value: ExpertModelConfig | undefined) => void;
}) {
  const { t } = useTranslation("missions");
  const models = props.runtimes.flatMap((runtime) =>
    runtime.status !== "available"
      ? []
      : (runtime.models ?? []).map((model) => ({ runtime, model })),
  );
  const valueKey =
    props.value === undefined
      ? ""
      : modelOptionKey(props.value.runtimeId, props.value.providerId, props.value.modelId);
  const selected = models.find(
    ({ runtime, model }) => modelOptionKey(runtime.id, model.provider.id, model.id) === valueKey,
  );
  const thinkingLevels = selected?.model.thinking?.supportedLevels ?? [];

  return (
    <div className="mission-model-overrides">
      <label>
        <span>{t("modelOverride")}</span>
        <select
          value={valueKey}
          onChange={(event) => {
            const option = models.find(
              ({ runtime, model }) =>
                modelOptionKey(runtime.id, model.provider.id, model.id) === event.target.value,
            );
            props.onChange(
              option === undefined
                ? undefined
                : {
                    runtimeId: option.runtime.id,
                    providerId: option.model.provider.id,
                    modelId: option.model.id,
                  },
            );
          }}
        >
          <option value="">{t("useExecutorDefaultModel")}</option>
          {models.map(({ runtime, model }) => (
            <option
              key={modelOptionKey(runtime.id, model.provider.id, model.id)}
              value={modelOptionKey(runtime.id, model.provider.id, model.id)}
            >
              {runtime.displayName} · {model.provider.displayName} · {model.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("thinkingDepth")}</span>
        <select
          value={props.value?.thinkingLevel ?? ""}
          disabled={props.value === undefined || thinkingLevels.length === 0}
          onChange={(event) => {
            if (props.value === undefined) return;
            const thinkingLevel = event.target.value;
            props.onChange({
              runtimeId: props.value.runtimeId,
              providerId: props.value.providerId,
              modelId: props.value.modelId,
              ...(thinkingLevel === "" ? {} : { thinkingLevel }),
            });
          }}
        >
          <option value="">{t("useModelDefaultThinking")}</option>
          {thinkingLevels.map((level) => (
            <option key={level.value} value={level.value}>
              {level.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function modelOptionKey(runtimeId: string, providerId: string, modelId: string): string {
  return JSON.stringify([runtimeId, providerId, modelId]);
}

function MissionExecutorPicker(props: {
  readonly executors: readonly MissionExecutorOption[];
  readonly value: string;
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
        <small>{t("executor")}</small>
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
          <strong>{selected?.name ?? t("chooseResource")}</strong>
          <CaretDown size={16} aria-hidden="true" />
        </button>
        <em>
          {selected === undefined
            ? t("executableOnly")
            : `${executorLabel(selected)} · ${selected.version}`}
        </em>
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
            <div
              className="mission-executor-options"
              role="list"
              aria-label={t("missionExecutors")}
            >
              {visibleExecutors.map((executor, index) => {
                const Icon = executorIcon(executor);
                const isSelected = executor.ref === props.value;
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
                    <span className="mission-executor-option-kind">{executorLabel(executor)}</span>
                    {isSelected ? <Check size={17} aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function executorIcon(executor: Pick<MissionExecutorOption, "kind">) {
  return executor.kind === "expert" ? User : executor.kind === "team" ? UsersThree : GitBranch;
}
