import { ArrowLeft, Clock, Plus, Robot, Trash } from "@phosphor-icons/react";
import { PragmaScheduleTriggerSchema } from "@pragma/interpreter/ast";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  AutomationSummary,
  DesktopToolPermissionMode,
  MissionExecutorOption,
  PragmaProjectSnapshot,
} from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

type EditorState = {
  readonly originalRef?: string | undefined;
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly executorRef: string;
  readonly input: string;
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
  readonly timezone: string;
  readonly weekdays: string;
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
  const [tab, setTab] = useState<"automations" | "connections">("automations");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [executors, setExecutors] = useState<readonly MissionExecutorOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) return;
    let cancelled = false;
    void api
      .listMissionExecutors()
      .then((items) => {
        if (!cancelled) setExecutors(items);
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

  const openNew = async () => {
    const api = desktopApi();
    const defaults = await api?.getMissionCreationDefaults();
    const executor = executors[0];
    const timestamp = localDateTime(new Date(Date.now() + 60 * 60_000));
    setEditor({
      id: "",
      version: "0.1.0",
      name: "",
      description: "",
      enabled: true,
      executorRef: executor?.ref ?? "",
      input: executor?.kind === "flow" ? "{}" : "",
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
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      weekdays: "mon,tue,wed,thu,fri",
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
    const window = value["window"] as
      | { readonly startsAt?: string; readonly endsAt?: string }
      | undefined;
    setEditor({
      originalRef: automation.ref,
      id: automation.resource.metadata.id,
      version: automation.resource.metadata.version,
      name: automation.resource.metadata.name,
      description: automation.resource.metadata.description,
      enabled: automation.resource.spec.enabled,
      executorRef: automation.resource.spec.route.executor.ref,
      input:
        automation.resource.spec.route.input.kind === "prompt"
          ? automation.resource.spec.route.input.value
          : JSON.stringify(automation.resource.spec.route.input.value, undefined, 2),
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
      timezone: String(value["timezone"] ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
      weekdays: Array.isArray(value["weekdays"])
        ? value["weekdays"].join(",")
        : "mon,tue,wed,thu,fri",
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
    const api = desktopApi();
    if (api === undefined) return;
    setSaving(true);
    setError(null);
    try {
      const routeInput = flow
        ? { kind: "flow" as const, value: JSON.parse(editor.input) as Record<string, unknown> }
        : { kind: "prompt" as const, value: editor.input };
      await api.saveAutomation({
        expectedProjectRevision: props.project.revision,
        resource: {
          apiVersion: "pragma/v2",
          kind: "Automation",
          metadata: {
            id: editor.id,
            version: editor.version,
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

  if (editor !== null) {
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
                <span>{t("resourceId")}</span>
                <input
                  required
                  pattern="[A-Za-z0-9][A-Za-z0-9_]*"
                  disabled={editor.originalRef !== undefined}
                  value={editor.id}
                  onChange={(event) => setEditor({ ...editor, id: event.target.value })}
                />
              </label>
              <label>
                <span>{t("version")}</span>
                <input
                  required
                  disabled={editor.originalRef !== undefined}
                  value={editor.version}
                  onChange={(event) => setEditor({ ...editor, version: event.target.value })}
                />
              </label>
              <label>
                <span>{t("name")}</span>
                <input
                  required
                  value={editor.name}
                  onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                />
              </label>
              <label>
                <span>{t("description")}</span>
                <input
                  value={editor.description}
                  onChange={(event) => setEditor({ ...editor, description: event.target.value })}
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
                      input: next?.kind === "flow" ? "{}" : editor.input,
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
              <label>
                <span>{t("sessionPolicy")}</span>
                <select
                  value={flow ? "new-mission" : editor.interaction}
                  disabled={flow}
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
                {flow ? <small>{t("flowForcesNewMission")}</small> : null}
              </label>
            </div>
            <label>
              <span>{flow ? t("flowInput") : t("prompt")}</span>
              <textarea
                required
                rows={5}
                value={editor.input}
                onChange={(event) => setEditor({ ...editor, input: event.target.value })}
              />
            </label>
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
                      onChange={(event) => setEditor({ ...editor, time: event.target.value })}
                    />
                  </label>
                  {editor.frequency === "weekly" ? (
                    <label>
                      <span>{t("weekdays")}</span>
                      <input
                        value={editor.weekdays}
                        onChange={(event) => setEditor({ ...editor, weekdays: event.target.value })}
                        placeholder="mon,tue,fri"
                      />
                    </label>
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
              {editor.triggerKind === "calendar" || editor.triggerKind === "cron" ? (
                <label>
                  <span>{t("timezone")}</span>
                  <input
                    value={editor.timezone}
                    onChange={(event) => setEditor({ ...editor, timezone: event.target.value })}
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
              <label>
                <span>{t("workspace")}</span>
                <input
                  required
                  value={editor.workspace}
                  onChange={(event) => setEditor({ ...editor, workspace: event.target.value })}
                />
              </label>
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
            <button className="primary-button" type="submit" disabled={saving}>
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
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

export function scheduleTrigger(editor: EditorState) {
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
        timezone: editor.timezone,
        ...(editor.frequency === "weekly"
          ? {
              weekdays: editor.weekdays
                .split(",")
                .map((value) => value.trim().toLowerCase())
                .filter(Boolean),
            }
          : {}),
        ...(editor.frequency === "monthly" ? { dayOfMonth: editor.dayOfMonth } : {}),
        ...(window === undefined ? {} : { window }),
      };
      break;
    case "cron":
      trigger = {
        kind: "cron",
        expression: editor.cron,
        timezone: editor.timezone,
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

function toIso(value: string): string {
  return new Date(value).toISOString();
}

function localDateTime(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}
