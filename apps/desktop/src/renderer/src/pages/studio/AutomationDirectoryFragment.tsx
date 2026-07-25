import { ArrowLeft, CaretDown, Check, Clock, Plus, Robot, Trash } from "@phosphor-icons/react";
import {
  PRAGMA_AUTOMATION_PROMPT_MAX_LENGTH,
  PRAGMA_RESOURCE_DESCRIPTION_MAX_LENGTH,
  PRAGMA_RESOURCE_NAME_MAX_LENGTH,
  PragmaScheduleTriggerSchema,
} from "@pragma/interpreter/ast";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  AutomationSummary,
  DesktopToolPermissionMode,
  MissionCreationDefaults,
  MissionExecutorOption,
  PragmaProjectSnapshot,
} from "../../../../shared/desktop-api.ts";
import { WorkspacePicker, workspaceSelectionFromPath } from "../../components/WorkspacePicker.tsx";
import { errorMessage } from "../../lib/errors.ts";
import {
  SchemaInputForm,
  createSchemaInputValue,
  isSchemaInputValid,
} from "../home/SchemaInputForm.tsx";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type Weekday = (typeof WEEKDAYS)[number];
type FlowExecutor = Extract<MissionExecutorOption, { readonly kind: "flow" }>;

type EditorState = {
  readonly originalRef?: string | undefined;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly executorRef: string;
  readonly prompt: string;
  readonly flowInput: Readonly<Record<string, unknown>>;
  readonly interaction: "reuse-session" | "new-mission";
  readonly workspace: string;
  readonly toolPermissionMode: DesktopToolPermissionMode;
  readonly triggerKind: "once" | "interval" | "calendar" | "cron";
  readonly onceAt: string;
  readonly intervalEvery: number;
  readonly intervalUnit: "minutes" | "hours" | "days" | "weeks";
  readonly anchorAt: string;
  readonly frequency: "daily" | "weekdays" | "weekly" | "monthly";
  readonly time: string;
  readonly weekdays: readonly Weekday[];
  readonly dayOfMonth: number;
  readonly cron: string;
  readonly startsAt: string;
  readonly endsAt: string;
};

