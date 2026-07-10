import type { Icon } from "@phosphor-icons/react";
import {
  ArchiveTrayIcon,
  CaretDown,
  CaretRight,
  Check,
  GearSix,
  House,
  Key,
  Monitor,
  Robot,
  RocketLaunch,
  TerminalWindow,
  UserCircle,
} from "@phosphor-icons/react";
import { useState } from "react";

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

function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand" aria-label="Pragma">
        <span className="brand-mark" aria-hidden="true">
          P
        </span>
        <span className="brand-name">Pragma</span>
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

function StaticToggle(props: { readonly checked?: boolean; readonly label: string }) {
  return (
    <span
      className={props.checked ? "toggle is-checked" : "toggle"}
      role="img"
      aria-label={`${props.label}: ${props.checked ? "on" : "off"}`}
    >
      <span className="toggle-thumb">
        {props.checked ? <Check size={13} weight="bold" aria-hidden="true" /> : null}
      </span>
    </span>
  );
}

function ProviderCard(props: {
  readonly name: string;
  readonly model: string;
  readonly active?: boolean;
  readonly children?: React.ReactNode;
}) {
  return (
    <article className={props.active ? "provider-card is-expanded" : "provider-card"}>
      <header className="card-header">
        <span className="card-icon" aria-hidden="true">
          <Robot size={24} weight="duotone" />
        </span>
        <div className="card-title-group">
          <h3>{props.name}</h3>
          <p className={props.active ? "status-copy is-active" : "status-copy"}>
            {props.active ? "Active" : "Inactive"}
            {props.active ? <span aria-hidden="true">•</span> : null}
            {props.active ? props.model : null}
          </p>
        </div>
        <StaticToggle checked={props.active === true} label={`${props.name} provider`} />
      </header>
      {props.children}
    </article>
  );
}

function ModelsAndProviders() {
  return (
    <div className="settings-panel" id="models-panel" role="tabpanel">
      <header className="panel-heading">
        <h2>Models &amp; Providers</h2>
        <p>Configure primary and fallback AI models for orchestration tasks.</p>
      </header>

      <div className="provider-list">
        <ProviderCard name="OpenAI" model="gpt-5" active>
          <div className="provider-fields">
            <label className="static-field">
              <span>API key</span>
              <span className="input-shell secret-value">
                <Key size={16} weight="regular" aria-hidden="true" />
                ••••••••••••••••••••••••
              </span>
            </label>
            <label className="static-field">
              <span>Default model</span>
              <span className="input-shell select-shell">
                gpt-5
                <CaretDown size={16} weight="bold" aria-hidden="true" />
              </span>
            </label>
          </div>
        </ProviderCard>

        <ProviderCard name="Anthropic" model="Claude Sonnet" />
      </div>

      <section className="advanced-section" aria-labelledby="advanced-heading">
        <header className="section-copy">
          <h3 id="advanced-heading">Advanced Settings</h3>
          <p>Fine-tune global behavior for model inference.</p>
        </header>

        <div className="setting-row">
          <div>
            <h4>Streaming Responses</h4>
            <p>Receive output token by token.</p>
          </div>
          <StaticToggle checked label="Streaming responses" />
        </div>
        <div className="setting-row">
          <div>
            <h4>Local Telemetry</h4>
            <p>Save execution logs locally for debugging.</p>
          </div>
          <StaticToggle label="Local telemetry" />
        </div>
        <div className="temperature-setting">
          <div className="temperature-heading">
            <h4>Global Temperature</h4>
            <span>0.7</span>
          </div>
          <div className="range-track" aria-label="Global temperature: 0.7">
            <span className="range-fill" />
            <span className="range-thumb" />
          </div>
        </div>
      </section>
    </div>
  );
}

function RuntimeCard(props: {
  readonly name: string;
  readonly description: string;
  readonly command: string;
  readonly ready?: boolean;
}) {
  return (
    <article className="runtime-card">
      <header className="card-header runtime-card-header">
        <span className="card-icon runtime-icon" aria-hidden="true">
          <TerminalWindow size={24} weight="duotone" />
        </span>
        <div className="card-title-group">
          <h3>{props.name}</h3>
          <p className={props.ready ? "status-copy is-active" : "status-copy"}>
            <span className="status-dot" aria-hidden="true" />
            {props.ready ? "Detected" : "Not configured"}
          </p>
        </div>
        <span className={props.ready ? "status-badge is-ready" : "status-badge"}>
          {props.ready ? "Ready" : "Setup required"}
        </span>
      </header>

      <p className="runtime-description">{props.description}</p>

      <div className="runtime-command">
        <div>
          <span>Executable</span>
          <code>{props.command}</code>
        </div>
        <CaretRight size={18} weight="bold" aria-hidden="true" />
      </div>
    </article>
  );
}

function RuntimeEnvironments() {
  return (
    <div className="settings-panel" id="runtimes-panel" role="tabpanel">
      <header className="panel-heading">
        <h2>Runtime Environments</h2>
        <p>Manage the local agent runtimes available to this device.</p>
      </header>

      <div className="device-summary">
        <span className="device-icon" aria-hidden="true">
          <Monitor size={24} weight="duotone" />
        </span>
        <div>
          <h3>This device</h3>
          <p>Local runtime bridge is available for Pragma Desktop.</p>
        </div>
        <span className="online-status">
          <span className="online-dot" aria-hidden="true" />
          Online
        </span>
      </div>

      <section className="runtime-section" aria-labelledby="local-runtimes-heading">
        <header className="section-copy compact-section-copy">
          <h3 id="local-runtimes-heading">Local runtimes</h3>
          <p>Detected command-line agents that can execute work on this machine.</p>
        </header>

        <div className="runtime-list">
          <RuntimeCard
            name="Codex"
            description="OpenAI's coding agent runtime for local workspaces and shell tasks."
            command="/usr/local/bin/codex"
            ready
          />
          <RuntimeCard
            name="Claude Code"
            description="Anthropic's coding agent runtime for repository-aware development tasks."
            command="Not selected"
          />
        </div>
      </section>

      <section className="runtime-defaults" aria-labelledby="runtime-defaults-heading">
        <header className="section-copy compact-section-copy">
          <h3 id="runtime-defaults-heading">Environment defaults</h3>
          <p>Defaults applied when a mission starts in a local runtime.</p>
        </header>
        <div className="setting-row runtime-default-row">
          <div>
            <h4>Workspace access</h4>
            <p>Ask before a runtime uses a folder outside the active workspace.</p>
          </div>
          <StaticToggle checked label="Ask before workspace access" />
        </div>
      </section>
    </div>
  );
}

export function App() {
  const [activeView, setActiveView] = useState<SettingsView>("models");

  return (
    <main className="desktop-shell">
      <Sidebar />

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
