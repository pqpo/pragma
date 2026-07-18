import {
  ArrowLeft,
  Lightning,
  MagnifyingGlass,
  Package,
  PuzzlePiece,
  ShieldCheck,
  Trash,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { DesktopPlugin, PluginZipInspection } from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";
import { PluginConfigFields } from "./PluginConfigFields.tsx";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

type PluginFilter = "all" | "built_in" | "user";

export function PluginDirectoryFragment(props: {
  readonly plugins: readonly DesktopPlugin[];
  readonly onOpen: (plugin: DesktopPlugin) => void;
  readonly onChanged: (plugin: DesktopPlugin) => void;
}) {
  const { t } = useTranslation("studio");
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
    <StudioScreenFrame
      className="capability-directory plugin-directory"
      labelledBy="plugins-heading"
      header={
        <header className="studio-heading capability-heading">
          <div>
            <h1 id="plugins-heading">{t("plugins")}</h1>
            <p>{t("pluginsDescription")}</p>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={busy}
            onClick={() => void inspect()}
          >
            <UploadSimple size={17} /> {busy ? t("checking") : t("importZip")}
          </button>
        </header>
      }
    >
      <div className="capability-controls">
        <label className="directory-search">
          <MagnifyingGlass size={18} />
          <span className="sr-only">{t("searchPlugins")}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("searchPlugins")}
          />
        </label>
        <div className="capability-filters" aria-label={t("pluginOrigin")}>
          {(["all", "built_in", "user"] as const).map((value) => (
            <button
              key={value}
              className={filter === value ? "is-active" : ""}
              type="button"
              onClick={() => setFilter(value)}
            >
              {value === "built_in" ? t("builtIn") : value === "user" ? t("imported") : t("all")}
            </button>
          ))}
        </div>
      </div>
      <div className="capability-table" role="list">
        <div className="capability-table-heading" aria-hidden="true">
          <span className="plugin-column-name">{t("name")}</span>
          <span className="plugin-column-origin">{t("origin")}</span>
          <span className="plugin-column-version">{t("version")}</span>
          <span className="plugin-column-status">{t("status")}</span>
        </div>
        {matching.map((plugin) => (
          <button
            className="capability-row capability-open-button"
            type="button"
            role="listitem"
            key={plugin.ref}
            onClick={() => props.onOpen(plugin)}
          >
            <span className="capability-name plugin-column-name">
              <span className="studio-asset-icon">
                <PuzzlePiece size={20} />
              </span>
              <span>
                <strong>{plugin.manifest.name}</strong>
                <small>{plugin.manifest.description}</small>
              </span>
            </span>
            <span className="capability-type plugin-column-origin">
              {plugin.origin === "built_in" ? t("builtIn") : t("imported")}
            </span>
            <span className="capability-source plugin-column-version">
              <code>{plugin.manifest.version}</code>
            </span>
            <span className="capability-status plugin-column-status">
              <i className={plugin.status === "ready" ? "is-ready" : "is-warning"} />
              {plugin.status === "ready" ? t("ready") : t("needsAttention")}
            </span>
          </button>
        ))}
        {matching.length === 0 ? <p className="capability-empty">{t("noPlugins")}</p> : null}
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
              aria-label={t("close")}
              onClick={() => setInspection(null)}
            >
              <X size={18} />
            </button>
            <Package size={30} />
            <h2 id="plugin-import-title">
              {t("importPlugin", { name: inspection.manifest.name })}
            </h2>
            <p>{inspection.manifest.description}</p>
            <dl>
              <div>
                <dt>{t("version")}</dt>
                <dd>{inspection.manifest.version}</dd>
              </div>
              <div>
                <dt>{t("package")}</dt>
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
              {t("trustPluginWarning")}
            </p>
            <footer>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setInspection(null)}
              >
                {t("cancel")}
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={busy}
                onClick={() => void install()}
              >
                <ShieldCheck size={17} /> {t("trustAndImport")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </StudioScreenFrame>
  );
}

