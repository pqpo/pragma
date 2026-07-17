import {
  ArrowLeft,
  Archive,
  ArrowsClockwise,
  Code,
  Globe,
  Play,
  Plug,
} from "@phosphor-icons/react";
import { marked, type Token, type Tokens } from "marked";
import { createElement, Fragment, useEffect, useMemo, useState } from "react";
import type { Key, ReactNode } from "react";

import type {
  Capability,
  CapabilityTestResult,
  SkillDocument,
} from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";
import { desktopApi } from "./studio-model.ts";

export function CapabilityDetailFragment(props: {
  readonly capability: Capability;
  readonly onBack: () => void;
  readonly onChanged: (capability: Capability) => void;
}) {
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
    <section className="capability-detail" aria-labelledby="capability-detail-name">
      <button className="back-link" type="button" onClick={props.onBack}>
        <ArrowLeft size={18} aria-hidden="true" />
        Back to Capabilities
      </button>

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
            <ArrowsClockwise size={17} /> {busy ? "Refreshing…" : "Refresh tools"}
          </button>
        ) : null}
      </header>

      <section className="capability-detail-meta" aria-label="Capability status and identity">
        <DetailFact label="Status">
          <span className="capability-status">
            <i className={capability.health.status === "ready" ? "is-ready" : "is-warning"} />
            {capability.health.status === "ready" ? "Ready" : "Needs attention"}
          </span>
        </DetailFact>
        <DetailFact label="Runtime key">
          <code>{capability.manifest.runtimeKey}</code>
        </DetailFact>
        <DetailFact label="Source / connection">{capabilitySource(capability)}</DetailFact>
        <DetailFact label="Last checked">
          {new Date(capability.health.checkedAt).toLocaleString()}
        </DetailFact>
      </section>

      {capability.health.diagnostic ? (
        <p className="capability-diagnostic" role="status">
          <strong>{capability.health.diagnostic.code}</strong>
          {capability.health.diagnostic.message}
        </p>
      ) : null}

      {definition.kind === "skill" ? (
        <section className="skill-document" aria-labelledby="skill-document-heading">
          <header>
            <div>
              <h2 id="skill-document-heading">SKILL.md</h2>
              <p>Documentation bundled with this Skill revision.</p>
            </div>
            <button
              className="secondary-button"
              type="button"
              aria-pressed={documentSourceVisible}
              onClick={() => setDocumentSourceVisible((visible) => !visible)}
            >
              {documentSourceVisible ? "View rendered" : "View source"}
            </button>
          </header>
          {skillDocument === null ? (
            <p className="capability-empty">Loading Skill documentation…</p>
          ) : documentSourceVisible ? (
            <pre className="skill-document-source">{skillDocument.content}</pre>
          ) : (
            <article className="skill-markdown">
              <MarkdownDocument source={skillMarkdownBody(skillDocument.content)} />
            </article>
          )}
        </section>
      ) : (
        <section className="capability-tool-workspace" aria-label="Capability tools and test panel">
          <aside className="capability-tool-list">
            <header>
              <h2>Tools</h2>
              <span>{tools.length}</span>
            </header>
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
            {tools.length === 0 ? <p>No tools are available.</p> : null}
          </aside>

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
                      <h2 id="capability-test-heading">Test tool</h2>
                      <p>Call this tool with a JSON object.</p>
                    </div>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={busy || selectedToolName.length === 0}
                      onClick={() => void runTest()}
                    >
                      <Play size={16} /> {busy ? "Running…" : "Run test"}
                    </button>
                  </header>
                  <label>
                    JSON input
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
              <p className="capability-empty">Select or refresh a tool to inspect and test it.</p>
            )}
          </div>
        </section>
      )}

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
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

function MarkdownDocument(props: { readonly source: string }) {
  const tokens = useMemo(() => marked.lexer(props.source, { gfm: true }), [props.source]);
  return <>{renderMarkdownTokens(tokens)}</>;
}

