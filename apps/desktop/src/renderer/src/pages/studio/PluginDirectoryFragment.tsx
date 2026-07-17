import {
  ArrowLeft,
  MagnifyingGlass,
  Package,
  PuzzlePiece,
  ShieldCheck,
  Trash,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import { useState } from "react";

import type { DesktopPlugin, PluginZipInspection } from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";
import { desktopApi } from "./studio-model.ts";
import { PluginConfigFields } from "./PluginConfigFields.tsx";

type PluginFilter = "all" | "built_in" | "user";

export function PluginDirectoryFragment(props: {
  readonly plugins: readonly DesktopPlugin[];
  readonly onOpen: (plugin: DesktopPlugin) => void;
  readonly onChanged: (plugin: DesktopPlugin) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("all");
  const [inspection, setInspection] = useState<PluginZipInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matching = props.plugins.filter((plugin) => {
    const text = `${plugin.manifest.name} ${plugin.manifest.description} ${plugin.manifest.tags.join(" ")}`;
    return (
      (filter === "all" || plugin.origin === filter) &&
      text.toLowerCase().includes(query.trim().toLowerCase())
    );
  });

  const inspect = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const selected = await api.pickPluginZip();
      if (!selected.ok) {
        if (selected.reason !== "cancelled") throw new Error(selected.error ?? "ZIP unavailable.");
        return;
      }
      setInspection(await api.inspectPluginZip(selected.path!));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    const api = desktopApi();
    if (api === undefined || inspection === null) return;
    setBusy(true);
    setError(null);
    try {
      const plugin = await api.importPluginZip({
        sourcePath: inspection.sourcePath,
        expectedHash: inspection.contentHash,
      });
      props.onChanged(plugin);
      setInspection(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="capability-directory plugin-directory">
      <header className="studio-heading capability-heading">
        <div>
          <h1>Plugins</h1>
          <p>Install reusable Expert extensions and configure their Desktop defaults.</p>
        </div>
        <button
          className="primary-button"
          type="button"
          disabled={busy}
          onClick={() => void inspect()}
        >
          <UploadSimple size={17} /> {busy ? "Checking…" : "Import ZIP"}
        </button>
      </header>
      <div className="capability-controls">
        <label className="directory-search">
          <MagnifyingGlass size={18} />
          <span className="sr-only">Search plugins</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search plugins"
          />
        </label>
        <div className="capability-filters" aria-label="Plugin origin">
          {(["all", "built_in", "user"] as const).map((value) => (
            <button
              key={value}
              className={filter === value ? "is-active" : ""}
              type="button"
              onClick={() => setFilter(value)}
            >
              {value === "built_in" ? "Built-in" : value === "user" ? "Imported" : "All"}
            </button>
          ))}
        </div>
      </div>
      <div className="capability-table" role="list">
        <div className="capability-table-heading" aria-hidden="true">
          <span>Name</span>
          <span>Origin</span>
          <span>Version / ID</span>
          <span>Status</span>
          <span />
        </div>
        {matching.map((plugin) => (
          <button
            className="capability-row capability-open-button"
            type="button"
            role="listitem"
            key={plugin.ref}
            onClick={() => props.onOpen(plugin)}
          >
            <span className="capability-name">
              <span className="studio-asset-icon">
                <PuzzlePiece size={20} />
              </span>
              <span>
                <strong>{plugin.manifest.name}</strong>
                <small>{plugin.manifest.description}</small>
              </span>
            </span>
            <span className="capability-type">
              {plugin.origin === "built_in" ? "Built-in" : "Imported"}
            </span>
            <span className="capability-source">
              <code>{plugin.manifest.version}</code>
              <small>{plugin.manifest.id}</small>
            </span>
            <span className="capability-status">
              <i className={plugin.status === "ready" ? "is-ready" : "is-warning"} />
              {plugin.status === "ready" ? "Ready" : "Needs attention"}
            </span>
            <span>Open</span>
          </button>
        ))}
        {matching.length === 0 ? (
          <p className="capability-empty">No plugins match this view.</p>
        ) : null}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {inspection !== null ? (
        <div className="capability-confirm-backdrop" role="presentation">
          <section
            className="capability-confirm-dialog plugin-import-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="plugin-import-title"
          >
            <button
              className="plugin-dialog-close"
              type="button"
              aria-label="Close"
              onClick={() => setInspection(null)}
            >
              <X size={18} />
            </button>
            <Package size={30} />
            <h2 id="plugin-import-title">Import {inspection.manifest.name}?</h2>
            <p>{inspection.manifest.description}</p>
            <dl>
              <div>
                <dt>Version</dt>
                <dd>{inspection.manifest.version}</dd>
              </div>
              <div>
                <dt>Package</dt>
                <dd>
                  {inspection.fileCount} files · {(inspection.unpackedBytes / 1024).toFixed(1)} KiB
                </dd>
              </div>
              <div>
                <dt>SHA-256</dt>
                <dd>
                  <code>{inspection.contentHash}</code>
                </dd>
              </div>
            </dl>
            <PermissionSummary plugin={inspection} />
            <p className="plugin-trust-warning" role="note">
              This plugin runs trusted code inside Pragma Desktop. Declared permissions are for
              review and audit only; they are not a sandbox or an enforced access boundary.
            </p>
            <footer>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setInspection(null)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={busy}
                onClick={() => void install()}
              >
                <ShieldCheck size={17} /> Trust code and import
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}

export function PluginDetailFragment(props: {
  readonly plugin: DesktopPlugin;
  readonly onBack: () => void;
  readonly onChanged: (plugin: DesktopPlugin) => void;
  readonly onDeleted: (ref: string) => void;
}) {
  const [config, setConfig] = useState<Record<string, unknown>>(props.plugin.defaultConfig);
  const [secrets, setSecrets] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    setBusy(true);
    setError(null);
    try {
      props.onChanged(await api.updatePluginDefaults({ ref: props.plugin.ref, config, secrets }));
      setSecrets({});
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await api.deletePlugin(props.plugin.ref);
      props.onDeleted(props.plugin.ref);
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };
  return (
    <section className="capability-detail plugin-detail">
      <button className="back-link" type="button" onClick={props.onBack}>
        <ArrowLeft size={18} /> Back to Plugins
      </button>
      <header className="capability-detail-header">
        <span className="expert-avatar">
          <PuzzlePiece size={40} />
        </span>
        <div className="capability-detail-title">
          <div>
            <h1>{props.plugin.manifest.name}</h1>
            <span className="capability-type">
              {props.plugin.origin === "built_in" ? "Built-in" : "Imported"}
            </span>
            <span className="version-label">{props.plugin.manifest.version}</span>
          </div>
          <p>{props.plugin.manifest.description}</p>
        </div>
        {props.plugin.origin === "user" ? (
          <button
            className="secondary-button danger-button"
            type="button"
            disabled={busy}
            onClick={() => void remove()}
          >
            <Trash size={17} /> Delete
          </button>
        ) : null}
      </header>
      <section className="capability-detail-meta">
        <div>
          <h2>Status</h2>
          <p className="capability-status">
            <i className={props.plugin.status === "ready" ? "is-ready" : "is-warning"} />
            {props.plugin.status === "ready" ? "Ready" : "Needs attention"}
          </p>
        </div>
        <div>
          <h2>Reference</h2>
          <p>
            <code>{props.plugin.ref}</code>
          </p>
        </div>
        <div>
          <h2>Capabilities</h2>
          <p>{props.plugin.manifest.capabilities.length}</p>
        </div>
        <div>
          <h2>Package hash</h2>
          <p>
            <code>{props.plugin.contentHash.slice(0, 16)}…</code>
          </p>
        </div>
      </section>
      {props.plugin.diagnostic ? (
        <p className="capability-diagnostic">{props.plugin.diagnostic}</p>
      ) : null}
      <section className="plugin-detail-section">
        <header>
          <div>
            <h2>Default configuration</h2>
            <p>Experts inherit these values unless they define an override.</p>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save defaults"}
          </button>
        </header>
        <PluginConfigFields
          manifest={props.plugin.manifest}
          values={config}
          allowInherit
          configuredSecrets={
            new Set([
              ...props.plugin.configuredSecrets.filter((path) => secrets[path] !== null),
              ...Object.keys(secrets).filter((key) => secrets[key] !== null),
            ])
          }
          onValuesChange={setConfig}
          onSecretChange={(path, value) => setSecrets((current) => ({ ...current, [path]: value }))}
        />
      </section>
      <section className="plugin-detail-section">
        <h2>Declared permissions</h2>
        <p>
          Advisory only. This trusted-host plugin executes with the Desktop process permissions.
        </p>
        <PermissionLists permissions={props.plugin.manifest.permissions} />
      </section>
      <section className="plugin-detail-section">
        <h2>Contributed capabilities</h2>
        <ul>
          {props.plugin.manifest.capabilities.map((capability) => (
            <li key={`${capability.type}:${capability.name}`}>
              <strong>{capability.name}</strong>
              <span>{capability.type}</span>
              <p>{capability.description}</p>
            </li>
          ))}
        </ul>
      </section>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function PermissionSummary(props: { readonly plugin: PluginZipInspection }) {
  return (
    <section className="plugin-permission-summary">
      <h3>
        <ShieldCheck size={18} /> Declared permissions
      </h3>
      <PermissionLists permissions={props.plugin.manifest.permissions} />
    </section>
  );
}

function PermissionLists(props: {
  readonly permissions: DesktopPlugin["manifest"]["permissions"];
}) {
  const groups = Object.entries(props.permissions);
  return (
    <div className="plugin-permission-grid">
      {groups.map(([name, values]) => (
        <div key={name}>
          <strong>{name}</strong>
          {values.length === 0 ? (
            <span>None</span>
          ) : (
            <ul>
              {values.map((value) => (
                <li key={value}>{value}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
