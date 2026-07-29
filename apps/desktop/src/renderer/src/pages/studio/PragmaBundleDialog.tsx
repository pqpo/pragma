import {
  Archive,
  CaretDown,
  Check,
  DownloadSimple,
  GitBranch,
  MagnifyingGlass,
  UploadSimple,
  User,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import { canonicalPragmaResourceRef } from "@pragma/interpreter/ast";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  Capability,
  ContextStore,
  DesktopRuntimeAvailability,
  PragmaBundleImportInspection,
  PragmaBundleInstallation,
  PragmaBundleModuleOptions,
  PragmaProjectSnapshot,
} from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { desktopApi } from "./studio-model.ts";

type BundleMode = "export" | "import";
type BundleExportRoot = Extract<
  PragmaProjectSnapshot["resources"][number],
  { kind: "Expert" | "ExpertTeam" | "Flow" }
>;

const BUNDLE_EXPORT_ROOT_LIMIT = 5;
const bundleExportRootCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function isBundleExportRoot(
  resource: PragmaProjectSnapshot["resources"][number],
): resource is BundleExportRoot {
  return resource.kind === "Expert" || resource.kind === "ExpertTeam" || resource.kind === "Flow";
}

function compareBundleExportRoots(left: BundleExportRoot, right: BundleExportRoot): number {
  return (
    bundleExportRootCollator.compare(left.metadata.name, right.metadata.name) ||
    bundleExportRootCollator.compare(left.kind, right.kind) ||
    bundleExportRootCollator.compare(
      canonicalPragmaResourceRef(left),
      canonicalPragmaResourceRef(right),
    )
  );
}

export function orderBundleExportRoots(
  roots: readonly BundleExportRoot[],
): readonly BundleExportRoot[] {
  return [...roots].sort(compareBundleExportRoots);
}

