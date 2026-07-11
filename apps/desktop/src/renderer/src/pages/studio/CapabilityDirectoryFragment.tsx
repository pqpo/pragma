import {
  Archive,
  CaretDown,
  CloudArrowUp,
  DotsThree,
  Globe,
  MagnifyingGlass,
  Plug,
  Plus,
  Wrench,
  X,
} from "@phosphor-icons/react";
import { useState } from "react";

import type { Capability, CapabilityDefinition } from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";
import { desktopApi } from "./studio-model.ts";

type Filter = "all" | "skills" | "tools";
type CreateMode = "skill" | "mcp" | "http" | null;

const emptyMcp = {
  name: "",
  description: "",
  transport: "stdio" as "stdio" | "streamable-http" | "sse",
  command: "",
  args: "",
  url: "",
  token: "",
  environment: "{}",
  secretEnvironment: "{}",
};

type HttpToolDraft = {
  readonly toolName: string;
  readonly toolDescription: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly queryParameters: string;
  readonly bodySchema: string;
};

const emptyHttp = {
  name: "",
  description: "",
  baseUrl: "",
  authType: "none" as "none" | "bearer" | "api_key_header",
  headerName: "X-API-Key",
  secret: "",
  toolName: "",
  toolDescription: "",
  method: "GET" as "GET" | "POST",
  path: "/",
  queryParameters: "",
  bodySchema: '{\n  "type": "object",\n  "properties": {}\n}',
  tools: [] as HttpToolDraft[],
};

