import {
  Archive,
  CaretDown,
  CloudArrowUp,
  Code,
  DotsThree,
  Globe,
  MagnifyingGlass,
  PencilSimple,
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
  type PreviewCodeServiceResult,
} from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import {
  SchemaFieldsEditor,
  fieldsToObjectSchema,
  objectSchemaToFields,
  type SchemaFieldDraft as CodeFieldDraft,
} from "./JsonSchemaFieldsEditor.tsx";

export { fieldsToObjectSchema, objectSchemaToFields } from "./JsonSchemaFieldsEditor.tsx";
import { desktopApi } from "./studio-model.ts";

type Filter = "all" | "skills" | "tools";
type CapabilityMode = "skill" | "mcp" | "http" | "code";
type EditableCapability = Capability & {
  readonly definition: Exclude<CapabilityDefinition, { readonly kind: "skill" }>;
};

export function isEditableCapability(capability: Capability): capability is EditableCapability {
  return capability.definition.kind !== "skill";
}

const emptyMcp = {
  name: "",
  description: "",
  transport: "stdio" as "stdio" | "streamable-http" | "sse",
  command: "",
  args: "",
  url: "",
  token: "",
  tokenEnabled: false,
  tokenCredentialRef: undefined as string | undefined,
  environment: "{}",
  secretEnvironment: "{}",
  secretEnvironmentRefs: {} as Readonly<Record<string, string>>,
  timeoutMs: 30_000,
  tools: [] as Extract<CapabilityDefinition, { kind: "mcp_server" }>["tools"],
};

