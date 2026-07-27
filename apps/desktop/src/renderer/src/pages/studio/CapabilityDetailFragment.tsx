import {
  ArrowLeft,
  Archive,
  ArrowsClockwise,
  Code,
  Globe,
  Play,
  Plug,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type {
  Capability,
  CapabilityTestResult,
  SkillDocument,
} from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { MarkdownContent } from "../../components/MarkdownContent.tsx";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

export function CapabilityDetailFragment(props: {
  readonly capability: Capability;
  readonly onBack: () => void;
  readonly onChanged: (capability: Capability) => void;
}) {
  const { t } = useTranslation("studio");
  const { capability } = props;
  const definition = capability.definition;
  const [skillDocument, setSkillDocument] = useState<SkillDocument | null>(null);
  const [documentSourceVisible, setDocumentSourceVisible] = useState(false);
  const [selectedToolName, setSelectedToolName] = useState(() => firstToolName(capability));
  const [testInput, setTestInput] = useState("{}");
  const [testResult, setTestResult] = useState<CapabilityTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tools = useMemo(() => capabilityTools(capability), [capability]);

  useEffect(() => {
    if (definition.kind !== "skill") {
      setSkillDocument(null);
      return;
    }
    const api = desktopApi();
    if (api === undefined) return;
    let cancelled = false;
    setError(null);
    void api
      .getSkillDocument({
        id: capability.manifest.id,
        revision: capability.manifest.latestRevision,
      })
      .then((document) => {
        if (!cancelled) setSkillDocument(document);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [capability.manifest.id, capability.manifest.latestRevision, definition.kind]);

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
      props.onChanged(await api.retryCapability(capability.manifest.id));
      setTestResult(null);
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
        <button className="back-link" type="button" onClick={props.onBack}>
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
              <h1 id="capability-detail-name">{capability.manifest.name}</h1>
              <span className="capability-type">{capabilityTypeLabel(capability)}</span>
              <span className="version-label">Revision {capability.manifest.latestRevision}</span>
            </div>
            <p>{definition.description}</p>
          </div>
          {definition.kind === "mcp_server" ? (
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

        <section className="capability-detail-meta" aria-label={t("capabilityIdentity")}>
          <DetailFact label={t("status")}>
            <span className="capability-status">
              <i className={capability.health.status === "ready" ? "is-ready" : "is-warning"} />
              {capability.health.status === "ready" ? t("ready") : t("needsAttention")}
            </span>
          </DetailFact>
          <DetailFact label={t("runtimeKey")}>
            <code>{capability.manifest.runtimeKey}</code>
          </DetailFact>
          <DetailFact label={t("sourceConnection")}>{capabilitySource(capability)}</DetailFact>
          <DetailFact label={t("lastChecked")}>
            {new Date(capability.health.checkedAt).toLocaleString()}
          </DetailFact>
        </section>

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
        <section className="skill-document" aria-labelledby="skill-document-heading">
          <header>
            <div>
              <h2 id="skill-document-heading">SKILL.md</h2>
              <p>{t("skillDocumentation")}</p>
            </div>
            <button
              className="secondary-button"
              type="button"
              aria-pressed={documentSourceVisible}
              onClick={() => setDocumentSourceVisible((visible) => !visible)}
            >
              {documentSourceVisible ? t("viewRendered") : t("viewSource")}
            </button>
          </header>
          {skillDocument === null ? (
            <p className="capability-empty">{t("loadingSkill")}</p>
          ) : documentSourceVisible ? (
            <pre className="skill-document-source">{skillDocument.content}</pre>
          ) : (
            <article className="skill-markdown">
              <MarkdownContent source={skillMarkdownBody(skillDocument.content)} />
            </article>
          )}
        </section>
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
    </StudioScreenFrame>
  );
}

function DetailFact(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <h2>{props.label}</h2>
      <p>{props.children}</p>
    </div>
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

export function skillMarkdownBody(source: string): string {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const end = normalized.indexOf("\n---\n", 4);
  return end < 0 ? normalized : normalized.slice(end + 5).trimStart();
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

function capabilitySource(capability: Capability): string {
  const definition = capability.definition;
  if (definition.kind === "skill") return "Uploaded package · SKILL.md";
  if (definition.kind === "http_service") {
    return `${definition.baseUrl} · ${definition.auth.type.replaceAll("_", " ")}`;
  }
  if (definition.kind === "code_service") return `JavaScript · ${definition.timeoutMs} ms timeout`;
  return definition.connection.transport === "stdio"
    ? `stdio · ${definition.connection.command} ${definition.connection.args.join(" ")}`.trim()
    : `${definition.connection.transport} · ${definition.connection.url}`;
}
