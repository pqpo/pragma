import {
  ArrowLeft,
  ArrowsClockwise,
  Archive,
  Code,
  DownloadSimple,
  FloppyDisk,
  SpinnerGap,
  GitBranch,
  GearSix,
  Globe,
  PaperPlaneTilt,
  Play,
  Plug,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Capability, CapabilityTestResult } from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { CharacterCount } from "../../components/CharacterCount.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { SkillFileWorkspace, type SkillSaveAction } from "./SkillFileWorkspace.tsx";
import { StudioDetailActions } from "../../components/StudioDetailActions.tsx";
import { StudioActionButton } from "../../components/StudioActionButton.tsx";
import { StudioConfirmationDialog } from "./StudioDialog.tsx";
import { StudioScreenFrame, type StudioLeaveGuard } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";
import { AssetGitPanel } from "./AssetGitControls.tsx";

export function CapabilityDetailFragment(props: {
  readonly capability: Capability;
  readonly onBack: () => void;
  readonly onChanged: (capability: Capability) => void;
  readonly onOpenRevisions?: (() => void) | undefined;
  readonly onOpenMission?: ((missionId: string, composerDraft?: string) => void) | undefined;
  readonly onDeleted?: (capabilityId: string) => void;
  readonly onExport?: (() => Promise<void>) | undefined;
  readonly onPublish?: (() => Promise<void>) | undefined;
  readonly onLeaveGuardChange?: ((guard: StudioLeaveGuard | null) => void) | undefined;
  readonly openGitSettingsRequest?: number | undefined;
}) {
  const { t } = useTranslation("studio");
  const { capability } = props;
  const isBuiltIn = capability.managedBy === "system";
  const definition = capability.definition;
  const leaveGuardRef = useRef<StudioLeaveGuard | null>(null);
  const onSkillLeaveGuardChange = useCallback(
    (guard: StudioLeaveGuard | null) => {
      leaveGuardRef.current = guard;
      props.onLeaveGuardChange?.(guard);
    },
    [props.onLeaveGuardChange],
  );
  const requestLeave = (action: () => void) => {
    if (leaveGuardRef.current === null) action();
    else leaveGuardRef.current(action);
  };
  const [skillSaveAction, setSkillSaveAction] = useState<SkillSaveAction | null>(null);
  const [selectedToolName, setSelectedToolName] = useState(() => firstToolName(capability));
  const [testInput, setTestInput] = useState("{}");
  const [testResult, setTestResult] = useState<CapabilityTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revisionDialogOpen, setRevisionDialogOpen] = useState(false);
  const [revisionPrompt, setRevisionPrompt] = useState("");
  const [revisionSubmitting, setRevisionSubmitting] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [gitSettingsOpen, setGitSettingsOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const tools = useMemo(() => capabilityTools(capability), [capability]);

  useEffect(() => {
    if (props.openGitSettingsRequest !== undefined) setGitSettingsOpen(true);
  }, [props.openGitSettingsRequest]);

  useEffect(() => {
    if (tools.some((tool) => tool.name === selectedToolName)) return;
    setSelectedToolName(tools[0]?.name ?? "");
    setTestInput("{}");
    setTestResult(null);
  }, [selectedToolName, tools]);

  const selectTool = (name: string) => {
    setSelectedToolName(name);
    setTestInput("{}");
    setTestResult(null);
    setError(null);
  };

  const runTest = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const input = parseTestInput(testInput);
      const result = await api.testCapability({
        id: capability.manifest.id,
        expectedRevision: capability.manifest.latestRevision,
        ...(definition.kind === "mcp_server" || definition.kind === "http_service"
          ? { toolName: selectedToolName }
          : {}),
        input,
      });
      setTestResult(result);
      props.onChanged(result.capability);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const refreshMcp = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    setBusy(true);
    setError(null);
    try {
      props.onChanged(
        await api.retryCapability({
          id: capability.manifest.id,
          expectedRevision: capability.manifest.latestRevision,
        }),
      );
      setTestResult(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const submitSkillRevision = async () => {
    const api = desktopApi();
    if (api === undefined || revisionPrompt.trim() === "") return;
    setRevisionSubmitting(true);
    setRevisionError(null);
    try {
      const created = await api.submitSkillRevision({
        capabilityId: capability.manifest.id,
        prompt: revisionPrompt.trim(),
      });
      setRevisionDialogOpen(false);
      setRevisionPrompt("");
      if (created.missionId !== undefined && props.onOpenMission !== undefined)
        props.onOpenMission(created.missionId);
      else props.onOpenRevisions?.();
    } catch (cause) {
      setRevisionError(errorMessage(cause));
    } finally {
      setRevisionSubmitting(false);
    }
  };

  const importSkillRevision = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const selected = await api.pickSkillSource();
      if (!selected.ok) {
        if (selected.reason !== "cancelled")
          throw new Error(selected.error ?? "Skill source unavailable.");
        return;
      }
      await api.importSkillRevision({
        capabilityId: capability.manifest.id,
        sourcePath: selected.path as string,
      });
      props.onOpenRevisions?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const deleteSkill = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await api.deleteCapability(capability.manifest.id);
      if (!result.ok) {
        setDeleteError(
          result.code === "capability_referenced"
            ? t("capabilityDeleteReferenced")
            : t("capabilityDeleteFailed"),
        );
        return;
      }
      setDeleteDialogOpen(false);
      setDeleteError(null);
      props.onDeleted?.(capability.manifest.id);
    } catch (cause) {
      setDeleteError(errorMessage(cause));
    } finally {
      setDeleting(false);
    }
  };

  const runTransferAction = async (action: (() => Promise<void>) | undefined) => {
    if (action === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectedTool = tools.find((tool) => tool.name === selectedToolName);
  const Icon = capabilityIcon(capability);

  return (
    <StudioScreenFrame
      className={
        definition.kind === "skill" ? "capability-detail" : "capability-detail has-tool-workspace"
      }
      labelledBy="capability-detail-name"
      header={
        <button className="back-link" type="button" onClick={() => requestLeave(props.onBack)}>
          <ArrowLeft size={18} aria-hidden="true" />
          {t("backCapabilities")}
        </button>
      }
    >
      <div className="capability-detail-overview">
        <header className="capability-detail-header">
          <span className="expert-avatar" aria-hidden="true">
            <Icon size={40} />
          </span>
          <div className="capability-detail-title">
            <div>
              <span className="capability-detail-name-row">
                <h1 id="capability-detail-name" title={capability.manifest.name}>
                  {capability.manifest.name}
                </h1>
                {isBuiltIn ? (
                  <span className="capability-built-in-chip">{t("builtIn")}</span>
                ) : null}
              </span>
              <span className="capability-type">{capabilityTypeLabel(capability)}</span>
              <span className="version-label">Revision {capability.manifest.latestRevision}</span>
            </div>
            <p>{definition.description}</p>
          </div>
          {isBuiltIn ? null : definition.kind === "skill" ? (
            <div className="capability-detail-actions">
              <StudioDetailActions
                primary={
                  <>
                    <StudioActionButton
                      label={skillSaveAction?.saving ? t("saving") : t("saveSkill")}
                      tone="primary"
                      disabled={!skillSaveAction?.dirty || skillSaveAction.saving}
                      busy={skillSaveAction?.saving}
                      icon={
                        skillSaveAction?.saving ? (
                          <SpinnerGap className="spin" size={18} aria-hidden="true" />
                        ) : (
                          <FloppyDisk size={18} aria-hidden="true" />
                        )
                      }
                      onClick={() => void skillSaveAction?.save()}
                    />
                    {props.onPublish === undefined ? null : (
                      <StudioActionButton
                        label={t("publishToSource")}
                        icon={<GitBranch size={18} aria-hidden="true" />}
                        disabled={busy || deleting}
                        onClick={() => requestLeave(() => void runTransferAction(props.onPublish))}
                      />
                    )}
                  </>
                }
              >
                <StudioActionButton
                  label={t("submitSkillRevision")}
                  icon={<PaperPlaneTilt size={18} aria-hidden="true" />}
                  onClick={() => {
                    requestLeave(() => {
                      setRevisionError(null);
                      setRevisionDialogOpen(true);
                    });
                  }}
                />
                {props.onExport === undefined ? null : (
                  <StudioActionButton
                    label={t("exportBundle")}
                    icon={<DownloadSimple size={18} aria-hidden="true" />}
                    disabled={busy || deleting}
                    onClick={() => void runTransferAction(props.onExport)}
                  />
                )}

                <StudioActionButton
                  label={t("updateSkillFromPackage")}
                  icon={<Archive size={18} aria-hidden="true" />}
                  disabled={busy || deleting}
                  onClick={() => requestLeave(() => void importSkillRevision())}
                />

                <StudioActionButton
                  label={t("assetGit.settings")}
                  icon={<GearSix size={18} aria-hidden="true" />}
                  disabled={busy || deleting}
                  onClick={() => requestLeave(() => setGitSettingsOpen(true))}
                />
                <StudioActionButton
                  label={t("delete")}
                  icon={<Trash size={18} aria-hidden="true" />}
                  tone="danger"
                  disabled={busy || deleting}
                  onClick={() => {
                    requestLeave(() => {
                      setDeleteError(null);
                      setDeleteDialogOpen(true);
                    });
                  }}
                />
              </StudioDetailActions>
            </div>
          ) : definition.kind === "mcp_server" ? (
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => void refreshMcp()}
            >
              <ArrowsClockwise size={17} /> {busy ? t("refreshing") : t("refreshTools")}
            </button>
          ) : null}
        </header>

        {capability.health.diagnostic ? (
          <p className="capability-diagnostic" role="status">
            <strong>{capability.health.diagnostic.code}</strong>
            {capability.health.diagnostic.message}
          </p>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {definition.kind === "skill" ? (
        <SkillFileWorkspace
          key={capability.manifest.id}
          capability={capability}
          onChanged={props.onChanged}
          onLeaveGuardChange={onSkillLeaveGuardChange}
          onSaveActionChange={setSkillSaveAction}
        />
      ) : (
        <section className="capability-tool-workspace" aria-label={t("capabilityToolsPanel")}>
          <div className="capability-tool-detail">
            {selectedTool ? (
              <>
                <ToolDefinition capability={capability} toolName={selectedTool.name} />
                <section
                  className="capability-test-panel"
                  aria-labelledby="capability-test-heading"
                >
                  <header>
                    <div>
                      <h2 id="capability-test-heading">{t("testTool")}</h2>
                      <p>{t("callJson")}</p>
                    </div>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={busy || selectedToolName.length === 0}
                      onClick={() => void runTest()}
                    >
                      <Play size={16} /> {busy ? t("running") : t("runTest")}
                    </button>
                  </header>
                  <label>
                    {t("jsonInput")}
                    <textarea
                      className="capability-test-input"
                      spellCheck={false}
                      value={testInput}
                      onChange={(event) => setTestInput(event.target.value)}
                    />
                  </label>
                  {testResult ? <TestResult result={testResult} /> : null}
                </section>
              </>
            ) : (
              <p className="capability-empty">{t("selectTool")}</p>
            )}
          </div>
          <aside className="capability-tool-list">
            <header>
              <h2>{t("tools")}</h2>
              <span>{tools.length}</span>
            </header>
            <div className="capability-tool-list-scroll">
              {tools.map((tool) => (
                <button
                  key={tool.name}
                  className={tool.name === selectedToolName ? "is-active" : ""}
                  type="button"
                  aria-pressed={tool.name === selectedToolName}
                  onClick={() => selectTool(tool.name)}
                >
                  <strong>{tool.name}</strong>
                  <small>{tool.summary}</small>
                </button>
              ))}
              {tools.length === 0 ? <p>{t("noTools")}</p> : null}
            </div>
          </aside>
        </section>
      )}
      {revisionDialogOpen ? (
        <Dialog
          title={t("submitSkillRevision")}
          description={t("submitSkillRevisionDescription", {
            name: capability.manifest.name,
          })}
          busy={revisionSubmitting}
          className="knowledge-revision-dialog"
          onCancel={() => {
            setRevisionDialogOpen(false);
            setRevisionError(null);
          }}
          footer={
            <>
              <button
                className="secondary-button"
                type="button"
                disabled={revisionSubmitting}
                onClick={() => setRevisionDialogOpen(false)}
              >
                {t("cancel")}
              </button>
              <button
                className="primary-button"
                type="submit"
                form="skill-revision-form"
                disabled={revisionSubmitting || revisionPrompt.trim() === ""}
              >
                {revisionSubmitting ? t("submittingRevision") : t("submitSkillRevision")}
              </button>
            </>
          }
        >
          <form
            id="skill-revision-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitSkillRevision();
            }}
          >
            <label>
              <span>{t("revisionPrompt")}</span>
              <textarea
                data-dialog-initial-focus
                value={revisionPrompt}
                maxLength={50_000}
                disabled={revisionSubmitting}
                placeholder={t("revisionPromptPlaceholder")}
                onChange={(event) => setRevisionPrompt(event.target.value)}
              />
            </label>
            <div className="knowledge-revision-dialog-meta">
              <small>{t("revisionPromptHint")}</small>
              <CharacterCount value={revisionPrompt} max={50_000} trim={false} />
            </div>
            {revisionError !== null ? (
              <p className="form-error" role="alert">
                {revisionError}
              </p>
            ) : null}
          </form>
        </Dialog>
      ) : null}
      {gitSettingsOpen && definition.kind === "skill" && !isBuiltIn ? (
        <Dialog
          title={t("skillSettings")}
          description={t("assetGit.description")}
          className="asset-git-dialog"
          onCancel={() => setGitSettingsOpen(false)}
          headerAction={
            <button
              className="icon-button is-borderless"
              type="button"
              aria-label={t("close")}
              title={t("close")}
              onClick={() => setGitSettingsOpen(false)}
            >
              <X size={20} aria-hidden="true" />
            </button>
          }
        >
          <AssetGitPanel
            target={{ kind: "skill", id: capability.manifest.id }}
            showHeading={false}
            onSynced={async () => {
              const api = desktopApi();
              if (api) props.onChanged(await api.getCapability(capability.manifest.id));
            }}
          />
        </Dialog>
      ) : null}
      {deleteDialogOpen ? (
        <StudioConfirmationDialog
          title={t("deleteCapability")}
          description={t("deleteCapabilityDescription", { name: capability.manifest.name })}
          error={deleteError}
          cancelLabel={t("cancel")}
          confirmLabel={t("deleteCapabilityAction")}
          busyLabel={t("deleting")}
          busy={deleting}
          onCancel={() => {
            setDeleteError(null);
            setDeleteDialogOpen(false);
          }}
          onConfirm={() => void deleteSkill()}
        />
      ) : null}
    </StudioScreenFrame>
  );
}

type ToolSummary = { readonly name: string; readonly summary: string };

function capabilityTools(capability: Capability): readonly ToolSummary[] {
  const definition = capability.definition;
  if (definition.kind === "skill") return [];
  if (definition.kind === "code_service") {
    return [{ name: definition.tool.name, summary: definition.tool.description }];
  }
  return definition.tools.map((tool) => ({
    name: tool.name,
    summary: tool.description ?? "No description provided.",
  }));
}

function firstToolName(capability: Capability): string {
  return capabilityTools(capability)[0]?.name ?? "";
}

function ToolDefinition(props: { readonly capability: Capability; readonly toolName: string }) {
  const definition = props.capability.definition;
  if (definition.kind === "skill") return null;
  if (definition.kind === "code_service") {
    return (
      <section className="tool-definition">
        <h2>{definition.tool.name}</h2>
        <p>{definition.tool.description}</p>
        <SchemaBlock label="Input schema" value={definition.tool.inputSchema} />
        <SchemaBlock label="Output schema" value={definition.tool.outputSchema} />
        <SchemaBlock label="JavaScript source" value={definition.tool.source} source />
      </section>
    );
  }
  if (definition.kind === "mcp_server") {
    const tool = definition.tools.find((candidate) => candidate.name === props.toolName);
    if (!tool) return null;
    return (
      <section className="tool-definition">
        <h2>{tool.name}</h2>
        <p>{tool.description ?? "No description provided."}</p>
        <SchemaBlock label="Input schema" value={tool.inputSchema ?? {}} />
      </section>
    );
  }
  const tool = definition.tools.find((candidate) => candidate.name === props.toolName);
  if (!tool) return null;
  return (
    <section className="tool-definition">
      <div className="http-tool-title">
        <h2>{tool.name}</h2>
        <code>{tool.method}</code>
        <code>{tool.path}</code>
      </div>
      <p>{tool.description}</p>
      <SchemaBlock label="Parameters" value={tool.parameters} />
      {tool.bodySchema ? <SchemaBlock label="Body schema" value={tool.bodySchema} /> : null}
    </section>
  );
}

function SchemaBlock(props: {
  readonly label: string;
  readonly value: unknown;
  readonly source?: boolean;
}) {
  return (
    <div className="tool-schema-block">
      <h3>{props.label}</h3>
      <pre>{props.source ? String(props.value) : JSON.stringify(props.value, null, 2)}</pre>
    </div>
  );
}

function TestResult(props: { readonly result: CapabilityTestResult }) {
  return (
    <div
      className={
        props.result.ok ? "capability-test-result is-success" : "capability-test-result is-error"
      }
    >
      <header>
        <strong>{props.result.ok ? "Test succeeded" : "Test failed"}</strong>
        <code>{props.result.code}</code>
      </header>
      <p>{props.result.message}</p>
      {props.result.output !== undefined ? (
        <pre>{formatTestOutput(props.result.output)}</pre>
      ) : null}
    </div>
  );
}

export function parseTestInput(source: string): Record<string, unknown> {
  const value = JSON.parse(source) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Test input must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function formatTestOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
}

function capabilityTypeLabel(capability: Capability): string {
  switch (capability.definition.kind) {
    case "skill":
      return "Skill";
    case "mcp_server":
      return "MCP server";
    case "http_service":
      return "HTTP service";
    case "code_service":
      return "Code service";
  }
}

function capabilityIcon(capability: Capability) {
  switch (capability.definition.kind) {
    case "skill":
      return Archive;
    case "mcp_server":
      return Plug;
    case "http_service":
      return Globe;
    case "code_service":
      return Code;
  }
}
