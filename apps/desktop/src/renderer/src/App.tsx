import type { Icon } from "@phosphor-icons/react";
import {
  ArchiveTrayIcon,
  CaretDown,
  CaretDoubleLeft,
  CaretDoubleRight,
  GearSix,
  House,
  Key,
  Plus,
  Robot,
  RocketLaunch,
  TerminalWindow,
  Trash,
  UserCircle,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import type {
  DesktopRuntimeAvailability,
  ModelConnectionTestResult,
  ModelProvider,
} from "../../shared/desktop-api.ts";

type SettingsView = "models" | "runtimes";

const navigationItems: readonly {
  readonly label: string;
  readonly icon: Icon;
  readonly active?: boolean;
}[] = [
  { label: "Home", icon: House },
  { label: "Missions", icon: RocketLaunch },
  { label: "Studio", icon: TerminalWindow },
  { label: "Inbox", icon: ArchiveTrayIcon },
  { label: "Settings", icon: GearSix, active: true },
];

function Sidebar(props: { readonly collapsed: boolean; readonly onToggle: () => void }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand-row">
        <div className="brand" aria-label="Pragma">
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          <span className="brand-name">Pragma</span>
        </div>
        <button
          className="sidebar-collapse-toggle"
          type="button"
          aria-label={props.collapsed ? "Expand navigation" : "Collapse navigation"}
          title={props.collapsed ? "Expand navigation" : "Collapse navigation"}
          onClick={props.onToggle}
        >
          {props.collapsed ? (
            <CaretDoubleRight size={18} weight="bold" aria-hidden="true" />
          ) : (
            <CaretDoubleLeft size={18} weight="bold" aria-hidden="true" />
          )}
        </button>
      </div>

      <nav className="navigation" aria-label="Main navigation">
        {navigationItems.map((item) => {
          const NavigationIcon = item.icon;

          return (
            <button
              key={item.label}
              className={item.active ? "navigation-item is-active" : "navigation-item"}
              type="button"
              aria-current={item.active ? "page" : undefined}
              aria-label={item.label}
              title={item.label}
              disabled
            >
              <NavigationIcon size={24} weight={item.active ? "fill" : "regular"} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="account">
        <UserCircle className="account-avatar" size={40} weight="thin" />
        <div className="account-details">
          <strong>Alex Chen</strong>
          <span>Acme Corp</span>
        </div>
        <CaretDown className="account-caret" size={16} weight="bold" />
      </div>
    </aside>
  );
}

type ProviderDraft = {
  readonly id?: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: readonly string[];
};

const emptyProviderDraft = (): ProviderDraft => ({
  name: "",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  models: [],
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The change could not be saved.";
}

function ProviderEditor(props: {
  readonly initialValue: ProviderDraft;
  readonly onCancel: () => void;
  readonly onSaved: (provider: ModelProvider) => void;
}) {
  const [draft, setDraft] = useState(props.initialValue);
  const [modelId, setModelId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isEditing = draft.id !== undefined;

  const addModel = () => {
    const normalized = modelId.trim();
    if (!normalized || draft.models.includes(normalized)) return;
    setDraft({ ...draft, models: [...draft.models, normalized] });
    setModelId("");
  };

  const save = async () => {
    setError(null);
    if (!isEditing && !draft.apiKey.trim()) {
      setError("Enter an API key before saving the provider.");
      return;
    }
    setSaving(true);
    try {
      const input = {
        name: draft.name,
        baseUrl: draft.baseUrl,
        models: [...draft.models],
      };
      const provider = isEditing
        ? await window.pragmaDesktop.updateModelProvider({
            ...input,
            id: draft.id,
            ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
          })
        : await window.pragmaDesktop.createModelProvider({ ...input, apiKey: draft.apiKey });
      props.onSaved(provider);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="provider-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="static-field">
        <span>Provider name</span>
        <input
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          placeholder="My OpenAI-compatible API"
          autoFocus
        />
      </label>
      <label className="static-field">
        <span>API base URL</span>
        <input
          value={draft.baseUrl}
          onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
          placeholder="https://api.example.com/v1"
          inputMode="url"
        />
      </label>
      <label className="static-field">
        <span>API key</span>
        <span className="key-input-wrap">
          <Key size={16} aria-hidden="true" />
          <input
            type="password"
            value={draft.apiKey}
            onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            placeholder={isEditing ? "Saved securely — enter to replace" : "sk-..."}
            autoComplete="off"
          />
        </span>
      </label>
      <div className="static-field">
        <span>Models</span>
        <div className="model-input-row">
          <input
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addModel();
              }
            }}
            placeholder="e.g. gpt-4.1-mini"
          />
          <button className="secondary-button" type="button" onClick={addModel}>
            <Plus size={16} aria-hidden="true" />
            Add model
          </button>
        </div>
        <div className="model-chip-list" aria-label="Configured models">
          {draft.models.map((model) => (
            <span className="model-chip" key={model}>
              {model}
              <button
                type="button"
                aria-label={`Remove ${model}`}
                onClick={() =>
                  setDraft({ ...draft, models: draft.models.filter((item) => item !== model) })
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="provider-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={props.onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save provider"}
        </button>
      </div>
    </form>
  );
}

function ProviderCard(props: {
  readonly provider: ModelProvider;
  readonly onDelete: () => void;
  readonly onEdit: () => void;
}) {
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ModelConnectionTestResult>>({});
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const testModel = async (modelId: string) => {
    setTestingModel(modelId);
    setError(null);
    try {
      const result = await window.pragmaDesktop.testModelConnection({
        providerId: props.provider.id,
        modelId,
      });
      setResults((current) => ({ ...current, [modelId]: result }));
    } catch (testError) {
      setError(errorMessage(testError));
    } finally {
      setTestingModel(null);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${props.provider.name}? This removes its saved API key.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await window.pragmaDesktop.deleteModelProvider({ id: props.provider.id });
      props.onDelete();
    } catch (deleteError) {
      setError(errorMessage(deleteError));
      setDeleting(false);
    }
  };

  return (
    <article className="provider-card is-expanded">
      <header className="card-header">
        <span className="card-icon" aria-hidden="true">
          <Robot size={24} weight="duotone" />
        </span>
        <div className="card-title-group">
          <h3>{props.provider.name}</h3>
          <p className="status-copy is-active">
            {props.provider.models.length} {props.provider.models.length === 1 ? "model" : "models"}
            <span aria-hidden="true">•</span>
            OpenAI compatible
          </p>
        </div>
        <button className="text-button" type="button" onClick={props.onEdit}>
          Edit
        </button>
      </header>
      <div className="provider-fields">
        <div className="static-field">
          <span>API base URL</span>
          <code className="configured-value">{props.provider.baseUrl}</code>
        </div>
        <div className="static-field">
          <span>API key</span>
          <span className="configured-value secret-value">
            <Key size={16} aria-hidden="true" />
            {props.provider.hasApiKey ? "Saved securely" : "Missing"}
          </span>
        </div>
        <div className="static-field">
          <span>Configured models</span>
          <div className="configured-model-list">
            {props.provider.models.map((model) => {
              const result = results[model];
              const isTesting = testingModel === model;
              return (
                <div className="configured-model" key={model}>
                  <div>
                    <strong>{model}</strong>
                    {result ? (
                      <p
                        className={
                          result.ok ? "connection-result is-success" : "connection-result is-error"
                        }
                      >
                        {result.message}
                        {result.latencyMs !== undefined ? ` (${result.latencyMs} ms)` : ""}
                      </p>
                    ) : null}
                  </div>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void testModel(model)}
                    disabled={testingModel !== null}
                  >
                    {isTesting ? "Testing…" : "Test connection"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="provider-danger-zone">
        <button
          className="danger-button"
          type="button"
          onClick={() => void remove()}
          disabled={deleting}
        >
          <Trash size={16} aria-hidden="true" />
          {deleting ? "Deleting…" : "Delete provider"}
        </button>
      </div>
    </article>
  );
}

function ModelsAndProviders() {
  const [providers, setProviders] = useState<readonly ModelProvider[]>([]);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProviders = async () => {
    setLoading(true);
    try {
      setProviders(await window.pragmaDesktop.listModelProviders());
      setError(null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadProviders();
  }, []);

  const saveProvider = (provider: ModelProvider) => {
    setProviders((current) => {
      const existing = current.some((item) => item.id === provider.id);
      return existing
        ? current.map((item) => (item.id === provider.id ? provider : item))
        : [...current, provider];
    });
    setDraft(null);
  };

  return (
    <div className="settings-panel" id="models-panel" role="tabpanel">
      <header className="panel-heading panel-heading-with-action">
        <div>
          <h2>Models &amp; Providers</h2>
          <p>Add OpenAI-compatible APIs and test each configured model.</p>
        </div>
        {draft ? null : (
          <button
            className="primary-button"
            type="button"
            onClick={() => setDraft(emptyProviderDraft())}
          >
            <Plus size={17} aria-hidden="true" />
            Add provider
          </button>
        )}
      </header>

      <div className="provider-list">
        {draft ? (
          <article className="provider-card is-expanded">
            <ProviderEditor
              initialValue={draft}
              onCancel={() => setDraft(null)}
              onSaved={saveProvider}
            />
          </article>
        ) : null}
        {loading ? <p className="empty-state">Loading providers…</p> : null}
        {!loading && !draft && providers.length === 0 ? (
          <div className="empty-state">
            <Robot size={28} aria-hidden="true" />
            <h3>No providers configured</h3>
            <p>Add an OpenAI-compatible API to configure models for this device.</p>
          </div>
        ) : null}
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            onEdit={() =>
              setDraft({
                id: provider.id,
                name: provider.name,
                baseUrl: provider.baseUrl,
                apiKey: "",
                models: provider.models,
              })
            }
            onDelete={() =>
              setProviders((current) => current.filter((item) => item.id !== provider.id))
            }
          />
        ))}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const runtimeDetails = {
  pi: {
    name: "PI Runtime",
    description: "Pragma's built-in runtime for managed agent execution.",
    command: "Built in",
  },
  codex: {
    name: "Codex",
    description: "OpenAI's coding agent runtime for local workspaces and shell tasks.",
    command: "codex",
  },
  "claude-code": {
    name: "Claude Code",
    description: "Anthropic's coding agent runtime for repository-aware development tasks.",
    command: "claude",
  },
} satisfies Record<
  DesktopRuntimeAvailability["id"],
  {
    readonly name: string;
    readonly description: string;
    readonly command: string;
  }
>;

function RuntimeCard(props: { readonly runtime: DesktopRuntimeAvailability }) {
  const details = runtimeDetails[props.runtime.id];
  const available = props.runtime.status === "available";

  return (
    <article className="runtime-card">
      <header className="card-header runtime-card-header">
        <span className="card-icon runtime-icon" aria-hidden="true">
          <TerminalWindow size={24} weight="duotone" />
        </span>
        <div className="card-title-group">
          <h3>{details.name}</h3>
          <p className={available ? "status-copy is-active" : "status-copy"}>
            <span className="status-dot" aria-hidden="true" />
            {available ? "Available" : "Unavailable"}
          </p>
        </div>
        <span className={available ? "status-badge is-ready" : "status-badge"}>
          {available ? "Ready" : "Not available"}
        </span>
      </header>

      <p className="runtime-description">{details.description}</p>

      <div className="runtime-command">
        <div>
          <span>{props.runtime.id === "pi" ? "Runtime" : "Executable"}</span>
          <code>{props.runtime.executablePath ?? details.command}</code>
        </div>
        {props.runtime.version ? (
          <code className="runtime-version">{props.runtime.version}</code>
        ) : null}
      </div>
      {props.runtime.reason ? <p className="runtime-reason">{props.runtime.reason}</p> : null}
    </article>
  );
}

function RuntimeEnvironments() {
  const [runtimes, setRuntimes] = useState<readonly DesktopRuntimeAvailability[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRuntimes = async () => {
    setLoading(true);
    try {
      setRuntimes(await window.pragmaDesktop.getRuntimeAvailability());
      setError(null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadRuntimes();
  }, []);

  return (
    <div className="settings-panel" id="runtimes-panel" role="tabpanel">
      <header className="panel-heading panel-heading-with-action">
        <div>
          <h2>Runtime Environments</h2>
          <p>Check which runtimes are available on this device.</p>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void loadRuntimes()}
          disabled={loading}
        >
          {loading ? "Checking…" : "Check again"}
        </button>
      </header>

      <section className="runtime-section" aria-labelledby="local-runtimes-heading">
        <header className="section-copy compact-section-copy">
          <h3 id="local-runtimes-heading">Available runtimes</h3>
          <p>PI is built in. Codex and Claude Code are checked from their local commands.</p>
        </header>

        <div className="runtime-list">
          {loading ? <p className="empty-state">Checking runtime availability…</p> : null}
          {runtimes.map((runtime) => (
            <RuntimeCard key={runtime.id} runtime={runtime} />
          ))}
        </div>
      </section>
      {error ? (
        <p className="form-error runtime-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function App() {
  const [activeView, setActiveView] = useState<SettingsView>("models");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <main className={sidebarCollapsed ? "desktop-shell is-sidebar-collapsed" : "desktop-shell"}>
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((collapsed) => !collapsed)}
      />

      <section className="settings-page">
        <h1>Settings</h1>
        <div className="settings-layout">
          <nav className="settings-navigation" aria-label="Settings sections">
            <button
              className={
                activeView === "models" ? "settings-nav-item is-active" : "settings-nav-item"
              }
              type="button"
              aria-selected={activeView === "models"}
              aria-controls="models-panel"
              onClick={() => setActiveView("models")}
            >
              Models &amp; Providers
            </button>
            <button
              className={
                activeView === "runtimes" ? "settings-nav-item is-active" : "settings-nav-item"
              }
              type="button"
              aria-selected={activeView === "runtimes"}
              aria-controls="runtimes-panel"
              onClick={() => setActiveView("runtimes")}
            >
              Runtime Environments
            </button>
          </nav>

          {activeView === "models" ? <ModelsAndProviders /> : <RuntimeEnvironments />}
        </div>
      </section>
    </main>
  );
}
