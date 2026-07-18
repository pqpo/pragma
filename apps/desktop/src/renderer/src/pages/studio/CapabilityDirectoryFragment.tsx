import {
  Archive,
  CaretDown,
  CloudArrowUp,
  Code,
  DotsThree,
  Globe,
  MagnifyingGlass,
  Plug,
  Plus,
  Trash,
  Wrench,
  X,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  CodeServiceObjectJsonSchemaSchema,
  type Capability,
  type CapabilityDefinition,
  type CodeServiceJsonSchema,
  type PreviewCodeServiceResult,
} from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

type Filter = "all" | "skills" | "tools";
type CreateMode = "skill" | "mcp" | "http" | "code" | null;

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
  bodySchema: '{\n  "type": "object",\n  "properties": {},\n  "additionalProperties": false\n}',
  tools: [] as HttpToolDraft[],
};

type CodeFieldType = "string" | "number" | "integer" | "boolean" | "object" | "array";

type CodeValueDraft = {
  readonly type: CodeFieldType;
  readonly fields: readonly CodeFieldDraft[];
  readonly item?: CodeValueDraft;
};

type CodeFieldDraft = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly value: CodeValueDraft;
};

const emptyCode = {
  name: "",
  description: "",
  toolName: "",
  toolDescription: "",
  inputFields: [] as readonly CodeFieldDraft[],
  outputFields: [] as readonly CodeFieldDraft[],
  source: `function main(input) {
  return {
    result: input.value,
  };
}`,
  testInput: "{}",
};