export function filterBundleExportRoots(
  roots: readonly BundleExportRoot[],
  query: string,
  kindLabel: (kind: BundleExportRoot["kind"]) => string = (kind) => kind,
): {
  readonly items: readonly BundleExportRoot[];
  readonly matchCount: number;
} {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = roots.filter((resource) => {
    if (normalizedQuery === "") return true;
    return [
      resource.metadata.name,
      resource.metadata.description,
      resource.metadata.tags.join(" "),
      canonicalPragmaResourceRef(resource),
      resource.kind,
      kindLabel(resource.kind),
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
  return {
    items: matches.slice(0, BUNDLE_EXPORT_ROOT_LIMIT),
    matchCount: matches.length,
  };
}

export function PragmaBundleDialog(props: {
  readonly initialMode: BundleMode;
  readonly project: PragmaProjectSnapshot;
  readonly capabilities: readonly Capability[];
  readonly contextStores: readonly ContextStore[];
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly onClose: () => void;
  readonly onChanged: () => void | Promise<void>;
}) {
  const { t } = useTranslation("studio");
  const [mode, setMode] = useState<BundleMode>(props.initialMode);
  const [rootRef, setRootRef] = useState("");
  const [modules, setModules] = useState<PragmaBundleModuleOptions>({
    capabilities: true,
    plugins: true,
    knowledgeBases: false,
    flowLayouts: true,
  });
  const [inspection, setInspection] = useState<PragmaBundleImportInspection | null>(null);
  const [installation, setInstallation] = useState<PragmaBundleInstallation | null>(null);
  const [conflictMode, setConflictMode] = useState<"update" | "copy" | "">("");
  const [runtimeBindings, setRuntimeBindings] = useState<Record<string, string>>({});
  const [capabilityBindings, setCapabilityBindings] = useState<Record<string, string>>({});
  const [contextBindings, setContextBindings] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [resultPath, setResultPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roots = useMemo(
    () => orderBundleExportRoots(props.project.resources.filter(isBundleExportRoot)),
    [props.project.resources],
  );

  useEffect(() => {
    if (rootRef === "" && roots[0] !== undefined) {
      setRootRef(canonicalPragmaResourceRef(roots[0]));
    }
  }, [rootRef, roots]);

  useEffect(() => {
    if (mode !== "import" || inspection !== null || installation !== null) return;
    const api = desktopApi();
    if (api === undefined) return;
    let active = true;
    void api
      .listPragmaBundleInstallations()
      .then((installations) => {
        const recoverable = installations.find(
          (candidate) => candidate.status === "needs_setup" || candidate.status === "failed",
        );
        if (active && recoverable !== undefined) setInstallation(recoverable);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [inspection, installation, mode]);

  const resetBindings = () => {
    setRuntimeBindings({});
    setCapabilityBindings({});
    setContextBindings({});
    setSecrets({});
  };

  const selectBundle = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const picked = await api.pickPragmaBundle();
      if (picked.cancelled || picked.path === undefined) return;
      const nextInspection = await api.inspectPragmaBundle({ sourcePath: picked.path });
      setInspection(nextInspection);
      const installations =
        nextInspection.alreadyInstalledId === undefined
          ? []
          : await api.listPragmaBundleInstallations();
      setInstallation(
        installations.find((candidate) => candidate.id === nextInspection.alreadyInstalledId) ??
          null,
      );
      resetBindings();
      setConflictMode("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const discardInstallation = async () => {
    const api = desktopApi();
    if (api === undefined || installation === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.discardPragmaBundleInstallation({ installationId: installation.id });
      setInstallation(null);
      setInspection(null);
      resetBindings();
      await props.onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const exportBundle = async () => {
    const api = desktopApi();
    if (api === undefined || rootRef === "") return;
    setBusy(true);
    setError(null);
    setResultPath(null);
    try {
      const result = await api.exportPragmaBundle({
        rootRef,
        projectRevision: props.project.revision,
        modules,
      });
      if (!result.cancelled) setResultPath(result.path ?? null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const importBundle = async () => {
    const api = desktopApi();
    if (api === undefined || inspection === null) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.importPragmaBundle({
        sourcePath: inspection.sourcePath,
        expectedFingerprint: inspection.bundleFingerprint,
        ...(inspection.conflicts.length === 0 || conflictMode === "" ? {} : { conflictMode }),
      });
      setInstallation(next);
      await props.onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveBindings = async () => {
    const api = desktopApi();
    if (api === undefined || installation === null) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.resolvePragmaBundleInstallation({
        installationId: installation.id,
        baseRevision: installation.projectRevision,
        runtimes: Object.entries(runtimeBindings).flatMap(([resourceRef, value]) => {
          if (value === "") return [];
          const parsed = JSON.parse(value) as {
            runtimeId: string;
            providerId: string;
            modelId: string;
          };
          return [{ resourceRef, ...parsed }];
        }),
        capabilities: Object.entries(capabilityBindings).flatMap(([resourceRef, value]) => {
          if (value === "") return [];
          const [capabilityId, revision] = value.split("@");
          return capabilityId === undefined || revision === undefined
            ? []
            : [{ resourceRef, capabilityId, revision: Number(revision) }];
        }),
        contextStores: Object.entries(contextBindings).flatMap(([resourceRef, storeId]) =>
          storeId === "" ? [] : [{ resourceRef, storeId }],
        ),
        secrets: Object.fromEntries(
          Object.entries(secrets)
            .filter(([, value]) => value.trim() !== "")
            .map(([id, value]) => [id.replace(/^secret:/, ""), value]),
        ),
      });
      setInstallation(next);
      await props.onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="capability-confirm-backdrop pragma-bundle-backdrop">
      <section
        className="pragma-bundle-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pragma-bundle-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) props.onClose();
        }}
      >
        <header>
          <div>
            <span className="pragma-bundle-eyebrow">
              <Archive size={17} aria-hidden="true" /> {t("bundlePortable")}
            </span>
            <h2 id="pragma-bundle-title">
              {mode === "export" ? t("bundleExportTitle") : t("bundleImportTitle")}
            </h2>
            <p>{mode === "export" ? t("bundleExportDescription") : t("bundleImportDescription")}</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={t("close")}
            disabled={busy}
            onClick={props.onClose}
          >
            <X size={20} />
          </button>
        </header>

        <div className="pragma-bundle-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "export"}
            onClick={() => setMode("export")}
          >
            <UploadSimple size={17} /> {t("exportBundle")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "import"}
            onClick={() => setMode("import")}
          >
            <DownloadSimple size={17} /> {t("importBundle")}
          </button>
        </div>

        <div className="pragma-bundle-body">
          {mode === "export" ? (
            <>
              <BundleExportRootPicker roots={roots} value={rootRef} onChange={setRootRef} />
              <fieldset className="pragma-bundle-modules">
                <legend>{t("bundleModules")}</legend>
                <BundleToggle
                  label={t("bundleCapabilities")}
                  description={t("bundleCapabilitiesHint")}
                  checked={modules.capabilities}
                  onChange={(capabilities) => setModules({ ...modules, capabilities })}
                />
                <BundleToggle
                  label={t("bundlePlugins")}
                  description={t("bundlePluginsHint")}
                  checked={modules.plugins}
                  onChange={(plugins) => setModules({ ...modules, plugins })}
                />
                <BundleToggle
                  label={t("bundleKnowledgeBases")}
                  description={t("bundleKnowledgeBasesHint")}
                  checked={modules.knowledgeBases}
                  onChange={(knowledgeBases) => setModules({ ...modules, knowledgeBases })}
                />
                <BundleToggle
                  label={t("bundleFlowLayouts")}
                  description={t("bundleFlowLayoutsHint")}
                  checked={modules.flowLayouts}
                  onChange={(flowLayouts) => setModules({ ...modules, flowLayouts })}
                />
              </fieldset>
              <p className="pragma-bundle-safety">{t("bundleSafetyHint")}</p>
              {resultPath ? (
                <p className="pragma-bundle-success" role="status">
                  {t("bundleExported", { path: resultPath })}
                </p>
              ) : null}
            </>
          ) : (
            <>
              {inspection === null ? (
                <button
                  className="pragma-bundle-dropzone"
                  type="button"
                  disabled={busy}
                  onClick={() => void selectBundle()}
                >
                  <Archive size={30} />
                  <strong>{t("bundleChooseFile")}</strong>
                  <span>{t("bundleChooseFileHint")}</span>
                </button>
              ) : (
                <BundleInspection
                  inspection={inspection}
                  conflictMode={conflictMode}
                  onConflictMode={setConflictMode}
                  onChooseAnother={() => void selectBundle()}
                />
              )}
              {installation !== null ? (
                <BundleSetup
                  installation={installation}
                  capabilities={props.capabilities}
                  contextStores={props.contextStores}
                  runtimes={props.runtimes}
                  runtimeBindings={runtimeBindings}
                  capabilityBindings={capabilityBindings}
                  contextBindings={contextBindings}
                  secrets={secrets}
                  onRuntime={(ref, value) =>
                    setRuntimeBindings((current) => ({ ...current, [ref]: value }))
                  }
                  onCapability={(ref, value) =>
                    setCapabilityBindings((current) => ({ ...current, [ref]: value }))
                  }
                  onContext={(ref, value) =>
                    setContextBindings((current) => ({ ...current, [ref]: value }))
                  }
                  onSecret={(id, value) => setSecrets((current) => ({ ...current, [id]: value }))}
                />
              ) : null}
            </>
          )}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer>
          {mode === "import" &&
          installation !== null &&
          installation.status !== "ready" &&
          installation.createdResourceRefs.length === installation.resourceRefs.length ? (
            <button
              className="secondary-button danger-button"
              type="button"
              disabled={busy}
              onClick={() => void discardInstallation()}
            >
              {t("bundleDiscardImport")}
            </button>
          ) : null}
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={props.onClose}
          >
            {installation?.status === "ready" ? t("done") : t("cancel")}
          </button>
          {mode === "export" ? (
            <button
              className="primary-button"
              type="button"
              disabled={busy || rootRef === ""}
              onClick={() => void exportBundle()}
            >
              <UploadSimple size={17} />
              {busy ? t("bundleExporting") : t("exportBundle")}
            </button>
          ) : installation === null ? (
            <button
              className="primary-button"
              type="button"
              disabled={
                busy ||
                inspection === null ||
                (inspection.conflicts.length > 0 && conflictMode === "")
              }
              onClick={() => void importBundle()}
            >
              <DownloadSimple size={17} />
              {busy ? t("bundleImporting") : t("bundleImportAction")}
            </button>
          ) : installation.status === "needs_setup" ? (
            <button
              className="primary-button"
              type="button"
              disabled={busy}
              onClick={() => void saveBindings()}
            >
              {busy ? t("bundleSavingBindings") : t("bundleSaveBindings")}
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

function BundleExportRootPicker(props: {
  readonly roots: readonly BundleExportRoot[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useTranslation("studio");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const selected = props.roots.find(
    (resource) => canonicalPragmaResourceRef(resource) === props.value,
  );
  const kindLabel = (kind: BundleExportRoot["kind"]): string =>
    kind === "Expert"
      ? t("bundleRootExpert")
      : kind === "ExpertTeam"
        ? t("bundleRootExpertTeam")
        : t("bundleRootFlow");
  const filtered = filterBundleExportRoots(props.roots, search, kindLabel);
  const hiddenCount = filtered.matchCount - filtered.items.length;
  const SelectedIcon = selected === undefined ? Archive : bundleRootIcon(selected.kind);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [open]);

  return (
    <div className="pragma-bundle-field">
      <span>{t("bundleExportObject")}</span>
      <div
        className={open ? "pragma-bundle-root-picker is-open" : "pragma-bundle-root-picker"}
        ref={pickerRef}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !open) return;
          event.stopPropagation();
          setOpen(false);
          setSearch("");
          triggerRef.current?.focus();
        }}
      >
        <button
          className="pragma-bundle-root-trigger"
          type="button"
          ref={triggerRef}
          aria-expanded={open}
          aria-haspopup="dialog"
          disabled={props.roots.length === 0}
          onClick={() => {
            setOpen((current) => !current);
            setSearch("");
          }}
        >
          <span className="pragma-bundle-root-icon">
            <SelectedIcon size={18} aria-hidden="true" />
          </span>
          <span>
            <strong>{selected?.metadata.name ?? t("bundleNoExportObjects")}</strong>
            <small>
              {selected === undefined
                ? t("bundleNoExportObjectsHint")
                : `${kindLabel(selected.kind)} · ${canonicalPragmaResourceRef(selected)}`}
            </small>
          </span>
          <CaretDown size={15} aria-hidden="true" />
        </button>

        {open ? (
          <div
            className="pragma-bundle-root-menu"
            role="dialog"
            aria-modal="false"
            aria-label={t("bundleChooseExportObject")}
          >
            <header>
              <small>{t("bundleChooseExportObject")}</small>
              <span>{t("bundleAvailableObjects", { count: props.roots.length })}</span>
            </header>
            <label className="pragma-bundle-root-search">
              <MagnifyingGlass size={17} aria-hidden="true" />
              <span className="sr-only">{t("bundleSearchExportObjects")}</span>
              <input
                autoFocus
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("bundleSearchExportObjects")}
              />
            </label>
            <div className="pragma-bundle-root-options" aria-label={t("bundleExportObjects")}>
              {filtered.items.length === 0 ? (
                <p className="pragma-bundle-root-empty">
                  <strong>{t("bundleNoExportObjectMatches")}</strong>
                  <span>{t("bundleTryAnotherSearch")}</span>
                </p>
              ) : null}
              {filtered.items.map((resource) => {
                const ref = canonicalPragmaResourceRef(resource);
                const RootIcon = bundleRootIcon(resource.kind);
                const isSelected = ref === props.value;
                return (
                  <button
                    className={
                      isSelected
                        ? "pragma-bundle-root-option is-selected"
                        : "pragma-bundle-root-option"
                    }
                    type="button"
                    aria-pressed={isSelected}
                    key={ref}
                    onClick={() => {
                      props.onChange(ref);
                      setOpen(false);
                      setSearch("");
                      triggerRef.current?.focus();
                    }}
                  >
                    <span className="pragma-bundle-root-icon">
                      <RootIcon size={18} aria-hidden="true" />
                    </span>
                    <span>
                      <strong>{resource.metadata.name}</strong>
                      <small>{resource.metadata.description}</small>
                    </span>
                    <span className="pragma-bundle-root-meta">
                      <Check
                        className={isSelected ? "is-visible" : undefined}
                        size={16}
                        aria-hidden="true"
                      />
                      <span>{kindLabel(resource.kind)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {hiddenCount > 0 ? (
              <p className="pragma-bundle-root-more">
                {t("bundleMoreObjectsHidden", { count: hiddenCount })}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function bundleRootIcon(kind: BundleExportRoot["kind"]) {
  return kind === "Expert" ? User : kind === "ExpertTeam" ? UsersThree : GitBranch;
}

function BundleToggle(props: {
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label>
      <span>
        <strong>{props.label}</strong>
        <small>{props.description}</small>
      </span>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
      />
    </label>
  );
}

function BundleInspection(props: {
  readonly inspection: PragmaBundleImportInspection;
  readonly conflictMode: "update" | "copy" | "";
  readonly onConflictMode: (mode: "update" | "copy") => void;
  readonly onChooseAnother: () => void;
}) {
  const { t } = useTranslation("studio");
  return (
    <div className="pragma-bundle-inspection">
      <div>
        <strong>{props.inspection.root.name}</strong>
        <span>
          {props.inspection.root.kind} ·{" "}
          {t("bundleResourceCount", { count: props.inspection.resources })}
        </span>
        <button type="button" onClick={props.onChooseAnother}>
          {t("bundleChooseAnother")}
        </button>
      </div>
      <ul>
        {props.inspection.dependencies.map((dependency) => (
          <li key={`${dependency.kind}:${dependency.ref}`}>
            <span>{dependency.name}</span>
            <em>{dependency.included ? t("bundleIncluded") : t("bundleNeedsBinding")}</em>
          </li>
        ))}
      </ul>
      {props.inspection.conflicts.length > 0 ? (
        <fieldset className="pragma-bundle-conflicts">
          <legend>{t("bundleConflicts", { count: props.inspection.conflicts.length })}</legend>
          <label>
            <input
              type="radio"
              name="bundle-conflict"
              checked={props.conflictMode === "copy"}
              onChange={() => props.onConflictMode("copy")}
            />
            <span>
              <strong>{t("bundleImportCopy")}</strong>
              <small>{t("bundleImportCopyHint")}</small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="bundle-conflict"
              checked={props.conflictMode === "update"}
              onChange={() => props.onConflictMode("update")}
            />
            <span>
              <strong>{t("bundleUpdateExisting")}</strong>
              <small>{t("bundleUpdateExistingHint")}</small>
            </span>
          </label>
        </fieldset>
      ) : null}
    </div>
  );
}

function BundleSetup(props: {
  readonly installation: PragmaBundleInstallation;
  readonly capabilities: readonly Capability[];
  readonly contextStores: readonly ContextStore[];
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly runtimeBindings: Readonly<Record<string, string>>;
  readonly capabilityBindings: Readonly<Record<string, string>>;
  readonly contextBindings: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly onRuntime: (ref: string, value: string) => void;
  readonly onCapability: (ref: string, value: string) => void;
  readonly onContext: (ref: string, value: string) => void;
  readonly onSecret: (id: string, value: string) => void;
}) {
  const { t } = useTranslation("studio");
  if (props.installation.status === "ready") {
    return (
      <p className="pragma-bundle-success">
        {t("bundleReady", { name: props.installation.rootName })}
      </p>
    );
  }
  if (props.installation.status === "failed") {
    return <p className="form-error">{props.installation.error ?? t("bundleImportFailed")}</p>;
  }
  return (
    <section className="pragma-bundle-setup">
      <h3>{t("bundleSetupTitle")}</h3>
      <p>{t("bundleSetupDescription")}</p>
      {props.installation.pending.map((dependency) => (
        <label key={dependency.id} className="pragma-bundle-field">
          <span>
            <strong>{dependency.name}</strong>
            <small>{dependency.message}</small>
          </span>
          {dependency.kind === "runtime" ? (
            <select
              value={props.runtimeBindings[dependency.resourceRef] ?? ""}
              onChange={(event) => props.onRuntime(dependency.resourceRef, event.target.value)}
            >
              <option value="">{t("bundleChooseRuntime")}</option>
              {props.runtimes.flatMap((runtime) =>
                runtime.status !== "available"
                  ? []
                  : (runtime.models ?? []).map((model) => (
                      <option
                        key={`${runtime.id}:${model.provider.id}:${model.id}`}
                        value={JSON.stringify({
                          runtimeId: runtime.id,
                          providerId: model.provider.id,
                          modelId: model.id,
                        })}
                      >
                        {runtime.displayName} · {model.displayName}
                      </option>
                    )),
              )}
            </select>
          ) : dependency.kind === "capability" ? (
            <select
              value={props.capabilityBindings[dependency.resourceRef] ?? ""}
              onChange={(event) => props.onCapability(dependency.resourceRef, event.target.value)}
            >
              <option value="">{t("bundleChooseCapability")}</option>
              {props.capabilities
                .filter(
                  (capability) =>
                    dependency.capabilityKind === undefined ||
                    capability.definition.kind === dependency.capabilityKind,
                )
                .map((capability) => (
                  <option
                    key={capability.manifest.id}
                    value={`${capability.manifest.id}@${capability.manifest.latestRevision}`}
                  >
                    {capability.manifest.name}
                  </option>
                ))}
            </select>
          ) : dependency.kind === "context-store" ? (
            <select
              value={props.contextBindings[dependency.resourceRef] ?? ""}
              onChange={(event) => props.onContext(dependency.resourceRef, event.target.value)}
            >
              <option value="">{t("bundleChooseKnowledgeBase")}</option>
              {props.contextStores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          ) : dependency.kind === "secret" ? (
            <input
              type="password"
              autoComplete="off"
              value={props.secrets[dependency.id] ?? ""}
              placeholder={t("bundleEnterSecret")}
              onChange={(event) => props.onSecret(dependency.id, event.target.value)}
            />
          ) : (
            <span className="pragma-bundle-manual">{t("bundleInstallPluginManually")}</span>
          )}
        </label>
      ))}
    </section>
  );
}
