import { ArrowLeft, CaretDown, Check, Clock, Plus, Robot } from "@phosphor-icons/react";
import { PragmaScheduleTriggerSchema } from "@pragma/interpreter/ast";
import {
  PRAGMA_TEXT_LIMITS,
  pragmaUnicodeLength,
  truncatePragmaTrimmedUnicode,
} from "@pragma/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  AutomationSummary,
  DesktopToolPermissionMode,
  MissionCreationDefaults,
  MissionExecutorOption,
  PragmaProjectSnapshot,
} from "../../../../shared/contracts/index.ts";
import { DateTimePicker } from "../../components/DateTimePicker.tsx";
import { MissionExecutorPicker } from "../../components/MissionExecutorPicker.tsx";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { Switch } from "../../components/Switch.tsx";
import { ToolPermissionSelect } from "../../components/ToolPermissionSelect.tsx";
import { WorkspacePicker, workspaceSelectionFromPath } from "../../components/WorkspacePicker.tsx";
import { errorMessage } from "../../lib/errors.ts";
import {
  SchemaInputForm,
  createSchemaInputValue,
  isSchemaInputValid,
} from "../home/SchemaInputForm.tsx";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { AutomationDetailFragment } from "./AutomationDetailFragment.tsx";
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

type AutomationField =
  "name" | "description" | "executor" | "prompt" | "flowInput" | "trigger" | "workspace";

export function createNewAutomationEditor(
  id: string,
  defaults: MissionCreationDefaults | undefined,
  now = Date.now(),
): EditorState {
  const timestamp = localDateTime(new Date(now + 60 * 60_000));
  return {
    id,
    name: "",
    description: "",
    enabled: true,
    executorRef: "",
    prompt: "",
    flowInput: {},
    interaction: "reuse-session",
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
  };
}