export function AutomationDirectoryFragment(props: {
  readonly automations: readonly AutomationSummary[];
  readonly project: PragmaProjectSnapshot;
  readonly onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation("studio");
  const { t: tMissions } = useTranslation("missions");
  const [tab, setTab] = useState<"automations" | "connections">("automations");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [executors, setExecutors] = useState<readonly MissionExecutorOption[]>([]);
  const [missionDefaults, setMissionDefaults] = useState<MissionCreationDefaults>();
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) return;
    let cancelled = false;
    void Promise.all([api.listMissionExecutors(), api.getMissionCreationDefaults()])
      .then(([items, defaults]) => {
        if (cancelled) return;
        setExecutors(items);
        setMissionDefaults(defaults);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedExecutor = useMemo(
    () => executors.find((executor) => executor.ref === editor?.executorRef),
    [editor?.executorRef, executors],
  );
  const flow = selectedExecutor?.kind === "flow";
  const flowInputSchema =
    selectedExecutor?.kind === "flow" ? selectedExecutor.inputSchema : undefined;
  const structuredFlowInput = flowInputSchema !== undefined;

  const openNew = async () => {
    const api = desktopApi();
    const defaults = await api?.getMissionCreationDefaults();
    const allocated = await api?.allocatePragmaResourceId();
    if (defaults !== undefined) setMissionDefaults(defaults);
    const executor = executors[0];
    const timestamp = localDateTime(new Date(Date.now() + 60 * 60_000));
    setEditor({
      id: allocated?.id ?? "",
      name: "",
      description: "",
      enabled: true,
      executorRef: executor?.ref ?? "",
      prompt: "",
      flowInput:
        executor?.kind === "flow" && executor.inputSchema !== undefined
          ? createSchemaInputValue(executor.inputSchema)
          : {},
      interaction: executor?.kind === "flow" ? "new-mission" : "reuse-session",
      workspace: defaults?.workspace.path ?? "",
      toolPermissionMode: defaults?.toolPermissionMode ?? "request-approval",
      triggerKind: "calendar",
      onceAt: timestamp,
      intervalEvery: 1,
      intervalUnit: "hours",
      anchorAt: timestamp,
      frequency: "daily",
      time: "09:00",
      weekdays: ["mon", "tue", "wed", "thu", "fri"],
      dayOfMonth: 1,
      cron: "0 9 * * *",
      startsAt: "",
      endsAt: "",
    });
    setPreview([]);
    setError(null);
  };

  const openExisting = (automation: AutomationSummary) => {
    const trigger = automation.resource.spec.config as {
      readonly trigger: Record<string, unknown>;
    };
    const value = trigger.trigger;
    const executor = executors.find(
      (candidate): candidate is FlowExecutor =>
        candidate.kind === "flow" && candidate.ref === automation.resource.spec.route.executor.ref,
    );
    const routeInput = automation.resource.spec.route.input;
    const window = value["window"] as
      | { readonly startsAt?: string; readonly endsAt?: string }
      | undefined;
    setEditor({
      originalRef: automation.ref,
      id: automation.resource.metadata.id,
      name: automation.resource.metadata.name,
      description: automation.resource.metadata.description,
      enabled: automation.resource.spec.enabled,
      executorRef: automation.resource.spec.route.executor.ref,
      prompt:
        routeInput.kind === "prompt"
          ? routeInput.value
          : typeof routeInput.value["goal"] === "string"
            ? routeInput.value["goal"]
            : "",
      flowInput:
        routeInput.kind === "flow"
          ? routeInput.value
          : executor?.inputSchema === undefined
            ? {}
            : createSchemaInputValue(executor.inputSchema),
      interaction: automation.resource.spec.interaction.mode,
      workspace: automation.binding?.workspace.path ?? "",
      toolPermissionMode: automation.binding?.toolPermissionMode ?? "request-approval",
      triggerKind: value["kind"] as EditorState["triggerKind"],
      onceAt: localDateTime(new Date(String(value["at"] ?? Date.now()))),
      intervalEvery: Number(value["every"] ?? 1),
      intervalUnit: (value["unit"] as EditorState["intervalUnit"]) ?? "hours",
      anchorAt: localDateTime(new Date(String(value["anchorAt"] ?? Date.now()))),
      frequency: (value["frequency"] as EditorState["frequency"]) ?? "daily",
      time: String(value["time"] ?? "09:00"),
      weekdays: Array.isArray(value["weekdays"])
        ? value["weekdays"].filter((weekday): weekday is Weekday =>
            WEEKDAYS.includes(weekday as Weekday),
          )
        : ["mon", "tue", "wed", "thu", "fri"],
      dayOfMonth: Number(value["dayOfMonth"] ?? 1),
      cron: String(value["expression"] ?? "0 9 * * *"),
      startsAt: window?.startsAt === undefined ? "" : localDateTime(new Date(window.startsAt)),
      endsAt: window?.endsAt === undefined ? "" : localDateTime(new Date(window.endsAt)),
    });
    setPreview([]);
    setError(null);
  };

  const save = async () => {
    if (editor === null) return;
    const validation = validateAutomationEditor(editor, selectedExecutor);
    if (!validation.valid) {
      setError(t("automationFormInvalid"));
      return;
    }
    const api = desktopApi();
    if (api === undefined) return;
    setSaving(true);
    setError(null);
    try {
      const routeInput =
        flow && structuredFlowInput
          ? { kind: "flow" as const, value: editor.flowInput }
          : { kind: "prompt" as const, value: editor.prompt.trim() };
      await api.saveAutomation({
        expectedProjectRevision: props.project.revision,
        resource: {
          apiVersion: "pragma/v3",
          kind: "Automation",
          metadata: {
            id: editor.id,
            name: editor.name,
            description: editor.description,
            tags: ["integration"],
          },
          spec: {
            adapter: "pragma.automation.schedule@v1",
            binding: "binding:desktop-automation",
            config: { trigger: scheduleTrigger(editor) },
            enabled: editor.enabled,
            route: { executor: { ref: editor.executorRef }, input: routeInput },
            interaction: { mode: flow ? "new-mission" : editor.interaction },
            delivery: { adapter: "pragma.automation.delivery.local@v1" },
          },
        },
        binding: {
          workspace: editor.workspace,
          toolPermissionMode: editor.toolPermissionMode,
        },
      });
      setEditor(null);
      await props.onChanged();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const showPreview = async () => {
    if (editor === null) return;
    try {
      const result = await desktopApi()?.previewAutomationSchedule({
        trigger: scheduleTrigger(editor),
        count: 5,
      });
      setPreview(result?.occurrences ?? []);
      setError(null);
    } catch (previewError) {
      setError(errorMessage(previewError));
    }
  };

  const pickWorkspace = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    try {
      const result = await api.pickWorkspace();
      if (result.ok && result.path !== undefined && result.basename !== undefined) {
        const selectedPath = result.path;
        setEditor((current) => (current === null ? null : { ...current, workspace: selectedPath }));
        setError(null);
      } else if (result.reason !== "cancelled") {
        setError(result.error ?? tMissions("workspaceUnavailable"));
      }
    } catch (pickError) {
      setError(errorMessage(pickError));
    }
  };

  if (editor !== null) {
    const knownWorkspaces =
      missionDefaults === undefined
        ? []
        : [missionDefaults.workspace, ...missionDefaults.recentWorkspaces];
    const selectedWorkspace = workspaceSelectionFromPath(editor.workspace, knownWorkspaces);
    const validation = validateAutomationEditor(editor, selectedExecutor);
    return (
      <StudioScreenFrame
        className="automation-editor"
        labelledBy="automation-editor-heading"
        header={
          <header className="automation-editor-heading">
            <button className="back-link" type="button" onClick={() => setEditor(null)}>
              <ArrowLeft size={17} aria-hidden="true" />
              {t("backIntegrations")}
            </button>
            <div>
              <h1 id="automation-editor-heading">
                {editor.originalRef === undefined ? t("newAutomation") : t("editAutomation")}
              </h1>
              <p>{t("automationEditorDescription")}</p>
            </div>
          </header>
        }
      >
        <form
          className="automation-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <section className="automation-form-section">
            <h2>{t("automationIdentity")}</h2>
            <div className="automation-field-grid">
              <label>
                <span>{t("name")}</span>
                <input
                  required
                  maxLength={PRAGMA_RESOURCE_NAME_MAX_LENGTH}
                  value={editor.name}
                  aria-invalid={validation.name !== undefined}
                  onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                />
                <FieldFeedback
                  value={editor.name}
                  max={PRAGMA_RESOURCE_NAME_MAX_LENGTH}
                  error={validation.name}
                />
              </label>
              <label>
                <span>{t("description")}</span>
                <input
                  required
                  maxLength={PRAGMA_RESOURCE_DESCRIPTION_MAX_LENGTH}
                  value={editor.description}
                  aria-invalid={validation.description !== undefined}
                  onChange={(event) => setEditor({ ...editor, description: event.target.value })}
                />
                <FieldFeedback
                  value={editor.description}
                  max={PRAGMA_RESOURCE_DESCRIPTION_MAX_LENGTH}
                  error={validation.description}
                />
              </label>
            </div>
          </section>

          <section className="automation-form-section">
            <h2>{t("automationTarget")}</h2>
            <div className="automation-field-grid">
              <label>
                <span>{t("executor")}</span>
                <select
                  required
                  value={editor.executorRef}
                  onChange={(event) => {
                    const next = executors.find((executor) => executor.ref === event.target.value);
                    setEditor({
                      ...editor,
                      executorRef: event.target.value,
                      interaction: next?.kind === "flow" ? "new-mission" : editor.interaction,
                      prompt: "",
                      flowInput:
                        next?.kind === "flow" && next.inputSchema !== undefined
                          ? createSchemaInputValue(next.inputSchema)
                          : {},
                    });
                  }}
                >
                  <option value="">{t("selectExecutor")}</option>
                  {executors.map((executor) => (
                    <option key={executor.ref} value={executor.ref}>
                      {executor.name} · {executor.kind}
                    </option>
                  ))}
                </select>
              </label>
              {!flow ? (
                <label>
                  <span>{t("sessionPolicy")}</span>
                  <select
                    value={editor.interaction}
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        interaction: event.target.value as EditorState["interaction"],
                      })
                    }
                  >
                    <option value="reuse-session">{t("reuseMission")}</option>
                    <option value="new-mission">{t("newMissionEveryRun")}</option>
                  </select>
                </label>
              ) : null}
            </div>
            {flowInputSchema !== undefined ? (
              <SchemaInputForm
                className="automation-flow-input-form"
                schema={flowInputSchema}
                value={editor.flowInput}
                disabled={saving}
                onChange={(flowInput) => setEditor({ ...editor, flowInput })}
              />
            ) : (
              <label>
                <span>{t("prompt")}</span>
                <textarea
                  required
                  rows={5}
                  maxLength={PRAGMA_AUTOMATION_PROMPT_MAX_LENGTH}
                  value={editor.prompt}
                  aria-invalid={validation.prompt !== undefined}
                  onChange={(event) => setEditor({ ...editor, prompt: event.target.value })}
                />
                <FieldFeedback
                  value={editor.prompt}
                  max={PRAGMA_AUTOMATION_PROMPT_MAX_LENGTH}
                  error={validation.prompt}
                />
              </label>
            )}
            {validation.flowInput !== undefined ? (
              <p className="automation-field-error" role="alert">
                {t("flowInputInvalid")}
              </p>
            ) : null}
          </section>

          <section className="automation-form-section">
            <h2>{t("schedulePolicy")}</h2>
            <div className="automation-field-grid">
              <label>
                <span>{t("triggerType")}</span>
                <select
                  value={editor.triggerKind}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      triggerKind: event.target.value as EditorState["triggerKind"],
                    })
                  }
                >
                  <option value="once">{t("scheduleOnce")}</option>
                  <option value="interval">{t("scheduleInterval")}</option>
                  <option value="calendar">{t("scheduleCalendar")}</option>
                  <option value="cron">Cron</option>
                </select>
              </label>
              {editor.triggerKind === "once" ? (
                <DateTimeField
                  label={t("runAt")}
                  value={editor.onceAt}
                  onChange={(onceAt) => setEditor({ ...editor, onceAt })}
                />
              ) : null}
              {editor.triggerKind === "interval" ? (
                <>
                  <label>
                    <span>{t("every")}</span>
                    <input
                      type="number"
                      min={1}
                      value={editor.intervalEvery}
                      onChange={(event) =>
                        setEditor({ ...editor, intervalEvery: Number(event.target.value) })
                      }
                    />
                  </label>
                  <label>
                    <span>{t("unit")}</span>
                    <select
                      value={editor.intervalUnit}
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          intervalUnit: event.target.value as EditorState["intervalUnit"],
                        })
                      }
                    >
                      {(["minutes", "hours", "days", "weeks"] as const).map((unit) => (
                        <option key={unit} value={unit}>
                          {t(`scheduleUnit.${unit}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <DateTimeField
                    label={t("anchorAt")}
                    value={editor.anchorAt}
                    onChange={(anchorAt) => setEditor({ ...editor, anchorAt })}
                  />
                </>
              ) : null}
              {editor.triggerKind === "calendar" ? (
                <>
                  <label>
                    <span>{t("frequency")}</span>
                    <select
                      value={editor.frequency}
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          frequency: event.target.value as EditorState["frequency"],
                        })
                      }
                    >
                      {(["daily", "weekdays", "weekly", "monthly"] as const).map((frequency) => (
                        <option key={frequency} value={frequency}>
                          {t(`scheduleFrequency.${frequency}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{t("time")}</span>
                    <input
                      type="time"
                      value={editor.time}
                      onClick={(event) => openNativePicker(event.currentTarget)}
                      onChange={(event) => setEditor({ ...editor, time: event.target.value })}
                    />
                  </label>
                  {editor.frequency === "weekly" ? (
                    <WeekdayMultiSelect
                      value={editor.weekdays}
                      onChange={(weekdays) => setEditor({ ...editor, weekdays })}
                    />
                  ) : null}
                  {editor.frequency === "monthly" ? (
                    <label>
                      <span>{t("dayOfMonth")}</span>
                      <input
                        type="number"
                        min={1}
                        max={31}
                        value={editor.dayOfMonth}
                        onChange={(event) =>
                          setEditor({ ...editor, dayOfMonth: Number(event.target.value) })
                        }
                      />
                    </label>
                  ) : null}
                </>
              ) : null}
              {editor.triggerKind === "cron" ? (
                <label>
                  <span>Cron</span>
                  <input
                    value={editor.cron}
                    onChange={(event) => setEditor({ ...editor, cron: event.target.value })}
                    placeholder="0 9 * * *"
                  />
                </label>
              ) : null}
              {editor.triggerKind !== "once" ? (
                <>
                  <DateTimeField
                    optional
                    label={t("activeFrom")}
                    value={editor.startsAt}
                    onChange={(startsAt) => setEditor({ ...editor, startsAt })}
                  />
                  <DateTimeField
                    optional
                    label={t("activeUntil")}
                    value={editor.endsAt}
                    onChange={(endsAt) => setEditor({ ...editor, endsAt })}
                  />
                </>
              ) : null}
            </div>
            {validation.trigger !== undefined ? (
              <p className="automation-field-error" role="alert">
                {t("scheduleInvalid")}
              </p>
            ) : null}
            <button className="secondary-button" type="button" onClick={() => void showPreview()}>
              {t("previewNextRuns")}
            </button>
            {preview.length > 0 ? (
              <ol className="automation-preview">
                {preview.map((occurrence) => (
                  <li key={occurrence}>{new Date(occurrence).toLocaleString()}</li>
                ))}
              </ol>
            ) : null}
          </section>

          <section className="automation-form-section">
            <h2>{t("executionEnvironment")}</h2>
            <div className="automation-field-grid">
              <div className="automation-workspace-field">
                <span className="automation-field-label">{t("workspace")}</span>
                <WorkspacePicker
                  className="automation-workspace-picker"
                  defaultWorkspace={missionDefaults?.workspace}
                  recentWorkspaces={missionDefaults?.recentWorkspaces ?? []}
                  selection={selectedWorkspace}
                  defaultSelected={
                    missionDefaults !== undefined &&
                    editor.workspace === missionDefaults.workspace.path
                  }
                  onChoose={() => void pickWorkspace()}
                  onSelect={(workspace) => setEditor({ ...editor, workspace: workspace.path })}
                  onUseDefault={() => {
                    if (missionDefaults !== undefined) {
                      setEditor({ ...editor, workspace: missionDefaults.workspace.path });
                    }
                  }}
                />
              </div>
              <label>
                <span>{t("toolPermissions")}</span>
                <select
                  value={editor.toolPermissionMode}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      toolPermissionMode: event.target.value as DesktopToolPermissionMode,
                    })
                  }
                >
                  <option value="request-approval">{t("requestApproval")}</option>
                  <option value="auto-approve">{t("autoApprove")}</option>
                  <option value="full-access">{t("fullAccess")}</option>
                </select>
              </label>
            </div>
            <label className="automation-switch">
              <input
                type="checkbox"
                checked={editor.enabled}
                onChange={(event) => setEditor({ ...editor, enabled: event.target.checked })}
              />
              <span>{t("enableAutomation")}</span>
            </label>
          </section>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <footer className="automation-form-actions">
            {editor.originalRef !== undefined ? (
              <button
                className="danger-button"
                type="button"
                onClick={() => {
                  void (async () => {
                    if (!window.confirm(t("deleteAutomationConfirm"))) return;
                    try {
                      await desktopApi()?.deleteAutomation({
                        expectedProjectRevision: props.project.revision,
                        ref: editor.originalRef!,
                      });
                      setEditor(null);
                      await props.onChanged();
                    } catch (deleteError) {
                      setError(errorMessage(deleteError));
                    }
                  })();
                }}
              >
                <Trash size={16} aria-hidden="true" />
                {t("deleteResourceAction")}
              </button>
            ) : null}
            <button className="secondary-button" type="button" onClick={() => setEditor(null)}>
              {t("cancel")}
            </button>
            <button className="primary-button" type="submit" disabled={saving || !validation.valid}>
              {saving ? t("saving") : t("saveAutomation")}
            </button>
          </footer>
        </form>
      </StudioScreenFrame>
    );
  }

  return (
    <StudioScreenFrame
      className="automation-directory"
      labelledBy="integrations-heading"
      header={
        <div className="studio-heading">
          <div>
            <h1 id="integrations-heading">{t("integrations")}</h1>
            <p>{t("integrationsDescription")}</p>
          </div>
          {tab === "automations" ? (
            <button className="primary-button" type="button" onClick={() => void openNew()}>
              <Plus size={17} aria-hidden="true" />
              {t("newAutomation")}
            </button>
          ) : null}
        </div>
      }
    >
      <div className="integration-tabs" role="tablist" aria-label={t("integrationSections")}>
        <button
          role="tab"
          aria-selected={tab === "automations"}
          className={tab === "automations" ? "is-active" : ""}
          type="button"
          onClick={() => setTab("automations")}
        >
          {t("automations")}
        </button>
        <button
          role="tab"
          aria-selected={tab === "connections"}
          className={tab === "connections" ? "is-active" : ""}
          type="button"
          onClick={() => setTab("connections")}
        >
          {t("connections")}
        </button>
      </div>
      {tab === "automations" ? (
        props.automations.length === 0 ? (
          <div className="automation-empty">
            <Clock size={28} aria-hidden="true" />
            <h2>{t("noAutomations")}</h2>
            <p>{t("noAutomationsDescription")}</p>
          </div>
        ) : (
          <div className="studio-asset-rows automation-rows">
            {props.automations.map((automation) => (
              <button
                className="studio-asset-row"
                type="button"
                key={automation.ref}
                onClick={() => openExisting(automation)}
              >
                <span className="studio-asset-icon">
                  <Clock size={22} aria-hidden="true" />
                </span>
                <span className="studio-asset-copy">
                  <strong>{automation.resource.metadata.name}</strong>
                  <span>
                    {automation.resource.spec.route.executor.ref} ·{" "}
                    {t(`automationStatus.${automation.status}`)}
                  </span>
                </span>
                <span className={`automation-status is-${automation.status}`}>
                  {automation.nextRunAt === undefined
                    ? t(`automationStatus.${automation.status}`)
                    : new Date(automation.nextRunAt).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        )
      ) : (
        <div className="connection-catalog">
          <article>
            <Clock size={24} aria-hidden="true" />
            <div>
              <h2>{t("localSchedule")}</h2>
              <p>{t("localScheduleDescription")}</p>
            </div>
            <strong>{t("builtIn")}</strong>
          </article>
          <article className="is-coming">
            <Robot size={24} aria-hidden="true" />
            <div>
              <h2>{t("imAndWebhook")}</h2>
              <p>{t("imAndWebhookDescription")}</p>
            </div>
            <strong>{t("comingSoon")}</strong>
          </article>
        </div>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </StudioScreenFrame>
  );
}

type FieldValidationError = "required" | "tooLong";

function FieldFeedback(props: {
  readonly value: string;
  readonly max: number;
  readonly error?: FieldValidationError | undefined;
}) {
  const { t } = useTranslation("studio");
  const error =
    props.error === undefined
      ? undefined
      : props.error === "required"
        ? t("fieldRequired")
        : t("fieldTooLong", { max: props.max });
  return (
    <small className={error === undefined ? "automation-field-meta" : "automation-field-error"}>
      <span>{error}</span>
      <span>
        {props.value.length}/{props.max}
      </span>
    </small>
  );
}

function WeekdayMultiSelect(props: {
  readonly value: readonly Weekday[];
  readonly onChange: (value: readonly Weekday[]) => void;
}) {
  const { t, i18n } = useTranslation("studio");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const labels = props.value.map((weekday) => t(`weekday.${weekday}`));
  const summary = new Intl.ListFormat(i18n.language, {
    style: "short",
    type: "conjunction",
  }).format(labels);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="automation-weekday-field">
      <span className="automation-field-label">{t("weekdays")}</span>
      <div
        className={open ? "automation-weekday-picker is-open" : "automation-weekday-picker"}
        ref={rootRef}
      >
        <button
          className="automation-weekday-trigger"
          type="button"
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => setOpen((current) => !current)}
        >
          <span>{summary}</span>
          <CaretDown size={16} aria-hidden="true" />
        </button>
        {open ? (
          <div className="automation-weekday-menu" role="menu" aria-label={t("weekdays")}>
            {WEEKDAYS.map((weekday) => {
              const selected = props.value.includes(weekday);
              return (
                <button
                  key={weekday}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={selected}
                  onClick={() => {
                    if (selected && props.value.length === 1) return;
                    props.onChange(
                      selected
                        ? props.value.filter((value) => value !== weekday)
                        : WEEKDAYS.filter(
                            (value) => value === weekday || props.value.includes(value),
                          ),
                    );
                  }}
                >
                  <span>{t(`weekday.${weekday}`)}</span>
                  {selected ? <Check size={16} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DateTimeField(props: {
  readonly label: string;
  readonly value: string;
  readonly optional?: boolean | undefined;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{props.label}</span>
      <input
        type="datetime-local"
        required={!props.optional}
        value={props.value}
        onClick={(event) => openNativePicker(event.currentTarget)}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

export function scheduleTrigger(editor: EditorState, timezone = systemTimezone()) {
  const window =
    editor.startsAt === "" && editor.endsAt === ""
      ? undefined
      : {
          ...(editor.startsAt === "" ? {} : { startsAt: toIso(editor.startsAt) }),
          ...(editor.endsAt === "" ? {} : { endsAt: toIso(editor.endsAt) }),
        };
  let trigger: unknown;
  switch (editor.triggerKind) {
    case "once":
      trigger = { kind: "once", at: toIso(editor.onceAt) };
      break;
    case "interval":
      trigger = {
        kind: "interval",
        every: editor.intervalEvery,
        unit: editor.intervalUnit,
        anchorAt: toIso(editor.anchorAt),
        ...(window === undefined ? {} : { window }),
      };
      break;
    case "calendar":
      trigger = {
        kind: "calendar",
        frequency: editor.frequency,
        time: editor.time,
        timezone,
        ...(editor.frequency === "weekly" ? { weekdays: editor.weekdays } : {}),
        ...(editor.frequency === "monthly" ? { dayOfMonth: editor.dayOfMonth } : {}),
        ...(window === undefined ? {} : { window }),
      };
      break;
    case "cron":
      trigger = {
        kind: "cron",
        expression: editor.cron,
        timezone,
        ...(window === undefined ? {} : { window }),
      };
      break;
  }
  const result = PragmaScheduleTriggerSchema.safeParse(trigger);
  if (!result.success) {
    const issue = result.error.issues[0];
    const location = issue?.path.join(".");
    throw new Error(
      `${location === undefined || location === "" ? "Schedule" : location}: ${issue?.message ?? "The schedule is invalid."}`,
    );
  }
  return result.data;
}

export function validateAutomationEditor(
  editor: EditorState,
  executor: MissionExecutorOption | undefined,
): {
  readonly valid: boolean;
  readonly name?: FieldValidationError | undefined;
  readonly description?: FieldValidationError | undefined;
  readonly prompt?: FieldValidationError | undefined;
  readonly flowInput?: "invalid" | undefined;
  readonly trigger?: "invalid" | undefined;
} {
  const name = validateText(editor.name, PRAGMA_RESOURCE_NAME_MAX_LENGTH);
  const description = validateText(editor.description, PRAGMA_RESOURCE_DESCRIPTION_MAX_LENGTH);
  const inputSchema = executor?.kind === "flow" ? executor.inputSchema : undefined;
  const prompt =
    inputSchema !== undefined
      ? undefined
      : validateText(editor.prompt, PRAGMA_AUTOMATION_PROMPT_MAX_LENGTH);
  const flowInput =
    inputSchema !== undefined && !isSchemaInputValid(inputSchema, editor.flowInput)
      ? ("invalid" as const)
      : undefined;
  let trigger: "invalid" | undefined;
  try {
    scheduleTrigger(editor);
  } catch {
    trigger = "invalid";
  }
  const valid =
    name === undefined &&
    description === undefined &&
    prompt === undefined &&
    flowInput === undefined &&
    trigger === undefined &&
    executor !== undefined &&
    editor.workspace !== "";
  return { valid, name, description, prompt, flowInput, trigger };
}

function validateText(value: string, max: number): FieldValidationError | undefined {
  if (value.trim() === "") return "required";
  if (value.length > max) return "tooLong";
  return undefined;
}

function openNativePicker(input: HTMLInputElement): void {
  try {
    input.showPicker?.();
  } catch {
    // The browser still provides its default input interaction when showPicker is unavailable.
  }
}

function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function toIso(value: string): string {
  return new Date(value).toISOString();
}

function localDateTime(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}
