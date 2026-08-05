import {
  Archive,
  ArrowsClockwise,
  CaretDown,
  Check,
  DownloadSimple,
  GitBranch,
  MagnifyingGlass,
  UploadSimple,
  User,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { canonicalPragmaResourceRef } from "@pragma/interpreter/ast";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";

import type {
  Capability,
  ContextStore,
  DesktopRuntimeAvailability,
  PragmaBundleImportInspection,
  PragmaBundleExportPreview,
  PragmaBundleInstallation,
  PragmaBundleModuleOptions,
  PragmaProjectSnapshot,
} from "../../../../shared/contracts/index.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { desktopApi } from "./studio-model.ts";

type BundleMode = "export" | "import";
type BundleExportRoot = Extract<
  PragmaProjectSnapshot["resources"][number],
  { kind: "Expert" | "ExpertTeam" | "Flow" }
>;
type ImportStep = "select" | "conflicts" | "bindings" | "review" | "result";
type BindingRequirement = PragmaBundleImportInspection["requirements"][number];
type RuntimeBindingDraft = {
  readonly runtimeId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly thinkingLevel?: string | undefined;
};

const bindingKindOrder: Readonly<Record<BindingRequirement["kind"], number>> = {
  runtime: 0,
  capability: 1,
  "context-store": 2,
  plugin: 3,
  secret: 4,
};

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
): readonly BundleExportRoot[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return roots.filter((resource) => {
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
}

export function PragmaBundleDialog(props: {
  readonly mode: BundleMode;
  readonly project: PragmaProjectSnapshot;
  readonly capabilities: readonly Capability[];
  readonly contextStores: readonly ContextStore[];
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly onRefreshRuntimes: () => Promise<readonly DesktopRuntimeAvailability[]>;
  readonly onClose: () => void;
  readonly onChanged: () => void | Promise<void>;
}) {
  return props.mode === "export" ? (
    <BundleExportDialog {...props} />
  ) : (
    <BundleImportDialog {...props} />
  );
}

function BundleExportDialog(props: {
  readonly project: PragmaProjectSnapshot;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation("studio");
  const [rootRef, setRootRef] = useState("");
  const [modules, setModules] = useState<PragmaBundleModuleOptions>({
    capabilities: true,
    plugins: true,
    knowledgeBases: false,
    flowLayouts: true,
  });
  const [resultPath, setResultPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<PragmaBundleExportPreview | null>(null);
  const [knowledgeRevisionRefs, setKnowledgeRevisionRefs] = useState<
    { id: string; revision: number }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roots = useMemo(
    () => orderBundleExportRoots(props.project.resources.filter(isBundleExportRoot)),
    [props.project.resources],
  );

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined || rootRef === "") {
      setPreview(null);
      setKnowledgeRevisionRefs([]);
      return;
    }
    let active = true;
    void api
      .preparePragmaBundleExport({
        rootRef,
        projectRevision: props.project.revision,
      })
      .then((value) => {
        if (!active) return;
        setPreview(value);
        setKnowledgeRevisionRefs([]);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [props.project.revision, rootRef]);

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
        knowledgeRevisionRefs,
      });
      if (!result.cancelled) setResultPath(result.path ?? null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <BundleDialogShell
      title={t("bundleExportTitle")}
      description={t("bundleExportDescription")}
      busy={busy}
      onClose={props.onClose}
      footer={
        <>
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={props.onClose}
          >
            {t("cancel")}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy || rootRef === ""}
            onClick={() => void exportBundle()}
          >
            <UploadSimple size={17} />
            {busy ? t("bundleExporting") : t("exportBundle")}
          </button>
        </>
      }
    >
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
      {preview !== null && preview.knowledge.length > 0 ? (
        <fieldset className="pragma-bundle-modules">
          <legend>{t("bundleKnowledgeMemory")}</legend>
          <p>{t("bundleKnowledgeMemoryHint")}</p>
          {preview.knowledge.map((knowledge) => {
            const selected = knowledgeRevisionRefs.some(
              (ref) => ref.id === knowledge.id && ref.revision === knowledge.revision,
            );
            return (
              <label key={`${knowledge.id}:${knowledge.revision}`}>
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(event) =>
                    setKnowledgeRevisionRefs((current) =>
                      event.target.checked
                        ? [...current, { id: knowledge.id, revision: knowledge.revision }]
                        : current.filter(
                            (ref) => ref.id !== knowledge.id || ref.revision !== knowledge.revision,
                          ),
                    )
                  }
                />{" "}
                <strong>{knowledge.title}</strong> — {knowledge.summary}
              </label>
            );
          })}
        </fieldset>
      ) : null}
      <p className="pragma-bundle-safety">{t("bundleSafetyHint")}</p>
      {resultPath ? (
        <p className="pragma-bundle-success" role="status">
          {t("bundleExported", { path: resultPath })}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </BundleDialogShell>
  );
}

function BundleImportDialog(props: {
  readonly capabilities: readonly Capability[];
  readonly contextStores: readonly ContextStore[];
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly onRefreshRuntimes: () => Promise<readonly DesktopRuntimeAvailability[]>;
  readonly onClose: () => void;
  readonly onChanged: () => void | Promise<void>;
}) {
  const { t } = useTranslation("studio");
  const [step, setStep] = useState<ImportStep>("select");
  const [inspection, setInspection] = useState<PragmaBundleImportInspection | null>(null);
  const [conflicts, setConflicts] = useState<Record<string, "copy" | "update">>({});
  const [bindingIndex, setBindingIndex] = useState(0);
  const [runtimeBindings, setRuntimeBindings] = useState<Record<string, RuntimeBindingDraft>>({});
  const [capabilityBindings, setCapabilityBindings] = useState<Record<string, string>>({});
  const [contextBindings, setContextBindings] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [recovery, setRecovery] = useState<PragmaBundleInstallation | null>(null);
  const [installation, setInstallation] = useState<PragmaBundleInstallation | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshingRuntimes, setRefreshingRuntimes] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);

  const requirements = useMemo(() => {
    const values =
      recovery === null
        ? (inspection?.requirements ?? [])
        : recovery.pending.map((pending): BindingRequirement => {
            const sourceRef =
              recovery.resourceMappings.find((mapping) => mapping.targetRef === pending.resourceRef)
                ?.sourceRef ?? pending.resourceRef;
            const inspected =
              inspection?.requirements.find((requirement) => requirement.id === pending.id) ??
              inspection?.requirements.find(
                (requirement) =>
                  requirement.kind === pending.kind && requirement.resourceRef === sourceRef,
              );
            return {
              id: pending.id,
              kind: pending.kind,
              resourceRef: pending.resourceRef,
              name: pending.name,
              message: pending.message,
              required: pending.kind !== "plugin",
              ...(pending.capabilityKind === undefined
                ? {}
                : { capabilityKind: pending.capabilityKind }),
              ...(inspected?.runtimeRequest === undefined
                ? {}
                : { runtimeRequest: inspected.runtimeRequest }),
            };
          });
    return [...values].sort(
      (left, right) =>
        bindingKindOrder[left.kind] - bindingKindOrder[right.kind] ||
        left.name.localeCompare(right.name),
    );
  }, [inspection, recovery]);
  const currentRequirement = requirements[bindingIndex];
  const dirty =
    inspection !== null &&
    (step !== "select" ||
      Object.keys(runtimeBindings).length > 0 ||
      Object.keys(capabilityBindings).length > 0 ||
      Object.keys(contextBindings).length > 0 ||
      Object.keys(secrets).length > 0);

  const close = () => {
    if (busy) return;
    if (dirty && step !== "result") {
      setConfirmClose(true);
      return;
    }
    props.onClose();
  };

  const resetForInspection = async (next: PragmaBundleImportInspection) => {
    const api = desktopApi();
    const recoverable =
      api === undefined || next.alreadyInstalledId === undefined
        ? null
        : ((await api.listPragmaBundleInstallations()).find(
            (candidate) =>
              candidate.id === next.alreadyInstalledId && candidate.status === "needs_setup",
          ) ?? null);
    setInspection(next);
    setRecovery(recoverable);
    setConflicts(
      Object.fromEntries(next.conflicts.map((conflict) => [conflict.ref, "copy" as const])),
    );
    setBindingIndex(0);
    setRuntimeBindings({});
    setCapabilityBindings({});
    setContextBindings({});
    setSecrets({});
    setInstallation(null);
    setStep("select");
  };

  const inspectPickedBundle = async () => {
    const api = desktopApi();
    if (api === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const picked = await api.pickPragmaBundle();
      if (picked.cancelled || picked.path === undefined) return;
      await resetForInspection(await api.inspectPragmaBundle({ sourcePath: picked.path }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const inspectDroppedBundle = async (file: File) => {
    const api = desktopApi();
    if (api === undefined) return;
    if (!file.name.toLocaleLowerCase().endsWith(".pragma")) {
      setError(t("bundleDropInvalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await resetForInspection(await api.inspectDroppedPragmaBundle(file));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const refreshRuntimes = useCallback(async () => {
    setRefreshingRuntimes(true);
    try {
      await props.onRefreshRuntimes();
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRefreshingRuntimes(false);
    }
  }, [props.onRefreshRuntimes]);

  useEffect(() => {
    if (step !== "bindings" || currentRequirement?.kind !== "runtime") return;
    void refreshRuntimes();
  }, [currentRequirement?.id, currentRequirement?.kind, refreshRuntimes, step]);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined || step !== "bindings") return;
    return api.subscribeRuntimeModelCatalog(() => {
      void refreshRuntimes();
    });
  }, [refreshRuntimes, step]);

  useEffect(() => {
    if (currentRequirement?.kind !== "runtime") return;
    const request = currentRequirement.runtimeRequest;
    if (
      request?.runtimeId === undefined ||
      request.providerId === undefined ||
      request.modelId === undefined ||
      runtimeBindings[currentRequirement.id] !== undefined
    ) {
      return;
    }
    const runtime = props.runtimes.find(
      (candidate) => candidate.id === request.runtimeId && candidate.status === "available",
    );
    const model = runtime?.models?.find(
      (candidate) =>
        candidate.provider.id === request.providerId && candidate.id === request.modelId,
    );
    if (runtime === undefined || model === undefined) return;
    setRuntimeBindings((current) => ({
      ...current,
      [currentRequirement.id]: {
        runtimeId: runtime.id,
        providerId: model.provider.id,
        modelId: model.id,
        ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
      },
    }));
  }, [currentRequirement, props.runtimes, runtimeBindings]);

  const selectRoot = async (rootRef: string) => {
    const api = desktopApi();
    if (api === undefined || inspection === null || rootRef === inspection.root.ref) return;
    setBusy(true);
    setError(null);
    try {
      await resetForInspection(
        await api.inspectPragmaBundle({ sourcePath: inspection.sourcePath, rootRef }),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const nextFromSelect = () => {
    if (inspection === null) return;
    if (recovery === null && inspection.conflicts.length > 0) setStep("conflicts");
    else if (requirements.length > 0) setStep("bindings");
    else setStep("review");
  };

  const nextFromConflicts = () => {
    if (requirements.length > 0) setStep("bindings");
    else setStep("review");
  };

  const previousFromBindings = () => {
    if (bindingIndex > 0) {
      setBindingIndex((current) => current - 1);
      return;
    }
    setStep(recovery === null && inspection?.conflicts.length ? "conflicts" : "select");
  };

  const nextFromBindings = () => {
    if (bindingIndex < requirements.length - 1) {
      setBindingIndex((current) => current + 1);
      return;
    }
    setStep("review");
  };

  const bindingIsComplete = (requirement: BindingRequirement | undefined): boolean => {
    if (requirement === undefined || !requirement.required) return true;
    if (requirement.kind === "runtime") {
      const value = runtimeBindings[requirement.id];
      return value !== undefined && value.runtimeId !== "" && value.modelId !== "";
    }
    if (requirement.kind === "capability") {
      return (capabilityBindings[requirement.id] ?? "") !== "";
    }
    if (requirement.kind === "context-store") {
      return (contextBindings[requirement.id] ?? "") !== "";
    }
    return requirement.kind !== "secret" || (secrets[requirement.id] ?? "").trim() !== "";
  };

  const importBundle = async () => {
    const api = desktopApi();
    if (api === undefined || inspection === null) return;
    setBusy(true);
    setError(null);
    try {
      const requirementsById = new Map(
        requirements.map((requirement) => [requirement.id, requirement]),
      );
      const runtimes = Object.entries(runtimeBindings).flatMap(([requirementId, value]) => {
        const requirement = requirementsById.get(requirementId);
        return requirement === undefined
          ? []
          : [{ requirementId, resourceRef: requirement.resourceRef, ...value }];
      });
      const capabilities = Object.entries(capabilityBindings).flatMap(([requirementId, value]) => {
        const requirement = requirementsById.get(requirementId);
        const [capabilityId, revision] = value.split("@");
        return requirement === undefined || capabilityId === undefined || revision === undefined
          ? []
          : [
              {
                requirementId,
                resourceRef: requirement.resourceRef,
                capabilityId,
                revision: Number(revision),
              },
            ];
      });
      const contextStores = Object.entries(contextBindings).flatMap(([requirementId, storeId]) => {
        const requirement = requirementsById.get(requirementId);
        return requirement === undefined || storeId === ""
          ? []
          : [{ requirementId, resourceRef: requirement.resourceRef, storeId }];
      });
      const next =
        recovery === null
          ? await api.importPragmaBundle({
              sourcePath: inspection.sourcePath,
              rootRef: inspection.root.ref,
              expectedFingerprint: inspection.bundleFingerprint,
              expectedProjectFingerprint: inspection.projectFingerprint,
              expectedProjectRevision: inspection.projectRevision,
              conflicts: inspection.conflicts.map((conflict) => ({
                resourceRef: conflict.ref,
                action: conflicts[conflict.ref] ?? "copy",
              })),
              runtimes,
              capabilities,
              contextStores,
              secrets,
            })
          : await api.resolvePragmaBundleInstallation({
              installationId: recovery.id,
              baseRevision: inspection.projectRevision,
              runtimes,
              capabilities,
              contextStores,
              secrets,
            });
      setInstallation(next);
      setStep("result");
      await props.onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const footer = (() => {
    if (step === "result") {
      return (
        <button className="primary-button" type="button" onClick={props.onClose}>
          {t("done")}
        </button>
      );
    }
    if (step === "select") {
      return (
        <>
          <button className="secondary-button" type="button" disabled={busy} onClick={close}>
            {t("cancel")}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy || inspection === null}
            onClick={nextFromSelect}
          >
            {t("bundleContinue")}
          </button>
        </>
      );
    }
    if (step === "conflicts") {
      return (
        <>
          <button className="secondary-button" type="button" onClick={() => setStep("select")}>
            {t("bundleBack")}
          </button>
          <button className="primary-button" type="button" onClick={nextFromConflicts}>
            {t("bundleContinue")}
          </button>
        </>
      );
    }
    if (step === "bindings") {
      return (
        <>
          <button className="secondary-button" type="button" onClick={previousFromBindings}>
            {t("bundleBack")}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={!bindingIsComplete(currentRequirement)}
            onClick={nextFromBindings}
          >
            {bindingIndex === requirements.length - 1 ? t("bundleReview") : t("bundleContinue")}
          </button>
        </>
      );
    }
    return (
      <>
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={() => {
            if (requirements.length > 0) {
              setBindingIndex(Math.max(0, requirements.length - 1));
              setStep("bindings");
            } else {
              setStep(recovery === null && inspection?.conflicts.length ? "conflicts" : "select");
            }
          }}
        >
          {t("bundleBack")}
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={busy}
          onClick={() => void importBundle()}
        >
          <DownloadSimple size={17} />
          {busy ? t("bundleImporting") : t("bundleImportAction")}
        </button>
      </>
    );
  })();

  return (
    <>
      <BundleDialogShell
        title={t("bundleImportTitle")}
        description={t("bundleImportDescription")}
        busy={busy}
        onClose={close}
        dialogRef={dialogRef}
        footer={footer}
      >
        <BundleImportSteps
          step={step}
          inspection={inspection}
          conflictCount={recovery === null ? (inspection?.conflicts.length ?? 0) : 0}
          requirementCount={requirements.length}
        />
        {step === "select" ? (
          <BundleFileStep
            inspection={inspection}
            busy={busy}
            dragging={dragging}
            onDragging={setDragging}
            onPick={() => void inspectPickedBundle()}
            onDrop={(file) => void inspectDroppedBundle(file)}
            onRoot={(rootRef) => void selectRoot(rootRef)}
          />
        ) : null}
        {step === "conflicts" && inspection !== null ? (
          <BundleConflictStep
            inspection={inspection}
            selections={conflicts}
            onChange={(ref, action) => setConflicts((current) => ({ ...current, [ref]: action }))}
            onSetAll={(action) =>
              setConflicts(
                Object.fromEntries(
                  inspection.conflicts.map((conflict) => [
                    conflict.ref,
                    action === "update" && !conflict.updateAllowed ? "copy" : action,
                  ]),
                ),
              )
            }
          />
        ) : null}
        {step === "bindings" && currentRequirement !== undefined ? (
          <BundleBindingStep
            requirement={currentRequirement}
            index={bindingIndex}
            total={requirements.length}
            runtimes={props.runtimes}
            capabilities={props.capabilities}
            contextStores={props.contextStores}
            runtimeBinding={runtimeBindings[currentRequirement.id]}
            capabilityBinding={capabilityBindings[currentRequirement.id] ?? ""}
            contextBinding={contextBindings[currentRequirement.id] ?? ""}
            secret={secrets[currentRequirement.id] ?? ""}
            refreshingRuntimes={refreshingRuntimes}
            onRefreshRuntimes={() => void refreshRuntimes()}
            onRuntime={(value) =>
              setRuntimeBindings((current) => ({
                ...current,
                [currentRequirement.id]: value,
              }))
            }
            onCapability={(value) =>
              setCapabilityBindings((current) => ({
                ...current,
                [currentRequirement.id]: value,
              }))
            }
            onContext={(value) =>
              setContextBindings((current) => ({
                ...current,
                [currentRequirement.id]: value,
              }))
            }
            onSecret={(value) =>
              setSecrets((current) => ({ ...current, [currentRequirement.id]: value }))
            }
          />
        ) : null}
        {step === "review" && inspection !== null ? (
          <BundleReview
            inspection={inspection}
            conflicts={recovery === null ? conflicts : {}}
            requirements={requirements}
          />
        ) : null}
        {step === "result" && installation !== null ? (
          <div className="pragma-bundle-result">
            {installation.status === "ready" ? (
              <p className="pragma-bundle-success" role="status">
                {t("bundleReady", { name: installation.rootName })}
              </p>
            ) : installation.status === "failed" ? (
              <p className="form-error" role="alert">
                {installation.error ?? t("bundleImportFailed")}
              </p>
            ) : (
              <div className="pragma-bundle-warning" role="status">
                <WarningCircle size={20} aria-hidden="true" />
                <div>
                  <strong>{t("bundleSetupTitle")}</strong>
                  <p>{t("bundleSetupDescription")}</p>
                  <ul>
                    {installation.pending.map((item) => (
                      <li key={item.id}>{item.name}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </BundleDialogShell>
      {confirmClose ? (
        <div className="capability-confirm-backdrop pragma-bundle-confirm-backdrop">
          <section className="capability-confirm-dialog" role="alertdialog" aria-modal="true">
            <h2>{t("bundleDiscardDraftTitle")}</h2>
            <p>{t("bundleDiscardDraftDescription")}</p>
            <footer>
              <button
                className="secondary-button"
                type="button"
                autoFocus
                onClick={() => setConfirmClose(false)}
              >
                {t("bundleKeepEditing")}
              </button>
              <button className="danger-button" type="button" onClick={props.onClose}>
                {t("bundleDiscardDraft")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

function BundleDialogShell(props: {
  readonly title: string;
  readonly description: string;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly footer: ReactNode;
  readonly children: ReactNode;
  readonly dialogRef?: RefObject<HTMLElement | null> | undefined;
}) {
  const { t } = useTranslation("studio");
  return (
    <div className="capability-confirm-backdrop pragma-bundle-backdrop">
      <section
        className="pragma-bundle-dialog"
        ref={props.dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pragma-bundle-title"
        aria-describedby="pragma-bundle-description"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !props.busy) props.onClose();
          if (event.key !== "Tab") return;
          const focusable = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ];
          const first = focusable[0];
          const last = focusable.at(-1);
          if (first === undefined || last === undefined) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header>
          <div>
            <span className="pragma-bundle-eyebrow">
              <Archive size={17} aria-hidden="true" /> {t("bundlePortable")}
            </span>
            <h2 id="pragma-bundle-title">{props.title}</h2>
            <p id="pragma-bundle-description">{props.description}</p>
          </div>
          <button
            className="pragma-bundle-close"
            type="button"
            aria-label={t("close")}
            disabled={props.busy}
            onClick={props.onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="pragma-bundle-body">{props.children}</div>
        <footer>{props.footer}</footer>
      </section>
    </div>
  );
}

function BundleImportSteps(props: {
  readonly step: ImportStep;
  readonly inspection: PragmaBundleImportInspection | null;
  readonly conflictCount: number;
  readonly requirementCount: number;
}) {
  const { t } = useTranslation("studio");
  const activeIndex =
    props.step === "select"
      ? 0
      : props.step === "conflicts"
        ? 1
        : props.step === "bindings"
          ? 2
          : 3;
  const steps = [
    t("bundleStepSelect"),
    t("bundleStepConflicts"),
    t("bundleStepBindings"),
    t("bundleStepReview"),
  ];
  return (
    <ol className="pragma-bundle-stepper" aria-label={t("bundleImportProgress")}>
      {steps.map((label, index) => (
        <li
          key={label}
          className={index < activeIndex ? "is-complete" : index === activeIndex ? "is-active" : ""}
          aria-current={index === activeIndex ? "step" : undefined}
        >
          <span>{index < activeIndex ? <Check size={13} /> : index + 1}</span>
          <strong>{label}</strong>
          {index === 1 && props.inspection !== null && props.conflictCount === 0 ? (
            <small>{t("bundleStepSkipped")}</small>
          ) : null}
          {index === 2 && props.inspection !== null && props.requirementCount === 0 ? (
            <small>{t("bundleStepSkipped")}</small>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function BundleFileStep(props: {
  readonly inspection: PragmaBundleImportInspection | null;
  readonly busy: boolean;
  readonly dragging: boolean;
  readonly onDragging: (value: boolean) => void;
  readonly onPick: () => void;
  readonly onDrop: (file: File) => void;
  readonly onRoot: (rootRef: string) => void;
}) {
  const { t } = useTranslation("studio");
  return (
    <div className="pragma-bundle-file-step">
      <button
        className={`pragma-bundle-dropzone${props.dragging ? " is-dragging" : ""}`}
        type="button"
        disabled={props.busy}
        onClick={props.onPick}
        onDragEnter={(event) => {
          event.preventDefault();
          props.onDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          props.onDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          props.onDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          props.onDragging(false);
          if (event.dataTransfer.files.length !== 1) return;
          const file = event.dataTransfer.files[0];
          if (file !== undefined) props.onDrop(file);
        }}
      >
        <Archive size={30} />
        <strong>{props.dragging ? t("bundleDropNow") : t("bundleChooseFile")}</strong>
        <span>{t("bundleChooseFileHint")}</span>
      </button>
      {props.inspection !== null ? (
        <div className="pragma-bundle-file-summary">
          <span className="pragma-bundle-verified">
            <Check size={15} /> {t("bundleVerified")}
          </span>
          <strong>{props.inspection.sourceName}</strong>
          {props.inspection.roots.length > 1 ? (
            <label>
              <span>{t("bundleInstallRoot")}</span>
              <SelectMenu
                ariaLabel={t("bundleInstallRoot")}
                className="form-select"
                value={props.inspection.root.ref}
                disabled={props.busy}
                options={props.inspection.roots.map((root) => ({
                  value: root.ref,
                  label: `${root.name} (${root.kind})`,
                }))}
                onChange={props.onRoot}
              />
            </label>
          ) : (
            <p>{props.inspection.root.name}</p>
          )}
          <small>
            {props.inspection.root.kind} ·{" "}
            {t("bundleResourceCount", { count: props.inspection.resources })}
          </small>
          {props.inspection.sameContentInstallationIds.length > 0 ? (
            <p className="pragma-bundle-warning">
              {t("bundleSameContentInstalled", {
                count: props.inspection.sameContentInstallationIds.length,
              })}
            </p>
          ) : null}
          {props.inspection.importedKnowledgePersistsAfterDiscard ? (
            <p className="pragma-bundle-warning">
              {t("bundleImportedKnowledgePersists", {
                count: props.inspection.knowledgeCount,
              })}
            </p>
          ) : null}
          <button type="button" onClick={props.onPick}>
            {t("bundleChooseAnother")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function BundleInspection(props: {
  readonly inspection: PragmaBundleImportInspection;
  readonly selections: Readonly<Record<string, "copy" | "update">>;
  readonly onChange: (ref: string, action: "copy" | "update") => void;
}) {
  return (
    <BundleConflictStep
      inspection={props.inspection}
      selections={props.selections}
      onChange={props.onChange}
      onSetAll={() => undefined}
    />
  );
}

function BundleConflictStep(props: {
  readonly inspection: PragmaBundleImportInspection;
  readonly selections: Readonly<Record<string, "copy" | "update">>;
  readonly onChange: (ref: string, action: "copy" | "update") => void;
  readonly onSetAll: (action: "copy" | "update") => void;
}) {
  const { t } = useTranslation("studio");
  return (
    <section className="pragma-bundle-conflict-step">
      <header>
        <div>
          <h3>{t("bundleConflicts", { count: props.inspection.conflicts.length })}</h3>
          <p>{t("bundleConflictPerResourceHint")}</p>
        </div>
        <div className="pragma-bundle-batch-actions">
          <button type="button" onClick={() => props.onSetAll("copy")}>
            {t("bundleAllCopies")}
          </button>
          <button type="button" onClick={() => props.onSetAll("update")}>
            {t("bundleAllUpdates")}
          </button>
        </div>
      </header>
      <div className="pragma-bundle-conflict-cards">
        {props.inspection.conflicts.map((conflict) => (
          <article key={conflict.ref}>
            <header>
              <div>
                <strong>{conflict.importedName}</strong>
                <small>
                  {conflict.resourceKind} · {conflict.ref}
                </small>
              </div>
            </header>
            <ul>
              {conflict.matches.map((match) => (
                <li key={`${match.kind}:${match.localRef}`}>
                  {match.kind === "identity"
                    ? t("bundleConflictIdentity", { name: match.localName })
                    : t("bundleConflictName", { name: match.localName })}
                </li>
              ))}
            </ul>
            <div className="pragma-bundle-conflict-choice" role="group">
              <button
                type="button"
                aria-pressed={props.selections[conflict.ref] !== "update"}
                className={props.selections[conflict.ref] !== "update" ? "is-selected" : ""}
                onClick={() => props.onChange(conflict.ref, "copy")}
              >
                <strong>{t("bundleImportCopy")}</strong>
                <small>{t("bundleImportCopyShortHint")}</small>
              </button>
              <button
                type="button"
                disabled={!conflict.updateAllowed}
                aria-pressed={props.selections[conflict.ref] === "update"}
                className={props.selections[conflict.ref] === "update" ? "is-selected" : ""}
                onClick={() => props.onChange(conflict.ref, "update")}
              >
                <strong>{t("bundleUpdateExisting")}</strong>
                <small>
                  {conflict.updateAllowed
                    ? t("bundleUpdateExistingShortHint")
                    : t("bundleUpdateBlocked")}
                </small>
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function BundleBindingStep(props: {
  readonly requirement: BindingRequirement;
  readonly index: number;
  readonly total: number;
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly capabilities: readonly Capability[];
  readonly contextStores: readonly ContextStore[];
  readonly runtimeBinding: RuntimeBindingDraft | undefined;
  readonly capabilityBinding: string;
  readonly contextBinding: string;
  readonly secret: string;
  readonly refreshingRuntimes: boolean;
  readonly onRefreshRuntimes: () => void;
  readonly onRuntime: (value: RuntimeBindingDraft) => void;
  readonly onCapability: (value: string) => void;
  readonly onContext: (value: string) => void;
  readonly onSecret: (value: string) => void;
}) {
  const { t } = useTranslation("studio");
  const requirement = props.requirement;
  const runtime = props.runtimes.find(
    (candidate) => candidate.id === props.runtimeBinding?.runtimeId,
  );
  const models = runtime?.status === "available" ? (runtime.models ?? []) : [];
  const selectedModel = models.find(
    (model) =>
      model.provider.id === props.runtimeBinding?.providerId &&
      model.id === props.runtimeBinding.modelId,
  );

  return (
    <section className="pragma-bundle-binding-step">
      <header>
        <span>{t("bundleBindingProgress", { current: props.index + 1, total: props.total })}</span>
        <h3>{requirement.name}</h3>
        <p>{requirement.message}</p>
      </header>
      {requirement.kind === "runtime" ? (
        <>
          <div className="pragma-bundle-runtime-toolbar">
            <span>{t("bundleRuntimeAvailability")}</span>
            <button
              className="secondary-button"
              type="button"
              disabled={props.refreshingRuntimes}
              onClick={props.onRefreshRuntimes}
            >
              <ArrowsClockwise size={16} />
              {props.refreshingRuntimes ? t("bundleRefreshing") : t("bundleRefresh")}
            </button>
          </div>
          <div className="pragma-bundle-field">
            <span>{t("bundleChooseRuntime")}</span>
            <SelectMenu
              ariaLabel={t("bundleChooseRuntime")}
              className="form-select"
              value={props.runtimeBinding?.runtimeId ?? ""}
              options={[
                { value: "", label: t("bundleChooseRuntimePlaceholder") },
                ...props.runtimes.map((candidate) => ({
                  value: candidate.id,
                  label: `${candidate.displayName}${
                    candidate.status === "available" ? "" : ` · ${t("bundleRuntimeUnavailable")}`
                  }`,
                  disabled: candidate.status !== "available",
                })),
              ]}
              onChange={(runtimeId) =>
                props.onRuntime({
                  runtimeId,
                  providerId: "",
                  modelId: "",
                })
              }
            />
          </div>
          {requirement.runtimeRequest?.runtimeId !== undefined &&
          props.runtimes.find((candidate) => candidate.id === requirement.runtimeRequest?.runtimeId)
            ?.status !== "available" ? (
            <p className="pragma-bundle-runtime-diagnostic">
              {t("bundleRequestedRuntimeUnavailable", {
                runtime: requirement.runtimeRequest.runtimeId,
              })}
            </p>
          ) : null}
          <div className="pragma-bundle-field">
            <span>{t("bundleChooseModel")}</span>
            <SelectMenu
              ariaLabel={t("bundleChooseModel")}
              className="form-select"
              disabled={runtime === undefined || runtime.status !== "available"}
              value={
                props.runtimeBinding?.providerId && props.runtimeBinding.modelId
                  ? JSON.stringify([props.runtimeBinding.providerId, props.runtimeBinding.modelId])
                  : ""
              }
              searchable={models.length > 8}
              options={[
                { value: "", label: t("bundleChooseModelPlaceholder") },
                ...models.map((model) => ({
                  value: JSON.stringify([model.provider.id, model.id]),
                  label: `${model.displayName} · ${model.provider.displayName}`,
                })),
              ]}
              onChange={(modelKey) => {
                if (modelKey === "") {
                  props.onRuntime({
                    runtimeId: runtime?.id ?? "",
                    providerId: "",
                    modelId: "",
                  });
                  return;
                }
                const [providerId, modelId] = JSON.parse(modelKey) as [string, string];
                props.onRuntime({
                  runtimeId: runtime?.id ?? "",
                  providerId,
                  modelId,
                });
              }}
            />
          </div>
          {selectedModel?.thinking !== undefined ? (
            <div className="pragma-bundle-field">
              <span>{t("bundleChooseThinking")}</span>
              <SelectMenu
                ariaLabel={t("bundleChooseThinking")}
                className="form-select"
                value={props.runtimeBinding?.thinkingLevel ?? ""}
                options={[
                  { value: "", label: t("bundleRuntimeDefault") },
                  ...selectedModel.thinking.supportedLevels.map((level) => ({
                    value: level.value,
                    label: level.label,
                  })),
                ]}
                onChange={(thinkingLevel) =>
                  props.onRuntime({
                    ...props.runtimeBinding!,
                    ...(thinkingLevel === "" ? { thinkingLevel: undefined } : { thinkingLevel }),
                  })
                }
              />
            </div>
          ) : null}
        </>
      ) : requirement.kind === "capability" ? (
        <div className="pragma-bundle-field">
          <span>{t("bundleChooseCapability")}</span>
          <SelectMenu
            ariaLabel={t("bundleChooseCapability")}
            className="form-select"
            value={props.capabilityBinding}
            searchable={props.capabilities.length > 8}
            options={[
              { value: "", label: t("bundleChooseCapability") },
              ...props.capabilities
                .filter(
                  (capability) =>
                    requirement.capabilityKind === undefined ||
                    capability.definition.kind === requirement.capabilityKind,
                )
                .map((capability) => ({
                  value: `${capability.manifest.id}@${capability.manifest.latestRevision}`,
                  label: capability.manifest.name,
                })),
            ]}
            onChange={props.onCapability}
          />
        </div>
      ) : requirement.kind === "context-store" ? (
        <div className="pragma-bundle-field">
          <span>{t("bundleChooseKnowledgeBase")}</span>
          <SelectMenu
            ariaLabel={t("bundleChooseKnowledgeBase")}
            className="form-select"
            value={props.contextBinding}
            searchable={props.contextStores.length > 8}
            options={[
              { value: "", label: t("bundleChooseKnowledgeBase") },
              ...props.contextStores.map((store) => ({ value: store.id, label: store.name })),
            ]}
            onChange={props.onContext}
          />
        </div>
      ) : requirement.kind === "secret" ? (
        <label className="pragma-bundle-field">
          <span>{t("bundleEnterSecret")}</span>
          <input
            type="password"
            autoComplete="off"
            value={props.secret}
            placeholder={t("bundleEnterSecret")}
            onChange={(event) => props.onSecret(event.target.value)}
          />
        </label>
      ) : (
        <div className="pragma-bundle-deferred">
          <WarningCircle size={22} />
          <div>
            <strong>{t("bundlePluginDeferredTitle")}</strong>
            <p>{t("bundlePluginDeferredDescription")}</p>
          </div>
        </div>
      )}
    </section>
  );
}

function BundleReview(props: {
  readonly inspection: PragmaBundleImportInspection;
  readonly conflicts: Readonly<Record<string, "copy" | "update">>;
  readonly requirements: readonly BindingRequirement[];
}) {
  const { t } = useTranslation("studio");
  const copies = Object.values(props.conflicts).filter((value) => value === "copy").length;
  const updates = Object.values(props.conflicts).filter((value) => value === "update").length;
  const deferred = props.requirements.filter((requirement) => !requirement.required).length;
  return (
    <section className="pragma-bundle-review">
      <header>
        <Check size={22} />
        <div>
          <h3>{t("bundleReviewTitle")}</h3>
          <p>{t("bundleReviewDescription")}</p>
        </div>
      </header>
      <dl>
        <div>
          <dt>{t("bundleReviewRoot")}</dt>
          <dd>{props.inspection.root.name}</dd>
        </div>
        <div>
          <dt>{t("bundleReviewResources")}</dt>
          <dd>{props.inspection.resources}</dd>
        </div>
        <div>
          <dt>{t("bundleReviewCopies")}</dt>
          <dd>{copies}</dd>
        </div>
        <div>
          <dt>{t("bundleReviewUpdates")}</dt>
          <dd>{updates}</dd>
        </div>
        <div>
          <dt>{t("bundleReviewBindings")}</dt>
          <dd>{props.requirements.length - deferred}</dd>
        </div>
      </dl>
      {deferred > 0 ? (
        <p className="pragma-bundle-review-warning">
          {t("bundleReviewDeferred", { count: deferred })}
        </p>
      ) : null}
    </section>
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
  const SelectedIcon = selected === undefined ? Archive : bundleRootIcon(selected.kind);
  const hasExportableRoots = props.roots.length > 0;

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
            <strong>
              {selected?.metadata.name ??
                t(hasExportableRoots ? "bundleSelectExportObject" : "bundleNoExportObjects")}
            </strong>
            <small>
              {selected === undefined
                ? t(
                    hasExportableRoots
                      ? "bundleSelectExportObjectHint"
                      : "bundleNoExportObjectsHint",
                  )
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
              {filtered.length === 0 ? (
                <p className="pragma-bundle-root-empty">
                  <strong>{t("bundleNoExportObjectMatches")}</strong>
                  <span>{t("bundleTryAnotherSearch")}</span>
                </p>
              ) : null}
              {filtered.map((resource) => {
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
