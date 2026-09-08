import {
  Archive,
  ArrowsClockwise,
  Check,
  Database,
  DownloadSimple,
  GitBranch,
  MagnifyingGlass,
  UploadSimple,
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
  PragmaBundleDependencyReadiness,
  PragmaBundleImportInspection,
  PragmaBundleInstallation,
  PragmaBundleModuleOptions,
  PragmaProjectSnapshot,
} from "../../../../shared/contracts/index.ts";
import { DesktopMutationErrorSchema } from "../../../../shared/contracts/mutation.ts";
import { ExpertAvatar } from "../../components/ExpertAvatar.tsx";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { desktopApi } from "./studio-model.ts";

type BundleMode = "export" | "import";
type ExportStep = "select" | "modules" | "result";
type BundleExportRoot = Extract<
  PragmaProjectSnapshot["resources"][number],
  { kind: "Expert" | "ExpertTeam" | "Flow" | "ContextStore" }
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
export const BUNDLE_EXPORT_LIST_PAGE_SIZE = 20;

function isBundleExportRoot(
  resource: PragmaProjectSnapshot["resources"][number],
): resource is BundleExportRoot {
  return (
    resource.kind === "Expert" ||
    resource.kind === "ExpertTeam" ||
    resource.kind === "Flow" ||
    resource.kind === "ContextStore"
  );
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

export function visibleBundleExportRoots(
  roots: readonly BundleExportRoot[],
  page: number,
): readonly BundleExportRoot[] {
  return roots.slice(0, Math.max(1, page) * BUNDLE_EXPORT_LIST_PAGE_SIZE);
}

export function PragmaBundleDialog(props: {
  readonly mode: BundleMode;
  readonly project: PragmaProjectSnapshot;
  readonly capabilities: readonly Capability[];
  readonly contextStores: readonly ContextStore[];
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly initialSourcePath?: string | undefined;
  readonly initialRootRef?: string | undefined;
  readonly onRefreshRuntimes: () => Promise<readonly DesktopRuntimeAvailability[]>;
  readonly onClose: () => void;
  readonly onChanged: () => void | Promise<void>;
  readonly onOpenCapability?: ((capabilityId: string) => void) | undefined;
}) {
  return props.mode === "export" ? (
    <BundleExportDialog {...props} />
  ) : (
    <BundleImportDialog {...props} />
  );
}

function BundleExportDialog(props: {
  readonly project: PragmaProjectSnapshot;
  readonly initialRootRef?: string | undefined;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation("studio");
  const requestedRootRef = props.initialRootRef;
  const initialRootRef =
    requestedRootRef !== undefined &&
    props.project.resources.some(
      (resource) =>
        isBundleExportRoot(resource) && canonicalPragmaResourceRef(resource) === requestedRootRef,
    )
      ? requestedRootRef
      : "";
  const [step, setStep] = useState<ExportStep>(initialRootRef === "" ? "select" : "modules");
  const [rootRef, setRootRef] = useState(initialRootRef);
  const [modules, setModules] = useState<PragmaBundleModuleOptions>({
    capabilities: true,
    plugins: true,
    knowledgeBases: false,
    flowLayouts: true,
  });
  const [resultPath, setResultPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roots = useMemo(
    () => orderBundleExportRoots(props.project.resources.filter(isBundleExportRoot)),
    [props.project.resources],
  );

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
      if (!result.cancelled) setStep("result");
    } catch (cause) {
      setError(
        bundleErrorMessage(cause, (key, options) =>
          options === undefined ? t(key) : t(key, options),
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const selected = roots.find((resource) => canonicalPragmaResourceRef(resource) === rootRef);
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
            onClick={() => setStep("modules")}
          >
            {t("bundleContinue")}
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
          onClick={() => setStep("select")}
        >
          {t("bundleBack")}
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
    );
  })();

  return (
    <BundleDialogShell
      title={t("bundleExportTitle")}
      description={t("bundleExportDescription")}
      busy={busy}
      onClose={props.onClose}
      footer={footer}
      className="pragma-bundle-export-dialog"
      bodyHeader={<BundleExportSteps step={step} />}
    >
      {step === "select" ? (
        <BundleExportObjectStep roots={roots} value={rootRef} onChange={setRootRef} />
      ) : null}
      {step === "modules" && selected !== undefined ? (
        <section className="pragma-bundle-export-modules" aria-labelledby="bundle-modules-title">
          <header>
            <span className="pragma-bundle-export-selected-icon">
              <BundleExportRootVisual resource={selected} size="picker" />
            </span>
            <div>
              <small>{t("bundleSelectedExportObject")}</small>
              <strong>{selected.metadata.name}</strong>
              <span>
                {bundleRootLabel(selected.kind, t)} · {canonicalPragmaResourceRef(selected)}
              </span>
            </div>
          </header>
          <fieldset className="pragma-bundle-modules">
            <legend id="bundle-modules-title">{t("bundleModules")}</legend>
            {selected.kind !== "ContextStore" ? (
              <>
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
              </>
            ) : null}
            <BundleToggle
              label={t("bundleKnowledgeBases")}
              description={t(
                selected.kind === "ContextStore"
                  ? "bundleKnowledgeBaseRequiredHint"
                  : "bundleKnowledgeBasesHint",
              )}
              checked={selected.kind === "ContextStore" || modules.knowledgeBases}
              disabled={selected.kind === "ContextStore"}
              onChange={(knowledgeBases) => setModules({ ...modules, knowledgeBases })}
            />
            {selected.kind !== "ContextStore" ? (
              <BundleToggle
                label={t("bundleFlowLayouts")}
                description={t("bundleFlowLayoutsHint")}
                checked={modules.flowLayouts}
                onChange={(flowLayouts) => setModules({ ...modules, flowLayouts })}
              />
            ) : null}
          </fieldset>
          <p className="pragma-bundle-safety">{t("bundleSafetyHint")}</p>
        </section>
      ) : null}
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
  readonly initialSourcePath?: string | undefined;
  readonly initialRootRef?: string | undefined;
  readonly onRefreshRuntimes: () => Promise<readonly DesktopRuntimeAvailability[]>;
  readonly onClose: () => void;
  readonly onChanged: () => void | Promise<void>;
  readonly onOpenCapability?: ((capabilityId: string) => void) | undefined;
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
  const displayError = (cause: unknown): string =>
    bundleErrorMessage(cause, (key, options) => (options === undefined ? t(key) : t(key, options)));

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
  const resultReadiness = installation === null ? [] : installationReadiness(installation);
  const pendingResultReadiness = resultReadiness.filter((item) => item.status !== "ready");
  const readyResultCount = resultReadiness.length - pendingResultReadiness.length;
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

  const resetForInspection = useCallback(async (next: PragmaBundleImportInspection) => {
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
  }, []);

  const initialPathInspected = useRef(false);
  useEffect(() => {
    const api = desktopApi();
    if (
      api === undefined ||
      props.initialSourcePath === undefined ||
      initialPathInspected.current
    ) {
      return;
    }
    initialPathInspected.current = true;
    setBusy(true);
    setError(null);
    void api
      .inspectPragmaBundle({
        sourcePath: props.initialSourcePath,
        ...(props.initialRootRef === undefined ? {} : { rootRef: props.initialRootRef }),
      })
      .then(resetForInspection)
      .catch((cause: unknown) => setError(displayError(cause)))
      .finally(() => setBusy(false));
  }, [props.initialRootRef, props.initialSourcePath, resetForInspection]);

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
      setError(displayError(cause));
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
      setError(displayError(cause));
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
      setError(displayError(cause));
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
      setError(displayError(cause));
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
                ...(conflict.targetRevision === undefined
                  ? {}
                  : { expectedTargetRevision: conflict.targetRevision }),
                ...(conflict.targetSnapshotHash === undefined
                  ? {}
                  : { expectedTargetSnapshotHash: conflict.targetSnapshotHash }),
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
      setError(displayError(cause));
    } finally {
      setBusy(false);
    }
  };

  const footer = (() => {
    if (step === "result") {
      if (installation?.status === "needs_setup" && pendingResultReadiness.length > 0) {
        return (
          <>
            <button className="secondary-button" type="button" onClick={props.onClose}>
              {t("bundleFinishSetupLater")}
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                setRecovery(installation);
                setBindingIndex(0);
                setStep("bindings");
              }}
            >
              {t("bundleFinishSetupNow")}
            </button>
          </>
        );
      }
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
        className={step === "select" && inspection === null ? "is-awaiting-file" : undefined}
        footer={footer}
        bodyHeader={
          <BundleImportSteps
            step={step}
            inspection={inspection}
            conflictCount={recovery === null ? (inspection?.conflicts.length ?? 0) : 0}
            requirementCount={requirements.length}
          />
        }
      >
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
                {t("bundleImportFailed")}
              </p>
            ) : (
              <div className="pragma-bundle-result-content" role="status">
                <header className="pragma-bundle-result-summary">
                  <span>
                    <Check size={20} aria-hidden="true" />
                  </span>
                  <div>
                    <strong>{t("bundleImportCompleteTitle")}</strong>
                    <p>
                      {t("bundleImportCompleteNeedsSetup", {
                        name: installation.rootName,
                        count: pendingResultReadiness.length,
                      })}
                    </p>
                  </div>
                </header>
                <section className="pragma-bundle-result-pending">
                  <header>
                    <div>
                      <h3>{t("bundlePendingSetupTitle")}</h3>
                      <p>{t("bundlePendingSetupDescription")}</p>
                    </div>
                    <strong>{pendingResultReadiness.length}</strong>
                  </header>
                  <BundleReadinessList readiness={pendingResultReadiness} compact />
                </section>
                {readyResultCount > 0 ? (
                  <p className="pragma-bundle-result-ready-summary">
                    <Check size={14} aria-hidden="true" />
                    {t("bundleReadyDependencies", { count: readyResultCount })}
                  </p>
                ) : null}
                <div className="pragma-bundle-setup-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      const api = desktopApi();
                      if (api === undefined) return;
                      setBusy(true);
                      void api
                        .recheckPragmaBundleInstallation({ installationId: installation.id })
                        .then(async (next) => {
                          setInstallation(next);
                          await props.onChanged();
                        })
                        .catch((cause: unknown) => setError(displayError(cause)))
                        .finally(() => setBusy(false));
                    }}
                  >
                    <ArrowsClockwise size={16} />
                    {t("bundleRecheck")}
                  </button>
                  {pendingResultReadiness
                    .filter((item) => item.kind === "capability" && item.targetId !== undefined)
                    .map((item) => (
                      <button
                        className="secondary-button"
                        type="button"
                        key={`configure:${item.id}`}
                        onClick={() => props.onOpenCapability?.(item.targetId!)}
                      >
                        {t("bundleConfigureCapability", { name: item.name })}
                      </button>
                    ))}
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
  readonly bodyHeader?: ReactNode | undefined;
  readonly children: ReactNode;
  readonly dialogRef?: RefObject<HTMLElement | null> | undefined;
  readonly className?: string | undefined;
}) {
  const { t } = useTranslation("studio");
  return (
    <div className="capability-confirm-backdrop pragma-bundle-backdrop">
      <section
        className={["pragma-bundle-dialog", props.className].filter(Boolean).join(" ")}
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
        <div className="pragma-bundle-body">
          {props.bodyHeader === undefined ? null : (
            <div className="pragma-bundle-body-header">{props.bodyHeader}</div>
          )}
          <div className="pragma-bundle-body-scroll">{props.children}</div>
        </div>
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
  const stepIsSkipped = (index: number): boolean =>
    props.inspection !== null &&
    ((index === 1 && props.conflictCount === 0) || (index === 2 && props.requirementCount === 0));
  return (
    <ol className="pragma-bundle-stepper" aria-label={t("bundleImportProgress")}>
      {steps.map((label, index) => (
        <li
          key={label}
          className={index < activeIndex ? "is-complete" : index === activeIndex ? "is-active" : ""}
          aria-current={index === activeIndex ? "step" : undefined}
        >
          <span>{index < activeIndex ? <Check size={13} /> : index + 1}</span>
          <strong>
            {label}
            {stepIsSkipped(index) ? (
              <span className="pragma-bundle-step-skip">{t("bundleStepSkippedInline")}</span>
            ) : null}
          </strong>
        </li>
      ))}
    </ol>
  );
}

export function BundleFileStep(props: {
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
      {props.inspection === null ? (
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
          <span className="pragma-bundle-dropzone-icon">
            <Archive size={28} aria-hidden="true" />
          </span>
          <strong>{props.dragging ? t("bundleDropNow") : t("bundleChooseFile")}</strong>
          <span>{t("bundleChooseFileHint")}</span>
        </button>
      ) : (
        <div className="pragma-bundle-file-summary">
          <header>
            <span className="pragma-bundle-file-icon">
              <Archive size={22} aria-hidden="true" />
            </span>
            <div className="pragma-bundle-file-copy">
              <span className="pragma-bundle-verified">
                <Check size={13} aria-hidden="true" /> {t("bundleVerified")}
              </span>
              <strong title={props.inspection.sourceName}>{props.inspection.sourceName}</strong>
              <p>{props.inspection.root.name}</p>
            </div>
            <button className="secondary-button" type="button" onClick={props.onPick}>
              {t("bundleChooseAnother")}
            </button>
          </header>
          <div className="pragma-bundle-file-meta" aria-label={t("bundleFileOverview")}>
            <span>{props.inspection.root.kind}</span>
            <span>{t("bundleResourceCount", { count: props.inspection.resources })}</span>
          </div>
          {props.inspection.roots.length > 1 ? (
            <label className="pragma-bundle-root-select">
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
          ) : null}
          {props.inspection.sameContentInstallationIds.length > 0 ? (
            <p className="pragma-bundle-warning">
              {t("bundleSameContentInstalled", {
                count: props.inspection.sameContentInstallationIds.length,
              })}
            </p>
          ) : null}
          <BundleReadinessList readiness={props.inspection.readiness} />
        </div>
      )}
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
                <strong>
                  {conflict.resourceKind === "ContextStore"
                    ? t("bundleAppendKnowledgeRevision")
                    : t("bundleUpdateExisting")}
                </strong>
                <small>
                  {conflict.updateAllowed
                    ? conflict.resourceKind === "ContextStore"
                      ? t("bundleAppendKnowledgeRevisionHint")
                      : t("bundleUpdateExistingShortHint")
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
  const requirementName = bundleDependencyDisplayName(
    requirement.kind,
    requirement.name,
    t("bundleLegacyKnowledgeBase"),
  );
  const runtime = props.runtimes.find(
    (candidate) => candidate.id === props.runtimeBinding?.runtimeId,
  );
  const models = runtime?.status === "available" ? (runtime.models ?? []) : [];
  const selectedModel = models.find(
    (model) =>
      model.provider.id === props.runtimeBinding?.providerId &&
      model.id === props.runtimeBinding.modelId,
  );
  const thinkingLevels = selectedModel?.thinking?.supportedLevels ?? [];

  return (
    <section className="pragma-bundle-binding-step">
      <header>
        <span>{t("bundleBindingProgress", { current: props.index + 1, total: props.total })}</span>
        <h3>{requirementName}</h3>
        <p>{requirement.message}</p>
      </header>
      {requirement.kind === "runtime" ? (
        <>
          <div className="pragma-bundle-field">
            <div className="pragma-bundle-field-heading">
              <span>{t("bundleChooseRuntime")}</span>
              <button
                className="pragma-bundle-refresh-runtime"
                type="button"
                aria-label={props.refreshingRuntimes ? t("bundleRefreshing") : t("bundleRefresh")}
                title={props.refreshingRuntimes ? t("bundleRefreshing") : t("bundleRefresh")}
                disabled={props.refreshingRuntimes}
                onClick={props.onRefreshRuntimes}
              >
                <ArrowsClockwise
                  className={props.refreshingRuntimes ? "is-refreshing" : undefined}
                  size={15}
                  aria-hidden="true"
                />
              </button>
            </div>
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
          {props.runtimeBinding?.modelId ? (
            <div className="pragma-bundle-field">
              <span>{t("bundleChooseThinking")}</span>
              <SelectMenu
                ariaLabel={t("bundleChooseThinking")}
                className="form-select"
                value={
                  thinkingLevels.length === 0 ? "" : (props.runtimeBinding.thinkingLevel ?? "")
                }
                options={[
                  { value: "", label: t("bundleRuntimeDefault") },
                  ...thinkingLevels.map((level) => ({
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
          <span>
            {t("bundleChooseKnowledgeBase")}
            {!requirement.required ? <small>{t("bundleBindingOptional")}</small> : null}
          </span>
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
          {t("bundleReviewDeferredDependencies", { count: deferred })}
        </p>
      ) : null}
      <BundleReadinessList readiness={props.inspection.readiness} />
    </section>
  );
}

export function BundleReadinessList(props: {
  readonly readiness: readonly PragmaBundleDependencyReadiness[];
  readonly compact?: boolean | undefined;
}) {
  const { t } = useTranslation("studio");
  if (props.readiness.length === 0) return null;
  const readyCount = props.readiness.filter((item) => item.status === "ready").length;
  return (
    <section
      className={`pragma-bundle-readiness${props.compact ? " is-compact" : ""}`}
      aria-label={t("bundlePreflightTitle")}
    >
      {props.compact ? null : (
        <header>
          <div>
            <h4>{t("bundlePreflightTitle")}</h4>
            <p>
              {t("bundleReadinessSummary", {
                ready: readyCount,
                total: props.readiness.length,
              })}
            </p>
          </div>
          <span data-complete={readyCount === props.readiness.length}>
            {readyCount}/{props.readiness.length}
          </span>
        </header>
      )}
      <ul>
        {props.readiness.map((item) => (
          <li key={item.id} data-status={item.status}>
            <span className="pragma-bundle-readiness-icon">
              {item.status === "ready" ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <WarningCircle size={15} aria-hidden="true" />
              )}
            </span>
            <span className="pragma-bundle-readiness-copy">
              <strong>
                {bundleDependencyDisplayName(item.kind, item.name, t("bundleLegacyKnowledgeBase"))}
              </strong>
              <small title={item.resourceRef}>{item.resourceRef}</small>
            </span>
            <span className="pragma-bundle-readiness-state">
              <strong>{t(`bundleStatus.${item.status}`)}</strong>
              <small>{t(`bundleAction.${item.action}`)}</small>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function bundleDependencyDisplayName(
  kind: string,
  name: string,
  legacyKnowledgeBaseLabel: string,
): string {
  return kind === "context-store" && /^Context\s+[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(name)
    ? legacyKnowledgeBaseLabel
    : name;
}

function installationReadiness(
  installation: PragmaBundleInstallation,
): readonly PragmaBundleDependencyReadiness[] {
  if (installation.readiness.length > 0) return installation.readiness;
  return installation.pending.map((item) => ({
    id: item.id,
    kind: item.kind,
    resourceRef: item.resourceRef,
    name: item.name,
    status: item.status ?? "action_required",
    code: item.code ?? "legacy_pending",
    action: item.action ?? "restore_or_replace",
    message: item.message,
    ...(item.capabilityKind === undefined ? {} : { capabilityKind: item.capabilityKind }),
    ...(item.targetId === undefined ? {} : { targetId: item.targetId }),
  }));
}

function bundleErrorMessage(
  error: unknown,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parsed = DesktopMutationErrorSchema.safeParse(error);
  if (!parsed.success) return translate("bundleGenericError");
  if (parsed.data.code === "bundle_setup_required") return translate("bundleSetupDescription");
  if (parsed.data.code === "bundle_identity_conflict") {
    return translate("bundleIdentityConflict");
  }
  return translate("bundleGenericError");
}

function BundleExportSteps(props: { readonly step: ExportStep }) {
  const { t } = useTranslation("studio");
  const steps = [t("bundleStepSelectObject"), t("bundleStepConfigure")];
  const activeIndex = props.step === "select" ? 0 : 1;

  return (
    <ol
      className="pragma-bundle-stepper pragma-bundle-export-stepper"
      aria-label={t("bundleExportProgress")}
    >
      {steps.map((label, index) => (
        <li
          key={label}
          className={index < activeIndex ? "is-complete" : index === activeIndex ? "is-active" : ""}
          aria-current={index === activeIndex ? "step" : undefined}
        >
          <span>{index < activeIndex ? <Check size={13} /> : index + 1}</span>
          <strong>{label}</strong>
        </li>
      ))}
    </ol>
  );
}

function BundleExportObjectStep(props: {
  readonly roots: readonly BundleExportRoot[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useTranslation("studio");
  const [kind, setKind] = useState<BundleExportRoot["kind"] | "all">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const filters: readonly {
    readonly id: BundleExportRoot["kind"] | "all";
    readonly label: string;
  }[] = [
    { id: "all", label: t("bundleFilterAll") },
    { id: "Expert", label: t("bundleFilterExperts") },
    { id: "ExpertTeam", label: t("bundleFilterTeams") },
    { id: "Flow", label: t("bundleFilterFlows") },
    { id: "ContextStore", label: t("bundleFilterKnowledgeBases") },
  ];
  const filtered = filterBundleExportRoots(props.roots, search, (resourceKind) =>
    bundleRootLabel(resourceKind, t),
  ).filter((resource) => kind === "all" || resource.kind === kind);
  const visible = visibleBundleExportRoots(filtered, page);
  const selected = props.roots.find(
    (resource) => canonicalPragmaResourceRef(resource) === props.value,
  );
  const hasExportableRoots = props.roots.length > 0;

  const resetPage = () => setPage(1);

  return (
    <section className="pragma-bundle-export-select" aria-labelledby="bundle-export-object-title">
      <header>
        <div>
          <h3 id="bundle-export-object-title">{t("bundleChooseExportObject")}</h3>
          <p>{t("bundleSelectExportObjectHint")}</p>
        </div>
        <span>{t("bundleAvailableObjects", { count: props.roots.length })}</span>
      </header>
      <div
        className="pragma-bundle-export-filters"
        role="group"
        aria-label={t("bundleExportObject")}
      >
        {filters.map((filter) => (
          <button
            key={filter.id}
            type="button"
            aria-pressed={kind === filter.id}
            onClick={() => {
              setKind(filter.id);
              resetPage();
            }}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <div className="pragma-bundle-export-results">
        <label className="pragma-bundle-export-search">
          <MagnifyingGlass size={18} aria-hidden="true" />
          <span className="sr-only">{t("bundleSearchExportObjects")}</span>
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              resetPage();
            }}
            placeholder={t("bundleSearchExportObjects")}
          />
        </label>
        {selected !== undefined ? (
          <p className="pragma-bundle-export-selection" role="status">
            <Check size={16} aria-hidden="true" />
            <span>{t("bundleSelectedExportObject")}</span>
            <strong>{selected.metadata.name}</strong>
          </p>
        ) : null}
        <div className="pragma-bundle-export-options" aria-label={t("bundleExportObjects")}>
          {visible.length === 0 ? (
            <div className="pragma-bundle-root-empty">
              <strong>
                {t(hasExportableRoots ? "bundleNoExportObjectMatches" : "bundleNoExportObjects")}
              </strong>
              <span>
                {t(hasExportableRoots ? "bundleTryAnotherSearch" : "bundleNoExportObjectsHint")}
              </span>
            </div>
          ) : null}
          {visible.map((resource) => {
            const ref = canonicalPragmaResourceRef(resource);
            const isSelected = ref === props.value;
            return (
              <button
                className={
                  isSelected
                    ? "pragma-bundle-export-option is-selected"
                    : "pragma-bundle-export-option"
                }
                type="button"
                aria-pressed={isSelected}
                key={ref}
                onClick={() => props.onChange(ref)}
              >
                <span className="pragma-bundle-export-option-visual">
                  <BundleExportRootVisual resource={resource} />
                </span>
                <span className="pragma-bundle-export-option-copy">
                  <strong>{resource.metadata.name}</strong>
                  <small>{resource.metadata.description}</small>
                </span>
                <span className="pragma-bundle-export-option-meta">
                  <span>{bundleRootLabel(resource.kind, t)}</span>
                  <Check
                    className={isSelected ? "is-visible" : undefined}
                    size={18}
                    aria-hidden="true"
                  />
                </span>
              </button>
            );
          })}
        </div>
        {visible.length < filtered.length ? (
          <div className="pragma-bundle-export-load-more">
            <small>
              {t("bundleShowingExportObjects", { shown: visible.length, total: filtered.length })}
            </small>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setPage((current) => current + 1)}
            >
              {t("bundleLoadMore")}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function BundleExportRootVisual(props: {
  readonly resource: BundleExportRoot;
  readonly size?: "sm" | "picker" | undefined;
}) {
  if (props.resource.kind === "Expert" || props.resource.kind === "ExpertTeam") {
    return (
      <ExpertAvatar
        avatarId={props.resource.metadata.avatarId}
        team={props.resource.kind === "ExpertTeam"}
        size={props.size === "sm" ? "sm" : props.size === "picker" ? "picker" : "md"}
      />
    );
  }
  if (props.resource.kind === "ContextStore") {
    return (
      <Database
        size={props.size === "picker" ? 28 : props.size === "sm" ? 19 : 22}
        aria-hidden="true"
      />
    );
  }
  return (
    <GitBranch
      size={props.size === "picker" ? 28 : props.size === "sm" ? 19 : 22}
      aria-hidden="true"
    />
  );
}

function bundleRootLabel(kind: BundleExportRoot["kind"], t: (key: string) => string): string {
  return kind === "Expert"
    ? t("bundleRootExpert")
    : kind === "ExpertTeam"
      ? t("bundleRootExpertTeam")
      : kind === "Flow"
        ? t("bundleRootFlow")
        : t("bundleRootKnowledgeBase");
}

function BundleToggle(props: {
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled?: boolean | undefined;
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
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
    </label>
  );
}