type HttpToolDraft = {
  readonly toolName: string;
  readonly toolDescription: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly queryParameters: string;
  readonly bodySchema: string;
  readonly parameters: Extract<
    CapabilityDefinition,
    { kind: "http_service" }
  >["tools"][number]["parameters"];
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
  editingToolIndex: null as number | null,
  timeoutMs: 30_000,
  hasSavedCredential: false,
  credentialRef: undefined as string | undefined,
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
  timeoutMs: 2_000,
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
  const [mode, setMode] = useState<CapabilityMode | null>(null);
  const [editingCapability, setEditingCapability] = useState<EditableCapability | null>(null);
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

  const closeDrawer = () => {
    setMode(null);
    setEditingCapability(null);
    setError(null);
    setCodePreview(null);
  };

  const openCreateDrawer = (nextMode: CapabilityMode) => {
    setEditingCapability(null);
    setError(null);
    setCodePreview(null);
    if (nextMode === "mcp") setMcp(emptyMcp);
    if (nextMode === "http") setHttp(emptyHttp);
    if (nextMode === "code") setCode(emptyCode);
    setMode(nextMode);
    setMenuOpen(false);
  };

  const openEditDrawer = (capability: EditableCapability) => {
    setEditingCapability(capability);
    setError(null);
    setCodePreview(null);
    if (capability.definition.kind === "mcp_server") {
      setMcp(mcpDraftFromDefinition(capability.definition));
      setMode("mcp");
    } else if (capability.definition.kind === "http_service") {
      setHttp(httpDraftFromDefinition(capability.definition));
      setMode("http");
    } else {
      setCode(codeDraftFromDefinition(capability.definition));
      setMode("code");
    }
  };

  const persistCapability = async (
    definition: Exclude<CapabilityDefinition, { readonly kind: "skill" }>,
    credentials: Readonly<Record<string, string>>,
  ) => {
    const api = desktopApi();
    if (!api) return undefined;
    return editingCapability === null
      ? await api.createCapability({ definition, credentials })
      : await api.updateCapability({ id: editingCapability.manifest.id, definition, credentials });
  };

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
      closeDrawer();
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
      const credentialRef = mcp.tokenCredentialRef ?? "token";
      const secretCredentials: Record<string, string> = {};
      const connection =
        mcp.transport === "stdio"
          ? (() => {
              const env = parseStringRecord(mcp.environment);
              const secretValues = parseStringRecord(mcp.secretEnvironment);
              const secretEnv = Object.fromEntries(
                Object.entries(secretValues).map(([name, value]) => {
                  const reference =
                    mcp.secretEnvironmentRefs[name] ??
                    `env_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
                  if (value.length === 0 && mcp.secretEnvironmentRefs[name] === undefined) {
                    throw new Error(
                      `Enter a value for the new secret environment variable ${name}.`,
                    );
                  }
                  if (value.length > 0) secretCredentials[reference] = value;
                  return [name, reference];
                }),
              );
              return {
                transport: "stdio" as const,
                command: mcp.command,
                args: parseCommandArguments(mcp.args),
                env,
                secretEnv,
              };
            })()
          : {
              transport: mcp.transport,
              url: mcp.url,
              ...(mcp.tokenEnabled ? { tokenCredentialRef: credentialRef } : {}),
            };
      if (mcp.tokenEnabled && mcp.token.length === 0 && mcp.tokenCredentialRef === undefined) {
        throw new Error("Enter a bearer token or disable token authentication.");
      }
      const capability = await persistCapability(
        {
          kind: "mcp_server",
          name: mcp.name,
          description: mcp.description,
          connection,
          timeoutMs: mcp.timeoutMs,
          tools: mcp.tools,
        },
        mcp.transport === "stdio"
          ? secretCredentials
          : mcp.token
            ? { [credentialRef]: mcp.token }
            : {},
      );
      if (capability === undefined) return;
      props.onChanged(capability);
      setMcp(emptyMcp);
      closeDrawer();
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
      const credentialRef = http.credentialRef ?? "service-auth";
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
        parameters: currentHttpToolParameters(http),
      };
      const toolDrafts = commitCurrentHttpTool(http, currentTool);
      if (toolDrafts.length === 0) throw new Error("Add at least one HTTP tool.");
      const definition: Extract<CapabilityDefinition, { kind: "http_service" }> = {
        kind: "http_service",
        name: http.name,
        description: http.description,
        baseUrl: http.baseUrl,
        auth,
        timeoutMs: http.timeoutMs,
        tools: toolDrafts.map(toHttpToolDefinition),
      };
      if (http.authType !== "none" && http.secret.length === 0 && !http.hasSavedCredential) {
        throw new Error("Enter a credential for this HTTP service.");
      }
      const capability = await persistCapability(
        definition,
        http.authType === "none" || http.secret.length === 0
          ? {}
          : { [credentialRef]: http.secret },
      );
      if (capability === undefined) return;
      props.onChanged(capability);
      setHttp(emptyHttp);
      closeDrawer();
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
    timeoutMs: code.timeoutMs,
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
      const capability = await persistCapability(codeDefinition(), {});
      if (capability === undefined) return;
      props.onChanged(capability);
      setCode(emptyCode);
      setCodePreview(null);
      closeDrawer();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <StudioScreenFrame
      className="capability-directory capability-catalog"
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
                    openCreateDrawer("skill");
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
                    openCreateDrawer("mcp");
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
                    openCreateDrawer("http");
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
                    openCreateDrawer("code");
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
          <span className="capability-column-name">{t("name")}</span>
          <span className="capability-column-type">{t("type")}</span>
          <span className="capability-column-source">{t("sourceConnection")}</span>
          <span className="capability-column-status">{t("status")}</span>
          <span className="capability-column-actions" />
        </div>
        {matching.map((capability) => (
          <CapabilityRow
            key={capability.manifest.id}
            capability={capability}
            onOpen={() => props.onOpen(capability)}
            onEdit={isEditableCapability(capability) ? () => openEditDrawer(capability) : undefined}
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
                  {editingCapability !== null
                    ? t("editCapability")
                    : mode === "skill"
                      ? t("uploadSkill")
                      : mode === "mcp"
                        ? t("connectMcp")
                        : mode === "http"
                          ? t("addHttp")
                          : t("addCode")}
                </h2>
                <p>
                  {editingCapability !== null
                    ? t("editCapabilityDescription")
                    : mode === "skill"
                      ? t("copySkillLibrary")
                      : mode === "code"
                        ? t("defineCodeTool")
                        : t("configureExternalTool")}
                </p>
              </div>
              <button type="button" onClick={closeDrawer} aria-label={t("close")}>
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
                <button className="secondary-button" type="button" onClick={closeDrawer}>
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
                  {saving
                    ? t("saving")
                    : editingCapability === null
                      ? t("saveCapability")
                      : t("saveCapabilityChanges")}
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
  readonly onEdit?: (() => void) | undefined;
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
          className="capability-name capability-open-button capability-column-name"
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
        <span className="capability-column-type">
          <em className="capability-type">{type}</em>
        </span>
        <span className="capability-source capability-column-source">{source}</span>
        <span className="capability-status capability-column-status">
          <i className={capability.health.status === "ready" ? "is-ready" : "is-warning"} />
          {capability.health.status === "ready" ? t("ready") : t("needsAttention")}
        </span>
        <span
          className="capability-row-actions capability-column-actions"
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
              {props.onEdit ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setError(null);
                    props.onEdit?.();
                  }}
                >
                  <PencilSimple size={16} /> {t("editCapability")}
                </button>
              ) : null}
              <button
                className="is-danger"
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

export function mcpDraftFromDefinition(
  definition: Extract<CapabilityDefinition, { readonly kind: "mcp_server" }>,
): typeof emptyMcp {
  if (definition.connection.transport === "stdio") {
    return {
      ...emptyMcp,
      name: definition.name,
      description: definition.description,
      command: definition.connection.command,
      args: formatCommandArguments(definition.connection.args),
      environment: JSON.stringify(definition.connection.env, null, 2),
      secretEnvironment: JSON.stringify(
        Object.fromEntries(Object.keys(definition.connection.secretEnv).map((name) => [name, ""])),
        null,
        2,
      ),
      secretEnvironmentRefs: definition.connection.secretEnv,
      timeoutMs: definition.timeoutMs,
      tools: definition.tools,
    };
  }
  return {
    ...emptyMcp,
    name: definition.name,
    description: definition.description,
    transport: definition.connection.transport,
    url: definition.connection.url,
    tokenEnabled: definition.connection.tokenCredentialRef !== undefined,
    tokenCredentialRef: definition.connection.tokenCredentialRef,
    timeoutMs: definition.timeoutMs,
    tools: definition.tools,
  };
}

export function formatCommandArguments(args: readonly string[]): string {
  return args
    .map((argument) =>
      /^[A-Za-z0-9_./:@%+=,-]+$/.test(argument)
        ? argument
        : `'${argument.replaceAll("'", "'\\''")}'`,
    )
    .join(" ");
}

export function parseCommandArguments(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let started = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      started = true;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }
  if (escaped || quote !== null) throw new Error("Command arguments contain an unfinished quote.");
  if (started) args.push(current);
  return args;
}

function parseStringRecord(value: string): Record<string, string> {
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Environment JSON must be an object containing string values.");
  }
  const entries = Object.entries(parsed);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new Error("Environment JSON values must be strings.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export function httpDraftFromDefinition(
  definition: Extract<CapabilityDefinition, { readonly kind: "http_service" }>,
): typeof emptyHttp {
  return {
    ...emptyHttp,
    name: definition.name,
    description: definition.description,
    baseUrl: definition.baseUrl,
    authType: definition.auth.type,
    headerName:
      definition.auth.type === "api_key_header" ? definition.auth.headerName : "X-API-Key",
    tools: definition.tools.map(httpToolDraftFromDefinition),
    timeoutMs: definition.timeoutMs,
    hasSavedCredential: definition.auth.type !== "none",
    credentialRef: definition.auth.type === "none" ? undefined : definition.auth.credentialRef,
  };
}

function httpToolDraftFromDefinition(
  tool: Extract<CapabilityDefinition, { readonly kind: "http_service" }>["tools"][number],
): HttpToolDraft {
  return {
    toolName: tool.name,
    toolDescription: tool.description,
    method: tool.method,
    path: tool.path,
    queryParameters: tool.parameters
      .filter((parameter) => parameter.location === "query")
      .map((parameter) => parameter.name)
      .join(", "),
    bodySchema: JSON.stringify(
      tool.bodySchema ?? CodeServiceObjectJsonSchemaSchema.parse(JSON.parse(emptyHttp.bodySchema)),
      null,
      2,
    ),
    parameters: tool.parameters,
  };
}

function loadHttpTool(value: typeof emptyHttp, tool: HttpToolDraft, index: number) {
  return {
    ...value,
    toolName: tool.toolName,
    toolDescription: tool.toolDescription,
    method: tool.method,
    path: tool.path,
    queryParameters: tool.queryParameters,
    bodySchema: tool.bodySchema,
    editingToolIndex: index,
  };
}

function removeHttpTool(value: typeof emptyHttp, index: number) {
  const tools = value.tools.filter((_, currentIndex) => currentIndex !== index);
  if (value.editingToolIndex === index) return resetHttpToolEditor({ ...value, tools });
  return {
    ...value,
    tools,
    editingToolIndex:
      value.editingToolIndex !== null && value.editingToolIndex > index
        ? value.editingToolIndex - 1
        : value.editingToolIndex,
  };
}

function currentHttpToolParameters(value: typeof emptyHttp): HttpToolDraft["parameters"] {
  return value.editingToolIndex === null
    ? []
    : (value.tools[value.editingToolIndex]?.parameters ?? []);
}

function commitCurrentHttpTool(
  value: typeof emptyHttp,
  currentTool: HttpToolDraft,
): HttpToolDraft[] {
  if (!currentTool.toolName.trim()) return [...value.tools];
  if (value.editingToolIndex === null) return [...value.tools, currentTool];
  return value.tools.map((tool, index) => (index === value.editingToolIndex ? currentTool : tool));
}

function resetHttpToolEditor(value: typeof emptyHttp): typeof emptyHttp {
  return {
    ...value,
    toolName: "",
    toolDescription: "",
    method: "GET",
    path: "/",
    queryParameters: "",
    bodySchema: emptyHttp.bodySchema,
    editingToolIndex: null,
  };
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
            {t("secretEnvironmentJson")}{" "}
            <small>
              {Object.keys(value.secretEnvironmentRefs).length === 0
                ? t("encryptedReferences")
                : t("leaveSecretValuesBlank")}
            </small>
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
          <label className="capability-auth-toggle">
            <input
              type="checkbox"
              checked={value.tokenEnabled}
              onChange={(event) =>
                props.onChange({ ...value, tokenEnabled: event.target.checked, token: "" })
              }
            />
            {t("useBearerToken")}
          </label>
          {value.tokenEnabled ? (
            <label>
              {t("bearerToken")}{" "}
              <small>
                {value.tokenCredentialRef === undefined
                  ? t("encryptedDevice")
                  : t("leaveCredentialBlank")}
              </small>
              <input
                type="password"
                value={value.token}
                onChange={(e) => props.onChange({ ...value, token: e.target.value })}
              />
            </label>
          ) : null}
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
          {t("credential")}{" "}
          <small>
            {value.hasSavedCredential ? t("leaveCredentialBlank") : t("encryptedDevice")}
          </small>
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
          {value.tools.map((tool, index) => (
            <span key={`${tool.toolName}-${index}`}>
              <span>
                <strong>{tool.toolName}</strong>
                <small>
                  {tool.method} {tool.path}
                </small>
              </span>
              <span className="http-tool-actions">
                <button
                  type="button"
                  aria-label={t("editNamedTool", { name: tool.toolName })}
                  onClick={() => props.onChange(loadHttpTool(value, tool, index))}
                >
                  <PencilSimple size={15} />
                </button>
                <button
                  type="button"
                  aria-label={t("removeTool", { name: tool.toolName })}
                  onClick={() => props.onChange(removeHttpTool(value, index))}
                >
                  <Trash size={15} />
                </button>
              </span>
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
        onClick={() => {
          const currentTool: HttpToolDraft = {
            toolName: value.toolName,
            toolDescription: value.toolDescription,
            method: value.method,
            path: value.path,
            queryParameters: value.queryParameters,
            bodySchema: value.bodySchema,
            parameters: currentHttpToolParameters(value),
          };
          props.onChange(
            resetHttpToolEditor({ ...value, tools: commitCurrentHttpTool(value, currentTool) }),
          );
        }}
      >
        {value.editingToolIndex === null ? t("addAnotherTool") : t("updateTool")}
      </button>
    </div>
  );
}

export function toHttpToolDefinition(draft: HttpToolDraft) {
  const pathNames = [...draft.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string);
  const queryNames = draft.queryParameters
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const bodySchema =
    draft.method === "POST"
      ? CodeServiceObjectJsonSchemaSchema.parse(JSON.parse(draft.bodySchema))
      : undefined;
  const parameter = (name: string, location: "path" | "query") => {
    const existing = draft.parameters.find(
      (candidate) => candidate.name === name && candidate.location === location,
    );
    return (
      existing ?? {
        name,
        location,
        required: location === "path",
        type: "string" as const,
      }
    );
  };
  return {
    name: draft.toolName,
    description: draft.toolDescription,
    method: draft.method,
    path: draft.path,
    parameters: [
      ...pathNames.map((name) => parameter(name, "path")),
      ...queryNames.map((name) => parameter(name, "query")),
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

export function codeDraftFromDefinition(
  definition: Extract<CapabilityDefinition, { readonly kind: "code_service" }>,
): typeof emptyCode {
  return {
    ...emptyCode,
    name: definition.name,
    description: definition.description,
    toolName: definition.tool.name,
    toolDescription: definition.tool.description,
    inputFields: objectSchemaToFields(definition.tool.inputSchema),
    outputFields: objectSchemaToFields(definition.tool.outputSchema),
    source: definition.tool.source,
    timeoutMs: definition.timeoutMs,
  };
}