export function CapabilityDirectoryFragment(props: {
  readonly capabilities: readonly Capability[];
  readonly onOpen: (capability: Capability) => void;
  readonly onChanged: (capability?: Capability, removedId?: string) => void;
}) {
  const { t } = useTranslation("studio");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState<CreateMode>(null);
  const [mcp, setMcp] = useState(emptyMcp);
  const [http, setHttp] = useState(emptyHttp);
  const [code, setCode] = useState(emptyCode);
  const [codePreview, setCodePreview] = useState<PreviewCodeServiceResult | null>(null);
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

  const codeDefinition = (): Extract<CapabilityDefinition, { kind: "code_service" }> => ({
    kind: "code_service",
    name: code.name,
    description: code.description,
    language: "javascript",
    timeoutMs: 2_000,
    tool: {
      name: code.toolName,
      description: code.toolDescription,
      inputSchema: fieldsToObjectSchema(code.inputFields),
      outputSchema: fieldsToObjectSchema(code.outputFields),
      source: code.source,
    },
  });

  const previewCode = async () => {
    const api = desktopApi();
    if (!api) return;
    setSaving(true);
    setError(null);
    setCodePreview(null);
    try {
      const result = await api.previewCodeService({
        definition: codeDefinition(),
        input: JSON.parse(code.testInput) as unknown,
      });
      setCodePreview(result);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const saveCode = async () => {
    const api = desktopApi();
    if (!api) return;
    setSaving(true);
    setError(null);
    try {
      const capability = await api.createCapability({
        definition: codeDefinition(),
        credentials: {},
      });
      props.onChanged(capability);
      setCode(emptyCode);
      setCodePreview(null);
      setMode(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <StudioScreenFrame
      className="capability-directory"
      labelledBy="capabilities-heading"
      header={
        <header className="studio-heading capability-heading">
          <div>
            <h1 id="capabilities-heading">{t("capabilities")}</h1>
            <p>{t("capabilitiesDescription")}</p>
          </div>
          <div className="studio-create-wrap">
            <button className="primary-button" type="button" onClick={() => setMenuOpen(!menuOpen)}>
              <Plus size={17} /> {t("addCapability")} <CaretDown size={14} />
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
                    <strong>{t("uploadSkill")}</strong>
                    <small>{t("uploadSkillDescription")}</small>
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
                    <strong>{t("connectMcp")}</strong>
                    <small>{t("connectMcpDescription")}</small>
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
                    <strong>{t("addHttp")}</strong>
                    <small>{t("addHttpDescription")}</small>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode("code");
                    setMenuOpen(false);
                  }}
                >
                  <Code size={19} />
                  <span>
                    <strong>{t("addCode")}</strong>
                    <small>{t("addCodeDescription")}</small>
                  </span>
                </button>
              </div>
            ) : null}
          </div>
        </header>
      }
    >
      <div className="capability-controls">
        <label className="directory-search">
          <MagnifyingGlass size={18} />
          <span className="sr-only">{t("searchCapabilities")}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("searchCapabilities")}
          />
        </label>
        <div className="capability-filters" aria-label={t("capabilityType")}>
          {(["all", "skills", "tools"] as const).map((value) => (
            <button
              key={value}
              className={filter === value ? "is-active" : ""}
              type="button"
              onClick={() => setFilter(value)}
            >
              {t(value)}
            </button>
          ))}
        </div>
      </div>

      <div className="capability-table" role="list">
        <div className="capability-table-heading" aria-hidden="true">
          <span>{t("name")}</span>
          <span>{t("type")}</span>
          <span>{t("sourceConnection")}</span>
          <span>{t("status")}</span>
          <span />
        </div>
        {matching.map((capability) => (
          <CapabilityRow
            key={capability.manifest.id}
            capability={capability}
            onOpen={() => props.onOpen(capability)}
            onChanged={props.onChanged}
          />
        ))}
        {matching.length === 0 ? <p className="capability-empty">{t("noCapabilities")}</p> : null}
      </div>

      {mode ? (
        <div className="capability-drawer-backdrop" role="presentation">
          <section
            className={`capability-drawer${mode === "code" ? " is-code-service" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="capability-form-heading"
          >
            <header>
              <div>
                <h2 id="capability-form-heading">
                  {mode === "skill"
                    ? t("uploadSkill")
                    : mode === "mcp"
                      ? t("connectMcp")
                      : mode === "http"
                        ? t("addHttp")
                        : t("addCode")}
                </h2>
                <p>
                  {mode === "skill"
                    ? t("copySkillLibrary")
                    : mode === "code"
                      ? t("defineCodeTool")
                      : t("configureExternalTool")}
                </p>
              </div>
              <button type="button" onClick={() => setMode(null)} aria-label={t("close")}>
                <X size={20} />
              </button>
            </header>
            {mode === "skill" ? (
              <div className="capability-upload">
                <Archive size={34} />
                <p>{t("selectSkillSource")}</p>
                <button
                  className="primary-button"
                  type="button"
                  disabled={saving}
                  onClick={() => void importSkill()}
                >
                  {saving ? t("importing") : t("choosePackage")}
                </button>
              </div>
            ) : null}
            {mode === "mcp" ? <McpForm value={mcp} onChange={setMcp} /> : null}
            {mode === "http" ? <HttpForm value={http} onChange={setHttp} /> : null}
            {mode === "code" ? (
              <CodeForm
                value={code}
                preview={codePreview}
                busy={saving}
                onChange={(value) => {
                  setCode(value);
                  setCodePreview(null);
                }}
                onPreview={() => void previewCode()}
              />
            ) : null}
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            {mode !== "skill" ? (
              <footer>
                <button className="secondary-button" type="button" onClick={() => setMode(null)}>
                  {t("cancel")}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={saving}
                  onClick={() =>
                    void (mode === "mcp" ? saveMcp() : mode === "http" ? saveHttp() : saveCode())
                  }
                >
                  {saving ? t("saving") : t("saveCapability")}
                </button>
              </footer>
            ) : null}
          </section>
        </div>
      ) : null}
    </StudioScreenFrame>
  );
}

function CapabilityRow(props: {
  readonly capability: Capability;
  readonly onOpen: () => void;
  readonly onChanged: (capability?: Capability, removedId?: string) => void;
}) {
  const { t } = useTranslation("studio");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { capability } = props;
  const source =
    capability.definition.kind === "skill"
      ? t("uploadedPackage")
      : capability.definition.kind === "http_service"
        ? `${capability.definition.baseUrl} · ${t("localMcpWrapper")}`
        : capability.definition.kind === "code_service"
          ? `JavaScript · ${capability.definition.tool.name}`
          : capability.definition.connection.transport === "stdio"
            ? `stdio · ${capability.definition.connection.command}`
            : `${capability.definition.connection.transport === "sse" ? "SSE" : "Streamable HTTP"} · ${capability.definition.connection.url}`;
  const type =
    capability.definition.kind === "skill"
      ? t("skill")
      : capability.definition.kind === "http_service"
        ? t("httpService")
        : capability.definition.kind === "code_service"
          ? t("codeService")
          : t("mcpServer");
  const Icon =
    capability.definition.kind === "skill"
      ? Archive
      : capability.definition.kind === "http_service"
        ? Globe
        : capability.definition.kind === "code_service"
          ? Code
          : Wrench;
  const retry = async () => {
    const api = desktopApi();
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      props.onChanged(await api.retryCapability(capability.manifest.id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const api = desktopApi();
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.deleteCapability(capability.manifest.id);
      if (!result.ok) {
        setError(capabilityDeleteErrorMessage(result.code));
        setConfirmOpen(false);
        return;
      }
      props.onChanged(undefined, capability.manifest.id);
    } catch {
      setError(capabilityDeleteErrorMessage());
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="capability-row" role="listitem">
        <button
          className="capability-name capability-open-button"
          type="button"
          onClick={props.onOpen}
        >
          <span className="studio-asset-icon">
            <Icon size={22} />
          </span>
          <span>
            <strong>{capability.manifest.name}</strong>
            <small>{capability.definition.description}</small>
            {error ? (
              <em role="alert" title={error}>
                {error}
              </em>
            ) : null}
          </span>
        </button>
        <span>
          <em className="capability-type">{type}</em>
        </span>
        <span className="capability-source">{source}</span>
        <span className="capability-status">
          <i className={capability.health.status === "ready" ? "is-ready" : "is-warning"} />
          {capability.health.status === "ready" ? t("ready") : t("needsAttention")}
        </span>
        <span
          className="capability-row-actions"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false);
          }}
        >
          {capability.health.status === "needs_attention" ? (
            <button type="button" disabled={busy} onClick={() => void retry()}>
              {t("common:actions.retry")}
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            aria-label={t("moreActions", { name: capability.manifest.name })}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <DotsThree size={20} />
          </button>
          {menuOpen ? (
            <div className="capability-row-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmOpen(true);
                  setError(null);
                }}
              >
                <Trash size={16} /> {t("deleteCapabilityAction")}
              </button>
            </div>
          ) : null}
        </span>
      </div>
      {confirmOpen ? (
        <div className="capability-confirm-backdrop">
          <section
            className="capability-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`delete-capability-${capability.manifest.id}`}
            aria-describedby={`delete-capability-description-${capability.manifest.id}`}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !busy) setConfirmOpen(false);
            }}
          >
            <h2 id={`delete-capability-${capability.manifest.id}`}>{t("deleteCapability")}</h2>
            <p id={`delete-capability-description-${capability.manifest.id}`}>
              {t("deleteCapabilityDescription", { name: capability.manifest.name })}
            </p>
            <footer>
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                autoFocus
                onClick={() => setConfirmOpen(false)}
              >
                {t("cancel")}
              </button>
              <button
                className="danger-button"
                type="button"
                disabled={busy}
                onClick={() => void remove()}
              >
                <Trash size={17} /> {busy ? t("deleting") : t("deleteCapabilityAction")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

export function capabilityDeleteErrorMessage(code?: string): string {
  return code === "capability_referenced"
    ? "This capability is still used by one or more Experts. Remove it from those Experts, then try again."
    : "This capability could not be deleted. Please try again.";
}

function McpForm(props: {
  readonly value: typeof emptyMcp;
  readonly onChange: (value: typeof emptyMcp) => void;
}) {
  const { t } = useTranslation("studio");
  const value = props.value;
  return (
    <div className="capability-form">
      <label>
        {t("name")}
        <input
          value={value.name}
          onChange={(e) => props.onChange({ ...value, name: e.target.value })}
          placeholder="Web Search"
        />
      </label>
      <label>
        {t("description")}
        <textarea
          value={value.description}
          onChange={(e) => props.onChange({ ...value, description: e.target.value })}
        />
      </label>
      <label>
        {t("transport")}
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
            {t("command")}
            <input
              value={value.command}
              onChange={(e) => props.onChange({ ...value, command: e.target.value })}
              placeholder="npx"
            />
          </label>
          <label>
            {t("arguments")}
            <input
              value={value.args}
              onChange={(e) => props.onChange({ ...value, args: e.target.value })}
              placeholder="-y @modelcontextprotocol/server-filesystem"
            />
          </label>
          <label>
            {t("environmentJson")} <small>{t("nonSensitiveOnly")}</small>
            <textarea
              className="code-input"
              value={value.environment}
              onChange={(e) => props.onChange({ ...value, environment: e.target.value })}
            />
          </label>
          <label>
            {t("secretEnvironmentJson")} <small>{t("encryptedReferences")}</small>
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
            {t("serverUrl")}
            <input
              value={value.url}
              onChange={(e) => props.onChange({ ...value, url: e.target.value })}
              placeholder="https://example.com/mcp"
            />
          </label>
          <label>
            {t("bearerToken")} <small>{t("optionalEncrypted")}</small>
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
  const { t } = useTranslation("studio");
  const value = props.value;
  const set = (change: Partial<typeof emptyHttp>) => props.onChange({ ...value, ...change });
  return (
    <div className="capability-form">
      <label>
        {t("serviceName")}
        <input
          value={value.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Customer API"
        />
      </label>
      <label>
        {t("description")}
        <textarea
          value={value.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </label>
      <label>
        {t("baseUrl")}
        <input
          value={value.baseUrl}
          onChange={(e) => set({ baseUrl: e.target.value })}
          placeholder="https://api.example.com/v1"
        />
      </label>
      <div className="capability-form-grid">
        <label>
          {t("authentication")}
          <select
            value={value.authType}
            onChange={(e) => set({ authType: e.target.value as typeof value.authType })}
          >
            <option value="none">{t("none")}</option>
            <option value="bearer">{t("bearerToken")}</option>
            <option value="api_key_header">{t("apiKeyHeader")}</option>
          </select>
        </label>
        {value.authType === "api_key_header" ? (
          <label>
            {t("headerName")}
            <input value={value.headerName} onChange={(e) => set({ headerName: e.target.value })} />
          </label>
        ) : null}
      </div>
      {value.authType !== "none" ? (
        <label>
          {t("credential")} <small>{t("encryptedDevice")}</small>
          <input
            type="password"
            value={value.secret}
            onChange={(e) => set({ secret: e.target.value })}
          />
        </label>
      ) : null}
      <hr />
      <h3>{value.tools.length === 0 ? t("firstTool") : t("addAnotherTool")}</h3>
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
          {t("toolName")}
          <input
            value={value.toolName}
            onChange={(e) => set({ toolName: e.target.value })}
            placeholder="get_customer"
          />
        </label>
        <label>
          {t("method")}
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
        {t("toolDescription")}
        <input
          value={value.toolDescription}
          onChange={(e) => set({ toolDescription: e.target.value })}
        />
      </label>
      <label>
        {t("path")}
        <input
          value={value.path}
          onChange={(e) => set({ path: e.target.value })}
          placeholder="/customers/{id}"
        />
      </label>
      <label>
        {t("optionalQuery")} <small>{t("commaSeparated")}</small>
        <input
          value={value.queryParameters}
          onChange={(e) => set({ queryParameters: e.target.value })}
          placeholder="limit, cursor"
        />
      </label>
      {value.method === "POST" ? (
        <label>
          {t("jsonBodySchema")}
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
        {t("addAnotherTool")}
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
    draft.method === "POST"
      ? CodeServiceObjectJsonSchemaSchema.parse(JSON.parse(draft.bodySchema))
      : undefined;
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

function CodeForm(props: {
  readonly value: typeof emptyCode;
  readonly preview: PreviewCodeServiceResult | null;
  readonly busy: boolean;
  readonly onChange: (value: typeof emptyCode) => void;
  readonly onPreview: () => void;
}) {
  const { t } = useTranslation("studio");
  const value = props.value;
  const set = (change: Partial<typeof emptyCode>) => props.onChange({ ...value, ...change });
  return (
    <div className="capability-form code-service-form">
      <label>
        {t("serviceName")}
        <input
          value={value.name}
          onChange={(event) => set({ name: event.target.value })}
          placeholder="Data formatter"
        />
      </label>
      <label>
        {t("description")}
        <textarea
          value={value.description}
          onChange={(event) => set({ description: event.target.value })}
        />
      </label>
      <div className="capability-form-grid">
        <label>
          {t("toolName")}
          <input
            value={value.toolName}
            onChange={(event) => set({ toolName: event.target.value })}
            placeholder="format_data"
          />
        </label>
        <label>
          {t("toolDescription")}
          <input
            value={value.toolDescription}
            onChange={(event) => set({ toolDescription: event.target.value })}
            placeholder="Transform structured data."
          />
        </label>
      </div>
      <SchemaFieldsEditor
        title={t("inputFields")}
        fields={value.inputFields}
        onChange={(inputFields) => set({ inputFields })}
      />
      <SchemaFieldsEditor
        title={t("outputFields")}
        fields={value.outputFields}
        onChange={(outputFields) => set({ outputFields })}
      />
      <label>
        JavaScript <small>{t("javascriptFunctionHint")}</small>
        <textarea
          className="code-input code-service-source"
          spellCheck={false}
          value={value.source}
          onChange={(event) => set({ source: event.target.value })}
        />
      </label>
      <section className="code-service-preview" aria-label={t("codeServiceTest")}>
        <label>
          {t("testInputJson")}
          <textarea
            className="code-input"
            spellCheck={false}
            value={value.testInput}
            onChange={(event) => set({ testInput: event.target.value })}
          />
        </label>
        <button
          className="secondary-button"
          type="button"
          disabled={props.busy}
          onClick={props.onPreview}
        >
          {props.busy ? t("running") : t("runTest")}
        </button>
        {props.preview ? (
          <div
            className={
              props.preview.ok ? "code-preview-result is-success" : "code-preview-result is-error"
            }
          >
            <strong>{props.preview.ok ? t("testPassed") : props.preview.code}</strong>
            <p>{props.preview.message}</p>
            {props.preview.output ? (
              <pre>{JSON.stringify(props.preview.output, null, 2)}</pre>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function SchemaFieldsEditor(props: {
  readonly title?: string;
  readonly fields: readonly CodeFieldDraft[];
  readonly depth?: number;
  readonly onChange: (fields: readonly CodeFieldDraft[]) => void;
}) {
  const { t } = useTranslation("studio");
  const depth = props.depth ?? 2;
  const replace = (index: number, field: CodeFieldDraft) =>
    props.onChange(
      props.fields.map((current, currentIndex) => (currentIndex === index ? field : current)),
    );
  return (
    <section className="code-schema-fields">
      {props.title ? <h3>{props.title}</h3> : null}
      {props.fields.map((field, index) => (
        <div className="code-schema-field" key={field.id}>
          <div className="code-schema-field-row">
            <input
              aria-label={t("fieldName")}
              value={field.name}
              onChange={(event) => replace(index, { ...field, name: event.target.value })}
              placeholder="field_name"
            />
            <select
              aria-label={t("fieldType")}
              value={field.value.type}
              onChange={(event) =>
                replace(index, {
                  ...field,
                  value: emptyCodeValue(event.target.value as CodeFieldType),
                })
              }
            >
              {CODE_FIELD_TYPES.map((type) => (
                <option
                  key={type}
                  value={type}
                  disabled={depth >= 5 && (type === "object" || type === "array")}
                >
                  {type}
                </option>
              ))}
            </select>
            <label className="code-required-field">
              <input
                type="checkbox"
                checked={field.required}
                onChange={(event) => replace(index, { ...field, required: event.target.checked })}
              />
              {t("required")}
            </label>
            <button
              type="button"
              aria-label={t("removeField", { name: field.name || t("fieldName") })}
              onClick={() =>
                props.onChange(props.fields.filter((candidate) => candidate !== field))
              }
            >
              <X size={15} />
            </button>
          </div>
          <input
            aria-label={t("fieldDescription")}
            value={field.description}
            onChange={(event) => replace(index, { ...field, description: event.target.value })}
            placeholder={t("optionalFieldDescription")}
          />
          <CodeValueEditor
            value={field.value}
            depth={depth}
            hideType
            onChange={(value) => replace(index, { ...field, value })}
          />
        </div>
      ))}
      <button
        className="secondary-button"
        type="button"
        onClick={() => props.onChange([...props.fields, newCodeField()])}
      >
        <Plus size={15} /> {t("addField")}
      </button>
    </section>
  );
}

function CodeValueEditor(props: {
  readonly value: CodeValueDraft;
  readonly depth: number;
  readonly hideType?: boolean;
  readonly onChange: (value: CodeValueDraft) => void;
}) {
  const value = props.value;
  return (
    <div className="code-value-editor">
      {props.hideType ? null : (
        <label>
          Item type
          <select
            value={value.type}
            onChange={(event) =>
              props.onChange(emptyCodeValue(event.target.value as CodeFieldType))
            }
          >
            {CODE_FIELD_TYPES.map((type) => (
              <option
                key={type}
                value={type}
                disabled={props.depth >= 5 && (type === "object" || type === "array")}
              >
                {type}
              </option>
            ))}
          </select>
        </label>
      )}
      {value.type === "object" ? (
        <SchemaFieldsEditor
          fields={value.fields}
          depth={props.depth + 1}
          onChange={(fields) => props.onChange({ ...value, fields })}
        />
      ) : null}
      {value.type === "array" ? (
        <CodeValueEditor
          value={value.item ?? emptyCodeValue("string")}
          depth={props.depth + 1}
          onChange={(item) => props.onChange({ ...value, item })}
        />
      ) : null}
    </div>
  );
}

const CODE_FIELD_TYPES: readonly CodeFieldType[] = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
];

function newCodeField(): CodeFieldDraft {
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    required: true,
    value: emptyCodeValue("string"),
  };
}

function emptyCodeValue(type: CodeFieldType): CodeValueDraft {
  return {
    type,
    fields: [],
    ...(type === "array" ? { item: { type: "string", fields: [] } } : {}),
  };
}

export function fieldsToObjectSchema(
  fields: readonly CodeFieldDraft[],
): Extract<CodeServiceJsonSchema, { readonly type: "object" }> {
  const names = fields.map((field) => field.name.trim());
  if (new Set(names).size !== names.length) {
    throw new Error("Field names must be unique within each object.");
  }
  return {
    type: "object",
    properties: Object.fromEntries(
      fields.map((field) => [field.name.trim(), valueToSchema(field.value, field.description)]),
    ),
    required: fields.filter((field) => field.required).map((field) => field.name.trim()),
    additionalProperties: false,
  };
}

function valueToSchema(value: CodeValueDraft, description: string): CodeServiceJsonSchema {
  const details = description.trim() ? { description: description.trim() } : {};
  if (value.type === "object") return { ...fieldsToObjectSchema(value.fields), ...details };
  if (value.type === "array") {
    return {
      type: "array",
      items: valueToSchema(value.item ?? emptyCodeValue("string"), ""),
      ...details,
    };
  }
  return { type: value.type, ...details };
}