export function AutomationDirectoryFragment(props: {
  readonly automations: readonly AutomationSummary[];
  readonly project: PragmaProjectSnapshot;
  readonly onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation("studio");
  const { t: tCommon } = useTranslation("common");
  const { t: tMissions } = useTranslation("missions");
  const [tab, setTab] = useState<"automations" | "connections">("automations");
  const [selectedAutomation, setSelectedAutomation] = useState<AutomationSummary | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [executors, setExecutors] = useState<readonly MissionExecutorOption[]>([]);
  const [executorCatalogLoaded, setExecutorCatalogLoaded] = useState(false);
  const [missionDefaults, setMissionDefaults] = useState<MissionCreationDefaults>();
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [touchedFields, setTouchedFields] = useState<ReadonlySet<AutomationField>>(new Set());
  const [submitAttempted, setSubmitAttempted] = useState(false);

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
      })
      .finally(() => {
        if (!cancelled) setExecutorCatalogLoaded(true);
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
    setEditor(createNewAutomationEditor(allocated?.id ?? "", defaults));
    setPreview([]);
    setError(null);
    setTouchedFields(new Set());
    setSubmitAttempted(false);
  };

  const closeEditor = () => {
    setEditor(null);
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
      { readonly startsAt?: string; readonly endsAt?: string } | undefined;
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
      onceAt: localDateTime(new Date(value["at"] === undefined ? Date.now() : String(value["at"]))),
      intervalEvery: Number(value["every"] ?? 1),
      intervalUnit: (value["unit"] as EditorState["intervalUnit"]) ?? "hours",
      anchorAt: localDateTime(
        new Date(value["anchorAt"] === undefined ? Date.now() : String(value["anchorAt"])),
      ),
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
    setTouchedFields(new Set());
    setSubmitAttempted(false);
  };

  const save = async () => {
    if (editor === null) return;
    setError(null);
    const validation = validateAutomationEditor(editor, selectedExecutor);
    setSubmitAttempted(true);
    if (!validation.valid) {
      requestAnimationFrame(() => focusFirstAutomationError(validation));
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
      const saved = await api.saveAutomation({
        expectedProjectRevision: props.project.revision,
        resource: {
          apiVersion: "pragma/v5",
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
      setSelectedAutomation(saved);
      await props.onChanged();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const markTouched = (field: AutomationField) => {
    setTouchedFields((current) => new Set([...current, field]));
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
        markTouched("workspace");
        setError(null);
      } else if (result.reason !== "cancelled") {
        setError(result.error ?? tMissions("workspaceUnavailable"));
      }
    } catch (pickError) {
      setError(errorMessage(pickError));
    }
  };

  const deleteAutomation = async (automation: AutomationSummary) => {
    const api = desktopApi();
    if (api === undefined) throw new Error("Desktop bridge is unavailable.");
    await api.deleteAutomation({
      expectedProjectRevision: props.project.revision,
      ref: automation.ref,
    });
    setSelectedAutomation(null);
    await props.onChanged();
  };

  const triggerAutomation = async (automation: AutomationSummary) => {
    const api = desktopApi();
    if (api === undefined) throw new Error("Desktop bridge is unavailable.");
    const triggered = await api.triggerAutomation(automation.ref);
    setSelectedAutomation(triggered);
    await props.onChanged();
  };

  if (editor !== null) {
    const knownWorkspaces =
      missionDefaults === undefined
        ? []
        : [missionDefaults.workspace, ...missionDefaults.recentWorkspaces];
    const selectedWorkspace = workspaceSelectionFromPath(editor.workspace, knownWorkspaces);
    const validation = validateAutomationEditor(editor, selectedExecutor);
    const showError = (field: AutomationField) => submitAttempted || touchedFields.has(field);
    return (
      <>
        <StudioScreenFrame
          className="automation-editor"
          labelledBy="automation-editor-heading"
          header={
            <header className="automation-editor-heading">
              <button className="back-link" type="button" onClick={closeEditor}>
                <ArrowLeft size={17} aria-hidden="true" />
                {editor.originalRef === undefined
                  ? t("backIntegrations")
                  : t("backAutomationDetail")}
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
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="automation-form-content">
              <section className="automation-form-section">
                <h2>{t("automationIdentity")}</h2>
                <div className="automation-field-grid is-identity">
                  <label>
                    <span>{t("name")}</span>
                    <input
                      maxLength={PRAGMA_TEXT_LIMITS.automation.name * 2}
                      value={editor.name}
                      data-automation-field="name"
                      aria-invalid={showError("name") && validation.name !== undefined}
                      aria-describedby="automation-name-feedback"
                      onBlur={() => markTouched("name")}
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          name: truncatePragmaTrimmedUnicode(
                            event.target.value,
                            PRAGMA_TEXT_LIMITS.automation.name,
                          ),
                        })
                      }
                    />
                    <FieldFeedback
                      id="automation-name-feedback"
                      value={editor.name}
                      max={PRAGMA_TEXT_LIMITS.automation.name}
                      error={showError("name") ? validation.name : undefined}
                    />
                  </label>
                  <label>
                    <span>{t("description")}</span>
                    <input
                      maxLength={PRAGMA_TEXT_LIMITS.automation.description * 2}
                      value={editor.description}
                      data-automation-field="description"
                      aria-invalid={
                        showError("description") && validation.description !== undefined
                      }
                      aria-describedby="automation-description-feedback"
                      onBlur={() => markTouched("description")}
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          description: truncatePragmaTrimmedUnicode(
                            event.target.value,
                            PRAGMA_TEXT_LIMITS.automation.description,
                          ),
                        })
                      }
                    />
                    <FieldFeedback
                      id="automation-description-feedback"
                      value={editor.description}
                      max={PRAGMA_TEXT_LIMITS.automation.description}
                      error={showError("description") ? validation.description : undefined}
                    />
                  </label>
                </div>
              </section>

              <section className="automation-form-section">
                <h2>{t("automationTarget")}</h2>
                <div
                  className={
                    flow
                      ? "automation-field-grid is-target has-flow"
                      : "automation-field-grid is-target"
                  }
                >
                  <div className="automation-select-field automation-executor-field">
                    <span>{t("executor")}</span>
                    <MissionExecutorPicker
                      executors={executors}
                      value={editor.executorRef}
                      invalid={showError("executor") && validation.executor !== undefined}
                      describedBy="automation-executor-feedback"
                      onTouched={() => markTouched("executor")}
                      onChange={(executorRef) => {
                        const next = executors.find((executor) => executor.ref === executorRef);
                        setEditor({
                          ...editor,
                          executorRef,
                          prompt: "",
                          flowInput:
                            next?.kind === "flow" && next.inputSchema !== undefined
                              ? createSchemaInputValue(next.inputSchema)
                              : {},
                        });
                      }}
                    />
                    {showError("executor") && validation.executor !== undefined ? (
                      <p
                        className="automation-field-error"
                        id="automation-executor-feedback"
                        role="alert"
                      >
                        {t("fieldRequired")}
                      </p>
                    ) : null}
                  </div>
                  {selectedExecutor !== undefined && !flow ? (
                    <div className="automation-select-field">
                      <span>{t("sessionPolicy")}</span>
                      <SelectMenu<EditorState["interaction"]>
                        ariaLabel={t("sessionPolicy")}
                        className="form-select"
                        value={editor.interaction}
                        options={[
                          { value: "reuse-session", label: t("reuseMission") },
                          { value: "new-mission", label: t("newMissionEveryRun") },
                        ]}
                        onChange={(interaction) => setEditor({ ...editor, interaction })}
                      />
                    </div>
                  ) : null}
                </div>
                {selectedExecutor === undefined ? (
                  <p className="automation-target-empty">{t("selectExecutorFirst")}</p>
                ) : flowInputSchema !== undefined ? (
                  <div data-automation-field="flowInput">
                    <SchemaInputForm
                      className="automation-flow-input-form"
                      schema={flowInputSchema}
                      value={editor.flowInput}
                      disabled={saving}
                      onChange={(flowInput) => {
                        markTouched("flowInput");
                        setEditor({ ...editor, flowInput });
                      }}
                    />
                  </div>
                ) : (
                  <label>
                    <span>{t("prompt")}</span>
                    <textarea
                      rows={5}
                      maxLength={PRAGMA_TEXT_LIMITS.automation.promptAuthoring * 2}
                      value={editor.prompt}
                      data-automation-field="prompt"
                      aria-invalid={showError("prompt") && validation.prompt !== undefined}
                      aria-describedby="automation-prompt-feedback"
                      onBlur={() => markTouched("prompt")}
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          prompt: truncatePragmaTrimmedUnicode(
                            event.target.value,
                            PRAGMA_TEXT_LIMITS.automation.promptAuthoring,
                          ),
                        })
                      }
                    />
                    <FieldFeedback
                      id="automation-prompt-feedback"
                      value={editor.prompt}
                      max={PRAGMA_TEXT_LIMITS.automation.promptAuthoring}
                      error={showError("prompt") ? validation.prompt : undefined}
                    />
                  </label>
                )}
                {showError("flowInput") && validation.flowInput !== undefined ? (
                  <p
                    className="automation-field-error"
                    id="automation-flow-input-feedback"
                    role="alert"
                  >
                    {t("flowInputInvalid")}
                  </p>
                ) : null}
              </section>

              <section className="automation-form-section" data-automation-field="trigger">
                <h2>{t("schedulePolicy")}</h2>
                <div className="automation-field-grid is-schedule">
                  <div className="automation-select-field">
                    <span>{t("triggerType")}</span>
                    <SelectMenu<EditorState["triggerKind"]>
                      ariaLabel={t("triggerType")}
                      className="form-select"
                      value={editor.triggerKind}
                      options={[
                        { value: "once", label: t("scheduleOnce") },
                        { value: "interval", label: t("scheduleInterval") },
                        { value: "calendar", label: t("scheduleCalendar") },
                        { value: "cron", label: "Cron" },
                      ]}
                      onChange={(triggerKind) => {
                        markTouched("trigger");
                        setEditor({ ...editor, triggerKind });
                      }}
                    />
                  </div>
                  {editor.triggerKind === "once" ? (
                    <DateTimeField
                      label={t("runAt")}
                      value={editor.onceAt}
                      onTouched={() => markTouched("trigger")}
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
                          onBlur={() => markTouched("trigger")}
                          onChange={(event) =>
                            setEditor({ ...editor, intervalEvery: Number(event.target.value) })
                          }
                        />
                      </label>
                      <div className="automation-select-field">
                        <span>{t("unit")}</span>
                        <SelectMenu<EditorState["intervalUnit"]>
                          ariaLabel={t("unit")}
                          className="form-select"
                          value={editor.intervalUnit}
                          options={(["minutes", "hours", "days", "weeks"] as const).map((unit) => ({
                            value: unit,
                            label: t(`scheduleUnit.${unit}`),
                          }))}
                          onChange={(intervalUnit) => {
                            markTouched("trigger");
                            setEditor({ ...editor, intervalUnit });
                          }}
                        />
                      </div>
                      <DateTimeField
                        label={t("anchorAt")}
                        value={editor.anchorAt}
                        onTouched={() => markTouched("trigger")}
                        onChange={(anchorAt) => setEditor({ ...editor, anchorAt })}
                      />
                    </>
                  ) : null}
                  {editor.triggerKind === "calendar" ? (
                    <>
                      <div className="automation-select-field">
                        <span>{t("frequency")}</span>
                        <SelectMenu<EditorState["frequency"]>
                          ariaLabel={t("frequency")}
                          className="form-select"
                          value={editor.frequency}
                          options={(["daily", "weekdays", "weekly", "monthly"] as const).map(
                            (frequency) => ({
                              value: frequency,
                              label: t(`scheduleFrequency.${frequency}`),
                            }),
                          )}
                          onChange={(frequency) => {
                            markTouched("trigger");
                            setEditor({ ...editor, frequency });
                          }}
                        />
                      </div>
                      <div className="automation-select-field">
                        <span>{t("time")}</span>
                        <DateTimePicker
                          mode="time"
                          label={t("time")}
                          value={editor.time}
                          onTouched={() => markTouched("trigger")}
                          onChange={(time) => setEditor({ ...editor, time })}
                        />
                      </div>
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
                            onBlur={() => markTouched("trigger")}
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
                        onBlur={() => markTouched("trigger")}
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
                        onTouched={() => markTouched("trigger")}
                        onChange={(startsAt) => setEditor({ ...editor, startsAt })}
                      />
                      <DateTimeField
                        optional
                        label={t("activeUntil")}
                        value={editor.endsAt}
                        onTouched={() => markTouched("trigger")}
                        onChange={(endsAt) => setEditor({ ...editor, endsAt })}
                      />
                    </>
                  ) : null}
                </div>
                {showError("trigger") && validation.trigger !== undefined ? (
                  <p className="automation-field-error" role="alert">
                    {t("scheduleInvalid")}
                  </p>
                ) : null}
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void showPreview()}
                >
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

              <section className="automation-form-section is-environment">
                <h2>{t("executionEnvironment")}</h2>
                <div className="automation-field-grid is-environment">
                  <div className="automation-workspace-field" data-automation-field="workspace">
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
                      onSelect={(workspace) => {
                        markTouched("workspace");
                        setEditor({ ...editor, workspace: workspace.path });
                      }}
                      onUseDefault={() => {
                        if (missionDefaults !== undefined) {
                          markTouched("workspace");
                          setEditor({ ...editor, workspace: missionDefaults.workspace.path });
                        }
                      }}
                    />
                    {showError("workspace") && validation.workspace !== undefined ? (
                      <p className="automation-field-error" role="alert">
                        {t("workspaceRequired")}
                      </p>
                    ) : null}
                  </div>
                  <div className="automation-select-field">
                    <span>{t("toolPermissions")}</span>
                    <ToolPermissionSelect
                      className="form-select automation-permission-select"
                      value={editor.toolPermissionMode}
                      onChange={(toolPermissionMode) =>
                        setEditor({ ...editor, toolPermissionMode })
                      }
                    />
                  </div>
                </div>
                <div className="automation-switch">
                  <Switch
                    checked={editor.enabled}
                    ariaLabel={t("enableAutomation")}
                    onChange={(enabled) => setEditor({ ...editor, enabled })}
                  />
                  <span>{t("enableAutomation")}</span>
                </div>
              </section>
              {error ? (
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
            <footer className="automation-form-actions">
              <button className="secondary-button" type="button" onClick={closeEditor}>
                {t("cancel")}
              </button>
              <button className="primary-button" type="submit" disabled={saving}>
                {saving ? t("saving") : t("saveAutomation")}
              </button>
            </footer>
          </form>
        </StudioScreenFrame>
      </>
    );
  }

  const currentAutomation =
    selectedAutomation === null
      ? null
      : (props.automations.find((automation) => automation.ref === selectedAutomation.ref) ??
        selectedAutomation);

  if (currentAutomation !== null) {
    return (
      <AutomationDetailFragment
        automation={currentAutomation}
        executors={executors}
        onBack={() => {
          setSelectedAutomation(null);
          setError(null);
        }}
        onEdit={() => openExisting(currentAutomation)}
        onRun={async () => await triggerAutomation(currentAutomation)}
        onDelete={async () => await deleteAutomation(currentAutomation)}
      />
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
                onClick={() => setSelectedAutomation(automation)}
              >
                <span className="studio-asset-icon">
                  <Clock size={22} aria-hidden="true" />
                </span>
                <span className="studio-asset-copy">
                  <strong>{automation.resource.metadata.name}</strong>
                  <span>
                    {resolveAutomationExecutorName(
                      automation.resource.spec.route.executor.ref,
                      executors,
                    ) ??
                      (executorCatalogLoaded
                        ? t("automationExecutorUnavailable")
                        : tCommon("actions.loading"))}{" "}
                    · {t(`automationStatus.${automation.status}`)}
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

export function resolveAutomationExecutorName(
  executorRef: string,
  executors: readonly MissionExecutorOption[],
): string | undefined {
  return executors.find((executor) => executor.ref === executorRef)?.name;
}

type FieldValidationError = "required" | "tooLong";

type AutomationValidation = {
  readonly valid: boolean;
  readonly name?: FieldValidationError | undefined;
  readonly description?: FieldValidationError | undefined;
  readonly executor?: "required" | undefined;
  readonly prompt?: FieldValidationError | undefined;
  readonly flowInput?: "invalid" | undefined;
  readonly trigger?: "invalid" | undefined;
  readonly workspace?: "required" | undefined;
};

function FieldFeedback(props: {
  readonly id: string;
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
    <small
      className={error === undefined ? "automation-field-meta" : "automation-field-error"}
      id={props.id}
    >
      <span>{error}</span>
      <span>
        {pragmaUnicodeLength(props.value.trim())}/{props.max}
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
  readonly onTouched?: (() => void) | undefined;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="automation-select-field">
      <span>{props.label}</span>
      <DateTimePicker
        label={props.label}
        value={props.value}
        optional={props.optional}
        onTouched={props.onTouched}
        onChange={props.onChange}
      />
    </div>
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
): AutomationValidation {
  const name = validateText(editor.name, PRAGMA_TEXT_LIMITS.automation.name);
  const description = validateText(editor.description, PRAGMA_TEXT_LIMITS.automation.description);
  const executorError = executor === undefined ? ("required" as const) : undefined;
  const inputSchema = executor?.kind === "flow" ? executor.inputSchema : undefined;
  const prompt =
    executor === undefined || inputSchema !== undefined
      ? undefined
      : validateText(editor.prompt, PRAGMA_TEXT_LIMITS.automation.promptAuthoring);
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
  const workspace = editor.workspace === "" ? ("required" as const) : undefined;
  const valid =
    name === undefined &&
    description === undefined &&
    executorError === undefined &&
    prompt === undefined &&
    flowInput === undefined &&
    trigger === undefined &&
    workspace === undefined;
  return {
    valid,
    name,
    description,
    executor: executorError,
    prompt,
    flowInput,
    trigger,
    workspace,
  };
}

function focusFirstAutomationError(validation: AutomationValidation): void {
  const fields: readonly (keyof AutomationValidation)[] = [
    "name",
    "description",
    "executor",
    "prompt",
    "flowInput",
    "trigger",
    "workspace",
  ];
  const field = fields.find((candidate) => validation[candidate] !== undefined);
  if (field === undefined) return;
  const root = document.querySelector<HTMLElement>(`[data-automation-field="${field}"]`);
  const target = root?.matches("button, input, textarea, [tabindex]")
    ? root
    : root?.querySelector<HTMLElement>("button, input, textarea, [tabindex]");
  target?.focus();
}

function validateText(value: string, max: number): FieldValidationError | undefined {
  if (value.trim() === "") return "required";
  if (pragmaUnicodeLength(value.trim()) > max) return "tooLong";
  return undefined;
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