export function PluginDetailFragment(props: {
  readonly plugin: DesktopPlugin;
  readonly onBack: () => void;
  readonly onChanged: (plugin: DesktopPlugin) => void;
  readonly onDeleted: (ref: string) => void;
}) {
  const { t } = useTranslation("studio");
  const declaredPermissionCount = Object.values(props.plugin.manifest.permissions).reduce(
    (count, permissions) => count + permissions.length,
    0,
  );
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
    <StudioScreenFrame
      className="capability-detail plugin-detail"
      labelledBy="plugin-detail-name"
      header={
        <button className="back-link" type="button" onClick={props.onBack}>
          <ArrowLeft size={18} /> {t("backPlugins")}
        </button>
      }
    >
      <header className="capability-detail-header">
        <span className="expert-avatar">
          <PuzzlePiece size={40} />
        </span>
        <div className="capability-detail-title">
          <div>
            <h1 id="plugin-detail-name">{props.plugin.manifest.name}</h1>
            <span className="capability-type">
              {props.plugin.origin === "built_in" ? t("builtIn") : t("imported")}
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
            <Trash size={17} /> {t("deletePlugin")}
          </button>
        ) : null}
      </header>
      <section className="capability-detail-meta">
        <div>
          <h2>{t("status")}</h2>
          <p className="capability-status">
            <i className={props.plugin.status === "ready" ? "is-ready" : "is-warning"} />
            {props.plugin.status === "ready" ? t("ready") : t("needsAttention")}
          </p>
        </div>
        <div>
          <h2>{t("reference")}</h2>
          <p>
            <code>{props.plugin.ref}</code>
          </p>
        </div>
        <div>
          <h2>{t("capabilities")}</h2>
          <p>{props.plugin.manifest.capabilities.length}</p>
        </div>
        <div>
          <h2>{t("packageHash")}</h2>
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
            <h2>{t("defaultConfiguration")}</h2>
            <p>{t("defaultsDescription")}</p>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? t("saving") : t("saveDefaults")}
          </button>
        </header>
        <PluginConfigFields
          manifest={props.plugin.manifest}
          values={config}
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
      <section className="plugin-detail-section plugin-declarations">
        <header className="plugin-declarations-heading">
          <div>
            <h2>{t("pluginDeclarations")}</h2>
            <p>{t("pluginDeclarationsDescription")}</p>
          </div>
        </header>
        <div className="plugin-declaration-groups">
          <section
            className="plugin-declaration-group"
            aria-labelledby="plugin-permissions-heading"
          >
            <header>
              <span className="plugin-declaration-icon">
                <ShieldCheck size={19} />
              </span>
              <div>
                <h3 id="plugin-permissions-heading">{t("declaredPermissions")}</h3>
                <p>{t("advisoryPermissions")}</p>
              </div>
              <span className="plugin-declaration-count">
                {t("declarationItemCount", { count: declaredPermissionCount })}
              </span>
            </header>
            <PermissionLists permissions={props.plugin.manifest.permissions} structured />
          </section>
          <section
            className="plugin-declaration-group"
            aria-labelledby="plugin-capabilities-heading"
          >
            <header>
              <span className="plugin-declaration-icon">
                <Lightning size={19} />
              </span>
              <div>
                <h3 id="plugin-capabilities-heading">{t("contributedCapabilities")}</h3>
                <p>{t("contributedCapabilitiesDescription")}</p>
              </div>
              <span className="plugin-declaration-count">
                {t("declarationItemCount", {
                  count: props.plugin.manifest.capabilities.length,
                })}
              </span>
            </header>
            <div className="plugin-declaration-list">
              {props.plugin.manifest.capabilities.length === 0 ? (
                <p className="plugin-declaration-empty">{t("none")}</p>
              ) : (
                props.plugin.manifest.capabilities.map((capability) => (
                  <article
                    className="plugin-declaration-item plugin-capability-declaration"
                    key={`${capability.type}:${capability.name}`}
                  >
                    <header>
                      <strong>{capability.name}</strong>
                      <span>{capability.type}</span>
                    </header>
                    <p>{capability.description ?? t("noDescription")}</p>
                  </article>
                ))
              )}
            </div>
          </section>
        </div>
      </section>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </StudioScreenFrame>
  );
}

function PermissionSummary(props: { readonly plugin: PluginZipInspection }) {
  const { t } = useTranslation("studio");
  return (
    <section className="plugin-permission-summary">
      <h3>
        <ShieldCheck size={18} /> {t("declaredPermissions")}
      </h3>
      <PermissionLists permissions={props.plugin.manifest.permissions} />
    </section>
  );
}

function PermissionLists(props: {
  readonly permissions: DesktopPlugin["manifest"]["permissions"];
  readonly structured?: boolean;
}) {
  const { t } = useTranslation("studio");
  const groups = Object.entries(props.permissions);
  return (
    <div
      className={
        props.structured ? "plugin-permission-grid is-structured" : "plugin-permission-grid"
      }
    >
      {groups.map(([name, values]) => (
        <div key={name}>
          <header>
            <strong>{name}</strong>
            {props.structured ? (
              <span>{t("declarationItemCount", { count: values.length })}</span>
            ) : null}
          </header>
          {values.length === 0 ? (
            <span className="plugin-permission-empty">{t("none")}</span>
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