function renderMarkdownTokens(tokens: readonly Token[]): ReactNode[] {
  return tokens.map((token, index) => renderMarkdownToken(token, index));
}

function renderMarkdownToken(token: Token, key: Key): ReactNode {
  switch (token.type) {
    case "heading": {
      const heading = token as Tokens.Heading;
      return createElement(
        `h${Math.min(6, Math.max(1, heading.depth))}`,
        { key },
        renderMarkdownTokens(heading.tokens),
      );
    }
    case "paragraph": {
      const paragraph = token as Tokens.Paragraph;
      return <p key={key}>{renderMarkdownTokens(paragraph.tokens)}</p>;
    }
    case "text": {
      const text = token as Tokens.Text;
      return text.tokens ? (
        <Fragment key={key}>{renderMarkdownTokens(text.tokens)}</Fragment>
      ) : (
        <Fragment key={key}>{text.text}</Fragment>
      );
    }
    case "escape":
      return <Fragment key={key}>{(token as Tokens.Escape).text}</Fragment>;
    case "strong": {
      const strong = token as Tokens.Strong;
      return <strong key={key}>{renderMarkdownTokens(strong.tokens)}</strong>;
    }
    case "em": {
      const emphasis = token as Tokens.Em;
      return <em key={key}>{renderMarkdownTokens(emphasis.tokens)}</em>;
    }
    case "del": {
      const deleted = token as Tokens.Del;
      return <del key={key}>{renderMarkdownTokens(deleted.tokens)}</del>;
    }
    case "codespan":
      return <code key={key}>{(token as Tokens.Codespan).text}</code>;
    case "code": {
      const code = token as Tokens.Code;
      return (
        <pre key={key}>
          <code className={code.lang ? `language-${code.lang}` : undefined}>{code.text}</code>
        </pre>
      );
    }
    case "blockquote": {
      const quote = token as Tokens.Blockquote;
      return <blockquote key={key}>{renderMarkdownTokens(quote.tokens)}</blockquote>;
    }
    case "list": {
      const list = token as Tokens.List;
      const children = list.items.map((item, index) => (
        <li key={index}>
          {item.task ? <input type="checkbox" checked={item.checked === true} readOnly /> : null}
          {renderMarkdownTokens(item.tokens)}
        </li>
      ));
      return createElement(
        list.ordered ? "ol" : "ul",
        { key, ...(list.ordered && list.start !== "" ? { start: list.start } : {}) },
        children,
      );
    }
    case "table": {
      const table = token as Tokens.Table;
      return (
        <table key={key}>
          <thead>
            <tr>
              {table.header.map((cell, index) => (
                <th key={index} style={{ textAlign: cell.align ?? undefined }}>
                  {renderMarkdownTokens(cell.tokens)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} style={{ textAlign: cell.align ?? undefined }}>
                    {renderMarkdownTokens(cell.tokens)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case "link": {
      const link = token as Tokens.Link;
      const children = renderMarkdownTokens(link.tokens);
      return isExternalLink(link.href) ? (
        <a key={key} href={link.href} target="_blank" rel="noreferrer">
          {children}
        </a>
      ) : (
        <span key={key}>{children}</span>
      );
    }
    case "image":
      return (
        <span className="markdown-image-placeholder" key={key}>
          [Image: {(token as Tokens.Image).text}]
        </span>
      );
    case "br":
      return <br key={key} />;
    case "hr":
      return <hr key={key} />;
    case "checkbox":
      return (
        <input key={key} type="checkbox" checked={(token as Tokens.Checkbox).checked} readOnly />
      );
    case "space":
    case "def":
    case "html":
      return null;
    default:
      return "tokens" in token && Array.isArray(token.tokens) ? (
        <Fragment key={key}>{renderMarkdownTokens(token.tokens as Token[])}</Fragment>
      ) : null;
  }
}

function isExternalLink(href: string): boolean {
  return href.startsWith("https://") || href.startsWith("http://");
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