export function CapabilityDirectoryFragment(props: {
  readonly capabilities: readonly Capability[];
  readonly onChanged: (capability?: Capability, removedId?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState<CreateMode>(null);
  const [mcp, setMcp] = useState(emptyMcp);
  const [http, setHttp] = useState(emptyHttp);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const matching = props.capabilities.filter((capability) => {
    const typeMatches =
      filter === "all" ||
      (filter === "skills" && capability.definition.kind === "skill") ||
      (filter === "tools" && capability.definition.kind !== "skill");
    return (
      typeMatches &&
      `${capability.manifest.name} ${capability.definition.description}`
        .toLowerCase()
        .includes(normalizedQuery)
    );
  });

  const importSkill = async () => {
    const api = desktopApi();
    if (!api) return;
    setSaving(true);
    setError(null);
    try {
      const selected = await api.pickSkillSource();
      if (!selected.ok) {
        if (selected.reason !== "cancelled")
          throw new Error(selected.error ?? "Skill source unavailable.");
        return;
      }
      const capability = await api.importSkillCapability({ sourcePath: selected.path as string });
      props.onChanged(capability);
      setMode(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const saveMcp = async () => {
    const api = desktopApi();
    if (!api) return;
    setSaving(true);
    setError(null);
    try {
      const credentialRef = "token";
      const secretCredentials: Record<string, string> = {};
      const connection =
        mcp.transport === "stdio"
          ? (() => {
              const env = JSON.parse(mcp.environment) as Record<string, string>;
              const secretValues = JSON.parse(mcp.secretEnvironment) as Record<string, string>;
              const secretEnv = Object.fromEntries(
                Object.entries(secretValues).map(([name, value]) => {
                  const reference = `env_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
                  secretCredentials[reference] = value;
                  return [name, reference];
                }),
              );
              return {
                transport: "stdio" as const,
                command: mcp.command,
                args: mcp.args.split(/\s+/).filter(Boolean),
                env,
                secretEnv,
              };
            })()
          : {
              transport: mcp.transport,
              url: mcp.url,
              ...(mcp.token ? { tokenCredentialRef: credentialRef } : {}),
            };
      const capability = await api.createCapability({
        definition: {
          kind: "mcp_server",
          name: mcp.name,
          description: mcp.description,
          connection,
          timeoutMs: 30_000,
          tools: [],
        },
        credentials:
          mcp.transport === "stdio"
            ? secretCredentials
            : mcp.token
              ? { [credentialRef]: mcp.token }
              : {},
      });
      props.onChanged(capability);
      setMcp(emptyMcp);
      setMode(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const saveHttp = async () => {
    const api = desktopApi();
    if (!api) return;
    setSaving(true);
    setError(null);
    try {
      const credentialRef = "service-auth";
      const auth =
        http.authType === "none"
          ? ({ type: "none" } as const)
          : http.authType === "bearer"
            ? ({ type: "bearer", credentialRef } as const)
            : ({ type: "api_key_header", headerName: http.headerName, credentialRef } as const);
      const currentTool: HttpToolDraft = {
        toolName: http.toolName,
        toolDescription: http.toolDescription,
        method: http.method,
        path: http.path,
        queryParameters: http.queryParameters,
        bodySchema: http.bodySchema,
      };
      const toolDrafts = [...http.tools, ...(http.toolName.trim() ? [currentTool] : [])];
      if (toolDrafts.length === 0) throw new Error("Add at least one HTTP tool.");
      const definition: Extract<CapabilityDefinition, { kind: "http_service" }> = {
        kind: "http_service",
        name: http.name,
        description: http.description,
        baseUrl: http.baseUrl,
        auth,
        timeoutMs: 30_000,
        tools: toolDrafts.map(toHttpToolDefinition),
      };
      const capability = await api.createCapability({
        definition,
        credentials: http.authType === "none" ? {} : { [credentialRef]: http.secret },
      });
      props.onChanged(capability);
      setHttp(emptyHttp);
      setMode(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="capability-directory" aria-labelledby="capabilities-heading">
      <header className="studio-heading capability-heading">
        <div>
          <h1 id="capabilities-heading">Capabilities</h1>
          <p>
            Reusable skills and external tools that Experts can select when creating or editing.
          </p>
        </div>
        <div className="studio-create-wrap">
          <button className="primary-button" type="button" onClick={() => setMenuOpen(!menuOpen)}>
            <Plus size={17} /> Add capability <CaretDown size={14} />
          </button>
          {menuOpen ? (
            <div className="studio-create-menu capability-create-menu">
              <button
                type="button"
                onClick={() => {
                  setMode("skill");
                  setMenuOpen(false);
                }}
              >
                <CloudArrowUp size={19} />
                <span>
                  <strong>Upload skill</strong>
                  <small>Import a directory or ZIP containing SKILL.md.</small>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("mcp");
                  setMenuOpen(false);
                }}
              >
                <Plug size={19} />
                <span>
                  <strong>Connect MCP server</strong>
                  <small>stdio, Streamable HTTP, or SSE.</small>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("http");
                  setMenuOpen(false);
                }}
              >
                <Globe size={19} />
                <span>
                  <strong>Add HTTP service</strong>
                  <small>Wrap a JSON API as local MCP tools.</small>
                </span>
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <div className="capability-controls">
        <label className="directory-search">
          <MagnifyingGlass size={18} />
          <span className="sr-only">Search capabilities</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search capabilities"
          />
        </label>
        <div className="capability-filters" aria-label="Capability type">
          {(["all", "skills", "tools"] as const).map((value) => (
            <button
              key={value}
              className={filter === value ? "is-active" : ""}
              type="button"
              onClick={() => setFilter(value)}
            >
              {value[0]!.toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="capability-table" role="list">
        <div className="capability-table-heading" aria-hidden="true">
          <span>Name</span>
          <span>Type</span>
          <span>Source / Connection</span>
          <span>Status</span>
          <span />
        </div>
        {matching.map((capability) => (
          <CapabilityRow
            key={capability.manifest.id}
            capability={capability}
            onChanged={props.onChanged}
          />
        ))}
        {matching.length === 0 ? (
          <p className="capability-empty">No capabilities match this view.</p>
        ) : null}
      </div>

      {mode ? (
        <div className="capability-drawer-backdrop" role="presentation">
          <section
            className="capability-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="capability-form-heading"
          >
            <header>
              <div>
                <h2 id="capability-form-heading">
                  {mode === "skill"
                    ? "Upload skill"
                    : mode === "mcp"
                      ? "Connect MCP server"
                      : "Add HTTP service"}
                </h2>
                <p>
                  {mode === "skill"
                    ? "Copy a reusable Skill package into the library."
                    : "Configure a reusable external tool connection."}
                </p>
              </div>
              <button type="button" onClick={() => setMode(null)} aria-label="Close">
                <X size={20} />
              </button>
            </header>
            {mode === "skill" ? (
              <div className="capability-upload">
                <Archive size={34} />
                <p>Select a directory or ZIP with a root SKILL.md file.</p>
                <button
                  className="primary-button"
                  type="button"
                  disabled={saving}
                  onClick={() => void importSkill()}
                >
                  {saving ? "Importing…" : "Choose package"}
                </button>
              </div>
            ) : null}
            {mode === "mcp" ? <McpForm value={mcp} onChange={setMcp} /> : null}
            {mode === "http" ? <HttpForm value={http} onChange={setHttp} /> : null}
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            {mode !== "skill" ? (
              <footer>
                <button className="secondary-button" type="button" onClick={() => setMode(null)}>
                  Cancel
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={saving}
                  onClick={() => void (mode === "mcp" ? saveMcp() : saveHttp())}
                >
                  {saving ? "Saving…" : "Save capability"}
                </button>
              </footer>
            ) : null}
          </section>
        </div>
      ) : null}
    </section>
  );
}

function CapabilityRow(props: {
  readonly capability: Capability;
  readonly onChanged: (capability?: Capability, removedId?: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { capability } = props;
  const source =
    capability.definition.kind === "skill"
      ? "Uploaded package"
      : capability.definition.kind === "http_service"
        ? `${capability.definition.baseUrl} · Local MCP wrapper`
        : capability.definition.connection.transport === "stdio"
          ? `stdio · ${capability.definition.connection.command}`
          : `${capability.definition.connection.transport === "sse" ? "SSE" : "Streamable HTTP"} · ${capability.definition.connection.url}`;
  const type =
    capability.definition.kind === "skill"
      ? "Skill"
      : capability.definition.kind === "http_service"
        ? "HTTP service"
        : "MCP server";
  const Icon =
    capability.definition.kind === "skill"
      ? Archive
      : capability.definition.kind === "http_service"
        ? Globe
        : Wrench;
  const act = async (action: "retry" | "delete") => {
    const api = desktopApi();
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "retry") props.onChanged(await api.retryCapability(capability.manifest.id));
      else {
        await api.deleteCapability(capability.manifest.id);
        props.onChanged(undefined, capability.manifest.id);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="capability-row" role="listitem">
      <span className="capability-name">
        <span className="studio-asset-icon">
          <Icon size={22} />
        </span>
        <span>
          <strong>{capability.manifest.name}</strong>
          <small>{capability.definition.description}</small>
          {error ? <em>{error}</em> : null}
        </span>
      </span>
      <span>
        <em className="capability-type">{type}</em>
      </span>
      <span className="capability-source">{source}</span>
      <span className="capability-status">
        <i className={capability.health.status === "ready" ? "is-ready" : "is-warning"} />
        {capability.health.status === "ready" ? "Ready" : "Needs attention"}
      </span>
      <span className="capability-row-actions">
        {capability.health.status === "needs_attention" ? (
          <button type="button" disabled={busy} onClick={() => void act("retry")}>
            Retry
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void act("delete")}
          aria-label={`Delete ${capability.manifest.name}`}
        >
          <DotsThree size={20} />
        </button>
      </span>
    </div>
  );
}

function McpForm(props: {
  readonly value: typeof emptyMcp;
  readonly onChange: (value: typeof emptyMcp) => void;
}) {
  const value = props.value;
  return (
    <div className="capability-form">
      <label>
        Name
        <input
          value={value.name}
          onChange={(e) => props.onChange({ ...value, name: e.target.value })}
          placeholder="Web Search"
        />
      </label>
      <label>
        Description
        <textarea
          value={value.description}
          onChange={(e) => props.onChange({ ...value, description: e.target.value })}
        />
      </label>
      <label>
        Transport
        <select
          value={value.transport}
          onChange={(e) =>
            props.onChange({ ...value, transport: e.target.value as typeof value.transport })
          }
        >
          <option value="stdio">stdio</option>
          <option value="streamable-http">Streamable HTTP</option>
          <option value="sse">SSE</option>
        </select>
      </label>
      {value.transport === "stdio" ? (
        <>
          <label>
            Command
            <input
              value={value.command}
              onChange={(e) => props.onChange({ ...value, command: e.target.value })}
              placeholder="npx"
            />
          </label>
          <label>
            Arguments
            <input
              value={value.args}
              onChange={(e) => props.onChange({ ...value, args: e.target.value })}
              placeholder="-y @modelcontextprotocol/server-filesystem"
            />
          </label>
          <label>
            Environment JSON <small>non-sensitive values only</small>
            <textarea
              className="code-input"
              value={value.environment}
              onChange={(e) => props.onChange({ ...value, environment: e.target.value })}
            />
          </label>
          <label>
            Secret environment JSON{" "}
            <small>values are encrypted and only references are stored</small>
            <textarea
              className="code-input"
              value={value.secretEnvironment}
              onChange={(e) => props.onChange({ ...value, secretEnvironment: e.target.value })}
            />
          </label>
        </>
      ) : (
        <>
          <label>
            Server URL
            <input
              value={value.url}
              onChange={(e) => props.onChange({ ...value, url: e.target.value })}
              placeholder="https://example.com/mcp"
            />
          </label>
          <label>
            Bearer token <small>optional, encrypted on this device</small>
            <input
              type="password"
              value={value.token}
              onChange={(e) => props.onChange({ ...value, token: e.target.value })}
            />
          </label>
        </>
      )}
    </div>
  );
}

function HttpForm(props: {
  readonly value: typeof emptyHttp;
  readonly onChange: (value: typeof emptyHttp) => void;
}) {
  const value = props.value;
  const set = (change: Partial<typeof emptyHttp>) => props.onChange({ ...value, ...change });
  return (
    <div className="capability-form">
      <label>
        Service name
        <input
          value={value.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Customer API"
        />
      </label>
      <label>
        Description
        <textarea
          value={value.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </label>
      <label>
        Base URL
        <input
          value={value.baseUrl}
          onChange={(e) => set({ baseUrl: e.target.value })}
          placeholder="https://api.example.com/v1"
        />
      </label>
      <div className="capability-form-grid">
        <label>
          Authentication
          <select
            value={value.authType}
            onChange={(e) => set({ authType: e.target.value as typeof value.authType })}
          >
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
            <option value="api_key_header">API key header</option>
          </select>
        </label>
        {value.authType === "api_key_header" ? (
          <label>
            Header name
            <input value={value.headerName} onChange={(e) => set({ headerName: e.target.value })} />
          </label>
        ) : null}
      </div>
      {value.authType !== "none" ? (
        <label>
          Credential <small>encrypted on this device</small>
          <input
            type="password"
            value={value.secret}
            onChange={(e) => set({ secret: e.target.value })}
          />
        </label>
      ) : null}
      <hr />
      <h3>{value.tools.length === 0 ? "First tool" : "Add another tool"}</h3>
      {value.tools.length > 0 ? (
        <div className="http-tool-drafts">
          {value.tools.map((tool) => (
            <span key={tool.toolName}>
              <strong>{tool.toolName}</strong>
              <small>
                {tool.method} {tool.path}
              </small>
            </span>
          ))}
        </div>
      ) : null}
      <div className="capability-form-grid">
        <label>
          Tool name
          <input
            value={value.toolName}
            onChange={(e) => set({ toolName: e.target.value })}
            placeholder="get_customer"
          />
        </label>
        <label>
          Method
          <select
            value={value.method}
            onChange={(e) => set({ method: e.target.value as typeof value.method })}
          >
            <option>GET</option>
            <option>POST</option>
          </select>
        </label>
      </div>
      <label>
        Tool description
        <input
          value={value.toolDescription}
          onChange={(e) => set({ toolDescription: e.target.value })}
        />
      </label>
      <label>
        Path
        <input
          value={value.path}
          onChange={(e) => set({ path: e.target.value })}
          placeholder="/customers/{id}"
        />
      </label>
      <label>
        Optional query parameters <small>comma separated</small>
        <input
          value={value.queryParameters}
          onChange={(e) => set({ queryParameters: e.target.value })}
          placeholder="limit, cursor"
        />
      </label>
      {value.method === "POST" ? (
        <label>
          JSON body schema
          <textarea
            className="code-input"
            value={value.bodySchema}
            onChange={(e) => set({ bodySchema: e.target.value })}
          />
        </label>
      ) : null}
      <button
        className="secondary-button"
        type="button"
        disabled={!value.toolName.trim() || !value.toolDescription.trim()}
        onClick={() =>
          props.onChange({
            ...value,
            tools: [
              ...value.tools,
              {
                toolName: value.toolName,
                toolDescription: value.toolDescription,
                method: value.method,
                path: value.path,
                queryParameters: value.queryParameters,
                bodySchema: value.bodySchema,
              },
            ],
            toolName: "",
            toolDescription: "",
            method: "GET",
            path: "/",
            queryParameters: "",
            bodySchema: emptyHttp.bodySchema,
          })
        }
      >
        Add another tool
      </button>
    </div>
  );
}

function toHttpToolDefinition(draft: HttpToolDraft) {
  const pathNames = [...draft.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string);
  const queryNames = draft.queryParameters
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const bodySchema =
    draft.method === "POST" ? (JSON.parse(draft.bodySchema) as Record<string, unknown>) : undefined;
  return {
    name: draft.toolName,
    description: draft.toolDescription,
    method: draft.method,
    path: draft.path,
    parameters: [
      ...pathNames.map((name) => ({
        name,
        location: "path" as const,
        required: true,
        type: "string" as const,
      })),
      ...queryNames.map((name) => ({
        name,
        location: "query" as const,
        required: false,
        type: "string" as const,
      })),
    ],
    ...(bodySchema === undefined ? {} : { bodySchema }),
  };
}
