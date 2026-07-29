import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  canonicalPragmaResourceRef,
  type PragmaExpertTeamResource,
  type PragmaFlowResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";

import type {
  ContextStore,
  Capability,
  CreateContextStore,
  ContextStoreContent,
  ContextStoreContentMetadata,
  ContextStoreEntry,
  ContextStoreImportInspection,
  ExpertContextStoreMount,
  DesktopRuntimeAvailability,
  DesktopPlugin,
  AutomationSummary,
  PragmaProjectSnapshot,
} from "../../../../shared/contracts/index.ts";
import { ContextStoreSchema } from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import {
  ContextStoreDetailFragment,
  ContextStoreDirectoryFragment,
  ExpertContextMountDrawer,
} from "./ContextStoreFragment.tsx";
import { ExpertDetailFragment, ExpertDirectoryFragment } from "./ExpertDirectoryFragment.tsx";
import { ExpertEditorFragment, type ExpertEditorMode } from "./ExpertEditorFragment.tsx";
import { CapabilityDirectoryFragment } from "./CapabilityDirectoryFragment.tsx";
import { CapabilityDetailFragment } from "./CapabilityDetailFragment.tsx";
import {
  PragmaResourceDetailFragment,
  PragmaResourceDirectoryFragment,
  TeamEditor,
  type ResourceEditorMode,
  type ResourceKind,
} from "./PragmaResourceDirectoryFragment.tsx";
import { PluginDetailFragment, PluginDirectoryFragment } from "./PluginDirectoryFragment.tsx";
import { AutomationDirectoryFragment } from "./AutomationDirectoryFragment.tsx";
import { FlowEditor } from "./flow-editor/FlowEditor.tsx";
import { createEmptyFlow } from "./flow-editor/flow-model.ts";
import {
  desktopApi,
  emptyDraft,
  isBuiltInExpert,
  studioSections,
  toExpertRecord,
  toCreateExpertInput,
  toPersistedInput,
  type ExpertDraft,
  type ExpertRecord,
  type StudioView,
} from "./studio-model.ts";

export function StudioPage(props: {
  readonly initialExpertRef?: string | undefined;
  readonly onTryExpert: (expert: ExpertRecord) => void;
}) {
  const { t } = useTranslation("studio");
  const [activeView, setActiveView] = useState<StudioView>("experts");
  const [screen, setScreen] = useState<
    | "directory"
    | "expert-detail"
    | "context-store-detail"
    | "capability-detail"
    | "plugin-detail"
    | "resource-detail"
    | "resource-edit"
    | "create"
  >("directory");
  const [experts, setExperts] = useState<readonly ExpertRecord[]>([]);
  const [selectedExpert, setSelectedExpert] = useState<ExpertRecord | null>(null);
  const [draft, setDraft] = useState<ExpertDraft>(emptyDraft());
  const [expertEditor, setExpertEditor] = useState<{
    readonly mode: ExpertEditorMode;
    readonly baseRevision: number;
  }>({ mode: "create", baseRevision: 0 });
  const [runtimes, setRuntimes] = useState<readonly DesktopRuntimeAvailability[]>([]);
  const [contextStores, setContextStores] = useState<readonly ContextStore[]>([]);
  const [selectedContextStoreId, setSelectedContextStoreId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<readonly Capability[]>([]);
  const [plugins, setPlugins] = useState<readonly DesktopPlugin[]>([]);
  const [selectedPluginRef, setSelectedPluginRef] = useState<string | null>(null);
  const [selectedCapabilityId, setSelectedCapabilityId] = useState<string | null>(null);
  const [contextDrawerOpen, setContextDrawerOpen] = useState(false);
  const [expertError, setExpertError] = useState<string | null>(null);
  const [project, setProject] = useState<PragmaProjectSnapshot | null>(null);
  const [automations, setAutomations] = useState<readonly AutomationSummary[]>([]);
  const [selectedResourceRef, setSelectedResourceRef] = useState<string | null>(null);
  const [resourceEditor, setResourceEditor] = useState<{
    readonly kind: ResourceKind;
    readonly mode: ResourceEditorMode;
    readonly newResourceId?: string | undefined;
  } | null>(null);
  const openedInitialExpertRef = useRef<string | undefined>(undefined);
  const resourceSaveCompletedRef = useRef(false);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const summaries = await api.listExperts();
        const definitions = await Promise.all(
          summaries.map((summary) => api.getExpert(summary.ref)),
        );
        const storedExperts = definitions.map(toExpertRecord);
        if (cancelled) return;
        setExperts(storedExperts);
        setSelectedExpert(storedExperts[0] ?? null);
        setExpertError(null);
      } catch (loadError) {
        if (cancelled) return;
        setExpertError(errorMessage(loadError));
      }
    })();
    void api
      .getPragmaProject()
      .then((snapshot) => {
        if (!cancelled) setProject(snapshot);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setExpertError(errorMessage(loadError));
      });
    void api
      .listAutomations()
      .then((items) => {
        if (!cancelled) setAutomations(items);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setExpertError(errorMessage(loadError));
      });
    void api
      .listContextStores()
      .then((stores) => {
        if (!cancelled) setContextStores(stores);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setExpertError(errorMessage(loadError));
      });
    void api
      .listCapabilities()
      .then((items) => {
        if (!cancelled) setCapabilities(items);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setExpertError(errorMessage(loadError));
      });
    void api
      .listPlugins()
      .then((items) => {
        if (!cancelled) setPlugins(items);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setExpertError(errorMessage(loadError));
      });
    void api
      .getRuntimeAvailability()
      .then((availability) => {
        if (!cancelled) setRuntimes(availability);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setExpertError(errorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const openExpertDirectory = () => {
    setActiveView("experts");
    setScreen("directory");
  };
  const openCreate = (
    expert?: ExpertRecord,
    mode: ExpertEditorMode = expert === undefined ? "create" : "edit",
  ) => {
    setDraft(
      expert === undefined ? emptyDraft() : { ...expert, tagInput: "", pluginSecretMutations: {} },
    );
    setExpertEditor({
      mode,
      baseRevision:
        mode === "edit" && expert?.persisted !== undefined
          ? expert.persisted.revision
          : (project?.revision ?? 0),
    });
    setScreen("create");
  };
  useEffect(() => {
    if (
      props.initialExpertRef === undefined ||
      openedInitialExpertRef.current === props.initialExpertRef
    ) {
      return;
    }
    const expert = experts.find((candidate) => candidate.ref === props.initialExpertRef);
    if (expert === undefined) return;
    openedInitialExpertRef.current = props.initialExpertRef;
    setActiveView("experts");
    setSelectedExpert(expert);
    setDraft({ ...expert, tagInput: "", pluginSecretMutations: {} });
    setExpertEditor({
      mode: "edit",
      baseRevision: expert.persisted?.revision ?? project?.revision ?? 0,
    });
    setScreen("create");
  }, [experts, project?.revision, props.initialExpertRef]);
  const saveExpert = async (expert: ExpertRecord, mode: ExpertEditorMode = "edit") => {
    const api = desktopApi();
    let saved = expert;
    if (api !== undefined) {
      const definition = isBuiltInExpert(expert)
        ? await api.updateBuiltInExpert(expert.ref!, {
            name: expert.name,
            description: expert.description,
            tags: [...expert.tags],
            additionalInstructions: expert.additionalInstructions,
            ...(expert.model === null ? {} : { model: expert.model }),
            capabilities: [...expert.capabilities],
            toolApprovals: expert.toolApprovals,
            plugins: [...expert.plugins],
            contextStoreMounts: [...expert.contextStoreMounts],
          })
        : mode !== "edit"
          ? await api.createExpert(
              toCreateExpertInput(expert, {
                baseRevision: expertEditor.baseRevision,
              }),
            )
          : await api.updateExpert(expert.ref ?? `expert:${expert.id}`, toPersistedInput(expert));
      saved = toExpertRecord(definition);
      if (!isBuiltInExpert(expert)) setProject(await api.getPragmaProject());
    }
    setExperts((current) =>
      current.some(
        (item) => (item.ref ?? `expert:${item.id}`) === (saved.ref ?? `expert:${saved.id}`),
      )
        ? current.map((item) =>
            (item.ref ?? `expert:${item.id}`) === (saved.ref ?? `expert:${saved.id}`)
              ? saved
              : item,
          )
        : [saved, ...current],
    );
    setSelectedExpert(saved);
    setExpertEditor({
      mode: "edit",
      baseRevision: saved.persisted?.revision ?? expertEditor.baseRevision,
    });
    setExpertError(null);
    setScreen("expert-detail");
  };
  const resetSelectedExpert = async () => {
    if (selectedExpert === null || !isBuiltInExpert(selectedExpert)) return;
    const api = desktopApi();
    if (api === undefined) return;
    const reset = toExpertRecord(await api.resetBuiltInExpert(selectedExpert.ref!));
    setExperts((current) => current.map((expert) => (expert.ref === reset.ref ? reset : expert)));
    setSelectedExpert(reset);
    setExpertError(null);
  };
  const deleteSelectedExpert = async () => {
    if (selectedExpert === null) return;
    const ref = selectedExpert.ref ?? `expert:${selectedExpert.id}`;
    const api = desktopApi();
    if (api !== undefined) {
      await api.deleteExpert(ref);
      setProject(await api.getPragmaProject());
    }
    setExperts((current) =>
      current.filter((expert) => (expert.ref ?? `expert:${expert.id}`) !== ref),
    );
    setSelectedExpert(null);
    setScreen("directory");
  };
  const createContextStore = async (input: CreateContextStore): Promise<ContextStore> => {
    const api = desktopApi();
    const timestamp = new Date().toISOString();
    const store =
      api === undefined
        ? ContextStoreSchema.parse({
            schemaVersion: "pragma.context-store/v2",
            id: crypto.randomUUID(),
            name: input.name,
            description: input.description,
            type: "file",
            status: "ready",
            source: { origin: input.mode === "blank" ? "created" : "copied" },
            createdAt: timestamp,
            updatedAt: timestamp,
          })
        : await api.createContextStore(input);
    setContextStores((current) => [store, ...current]);
    return store;
  };
  const pickContextStoreFolder = async (): Promise<string | undefined> => {
    const api = desktopApi();
    if (api === undefined) return undefined;
    const result = await api.pickContextStoreFolder();
    if (!result.ok && result.reason !== "cancelled") {
      throw new Error(result.error ?? "The selected folder is not readable.");
    }
    return result.path;
  };
  const inspectContextStoreImport = async (
    sourcePath: string,
  ): Promise<ContextStoreImportInspection> => {
    const api = desktopApi();
    if (api === undefined) {
      return { sourcePath, markdownFiles: 1, ignoredFiles: 0, totalBytes: 0 };
    }
    return api.inspectContextStoreImport({ sourcePath });
  };
  const listContextStoreEntries = useCallback(
    async (storeId: string): Promise<readonly ContextStoreEntry[]> => {
      const api = desktopApi();
      if (api !== undefined) return api.listContextStoreEntries({ storeId });
      return [];
    },
    [],
  );
  const getContextStoreContent = useCallback(
    async (storeId: string, contentId: string): Promise<ContextStoreContent> => {
      const api = desktopApi();
      if (api !== undefined) return api.getContextStoreContent({ storeId, contentId });
      throw new Error(`Context not found: ${contentId}`);
    },
    [],
  );
  const createContextStoreFile = useCallback(
    async (storeId: string, id: string, content: string, metadata: ContextStoreContentMetadata) => {
      const api = desktopApi();
      if (api === undefined) throw new Error("Desktop bridge is unavailable.");
      return api.createContextStoreFile({ storeId, id, content, metadata });
    },
    [],
  );
  const createContextStoreFolder = useCallback(async (storeId: string, id: string) => {
    const api = desktopApi();
    if (api === undefined) throw new Error("Desktop bridge is unavailable.");
    await api.createContextStoreFolder({ storeId, id });
  }, []);
  const updateContextStoreFile = useCallback(
    async (
      storeId: string,
      id: string,
      content: string,
      metadata: ContextStoreContentMetadata,
      expectedRevision: string,
    ) => {
      const api = desktopApi();
      if (api === undefined) throw new Error("Desktop bridge is unavailable.");
      return api.updateContextStoreFile({
        storeId,
        id,
        content,
        metadata,
        expectedRevision,
      });
    },
    [],
  );
  const renameContextStoreEntry = useCallback(
    async (storeId: string, id: string, nextId: string, kind: "file" | "directory") => {
      const api = desktopApi();
      if (api === undefined) throw new Error("Desktop bridge is unavailable.");
      await api.renameContextStoreEntry({ storeId, id, nextId, kind });
    },
    [],
  );
  const deleteContextStoreEntry = useCallback(
    async (storeId: string, id: string, kind: "file" | "directory") => {
      const api = desktopApi();
      if (api === undefined) throw new Error("Desktop bridge is unavailable.");
      await api.deleteContextStoreEntry({ storeId, id, kind });
    },
    [],
  );
  const subscribeContextStoreChanges = useCallback((storeId: string, listener: () => void) => {
    const api = desktopApi();
    return api?.subscribeContextStoreChanges(storeId, listener) ?? (() => undefined);
  }, []);
  const saveContextMounts = async (mounts: readonly ExpertContextStoreMount[]) => {
    if (selectedExpert === null) return;
    const updated = { ...selectedExpert, contextStoreMounts: [...mounts] };
    await saveExpert(updated, "edit");
    setContextDrawerOpen(false);
  };
  const selectedContextStore =
    contextStores.find((store) => store.id === selectedContextStoreId) ?? null;
  const selectedCapability =
    capabilities.find((capability) => capability.manifest.id === selectedCapabilityId) ?? null;
  const selectedPlugin = plugins.find((plugin) => plugin.ref === selectedPluginRef) ?? null;
  const selectedResource =
    project?.resources.find(
      (resource) => canonicalPragmaResourceRef(resource) === selectedResourceRef,
    ) ?? null;

  const updateCapability = (capability: Capability) => {
    setCapabilities((current) =>
      current.some((item) => item.manifest.id === capability.manifest.id)
        ? current.map((item) => (item.manifest.id === capability.manifest.id ? capability : item))
        : [capability, ...current],
    );
  };

  const resourceKindView = (kind: ResourceKind): StudioView =>
    kind === "team" ? "teams" : "flows";

  const openResourceDetail = (resource: PragmaExpertTeamResource | PragmaFlowResource) => {
    setActiveView(resource.kind === "ExpertTeam" ? "teams" : "flows");
    setSelectedResourceRef(canonicalPragmaResourceRef(resource));
    setResourceEditor(null);
    setScreen("resource-detail");
  };

  const openResourceCreate = (kind: ResourceKind, resourceId: string) => {
    resourceSaveCompletedRef.current = false;
    setActiveView(resourceKindView(kind));
    setSelectedResourceRef(null);
    setResourceEditor({ kind, mode: "create", newResourceId: resourceId });
    setScreen("resource-edit");
  };

  const openResourceEdit = (resource: PragmaExpertTeamResource | PragmaFlowResource) => {
    const kind = resource.kind === "ExpertTeam" ? "team" : "flow";
    resourceSaveCompletedRef.current = false;
    setActiveView(resourceKindView(kind));
    setSelectedResourceRef(canonicalPragmaResourceRef(resource));
    setResourceEditor({ kind, mode: "edit" });
    setScreen("resource-edit");
  };

  const closeResourceEditor = () => {
    if (resourceSaveCompletedRef.current) {
      resourceSaveCompletedRef.current = false;
      setScreen("resource-detail");
      return;
    }
    if (resourceEditor?.mode === "create" && selectedResourceRef === null) {
      setScreen("directory");
      return;
    }
    setScreen("resource-detail");
  };

  const savePragmaResource = async (
    resource: PragmaResource,
    expectedRevision: number,
    requiredUnchangedRefs: readonly string[],
  ): Promise<boolean> => {
    const api = desktopApi();
    if (api === undefined) return false;
    try {
      const snapshot = await api.upsertPragmaResource({
        baseRevision: expectedRevision,
        resource,
        requiredUnchangedRefs: [...requiredUnchangedRefs],
      });
      setProject(snapshot);
      setSelectedResourceRef(canonicalPragmaResourceRef(resource));
      setResourceEditor(null);
      resourceSaveCompletedRef.current = true;
      setExpertError(null);
      setScreen("resource-detail");
      return true;
    } catch (saveError) {
      setExpertError(errorMessage(saveError));
      return false;
    }
  };

  const saveFlowResource = async (
    resource: PragmaFlowResource,
    supportingResources: readonly PragmaResource[],
    expectedRevision: number,
    requiredUnchangedRefs: readonly string[],
  ): Promise<boolean> => {
    const api = desktopApi();
    if (api === undefined) return false;
    try {
      const snapshot = await api.applyPragmaProjectChanges({
        baseRevision: expectedRevision,
        upserts: [...supportingResources, resource],
        removals: [],
        requiredUnchangedRefs: [...requiredUnchangedRefs],
      });
      setProject(snapshot);
      setSelectedResourceRef(canonicalPragmaResourceRef(resource));
      setResourceEditor(null);
      resourceSaveCompletedRef.current = true;
      setExpertError(null);
      setScreen("resource-detail");
      return true;
    } catch (saveError) {
      setExpertError(errorMessage(saveError));
      return false;
    }
  };

  const deleteSelectedResource = async () => {
    if (project === null || selectedResource === null) return;
    const api = desktopApi();
    if (api === undefined) return;
    const ref = canonicalPragmaResourceRef(selectedResource);
    const snapshot = await api.deletePragmaResource({
      baseRevision: project.revision,
      ref,
    });
    setProject(snapshot);
    if (selectedResource.kind === "Flow") {
      await api.deleteWorkflowLayout({
        projectId: project.projectId,
        flowId: selectedResource.metadata.id,
      });
    }
    setSelectedResourceRef(null);
    setResourceEditor(null);
    setScreen("directory");
  };

  return (
    <section className="studio-page">
      <nav className="studio-navigation" aria-label={t("sections")}>
        {studioSections.map((section) => {
          const SectionIcon = section.icon;
          const isActive = section.id === activeView;
          const count =
            section.id === "context-stores"
              ? contextStores.length
              : section.id === "experts"
                ? experts.length
                : section.id === "teams"
                  ? (project?.resources.filter((resource) => resource.kind === "ExpertTeam")
                      .length ?? 0)
                  : section.id === "flows"
                    ? (project?.resources.filter((resource) => resource.kind === "Flow").length ??
                      0)
                    : section.id === "integrations"
                      ? automations.length
                      : section.id === "capabilities"
                        ? capabilities.length
                        : section.id === "plugins"
                          ? plugins.length
                          : 0;
          return (
            <button
              key={section.id}
              className={isActive ? "studio-nav-item is-active" : "studio-nav-item"}
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => {
                setActiveView(section.id);
                setScreen("directory");
                setContextDrawerOpen(false);
                setResourceEditor(null);
                resourceSaveCompletedRef.current = false;
              }}
            >
              <SectionIcon size={20} aria-hidden="true" />
              <span>{t(section.labelKey)}</span>
              {count !== undefined ? <em>{count}</em> : null}
            </button>
          );
        })}
      </nav>

      <div className="studio-content">
        {screen === "expert-detail" && selectedExpert !== null ? (
          <ExpertDetailFragment
            expert={selectedExpert}
            contextStores={contextStores}
            onBack={openExpertDirectory}
            onEdit={() => openCreate(selectedExpert)}
            onConfigureContext={() => setContextDrawerOpen(true)}
            onTryInSession={() => props.onTryExpert(selectedExpert)}
            onDelete={deleteSelectedExpert}
            onReset={resetSelectedExpert}
          />
        ) : null}
        {screen === "create" ? (
          <ExpertEditorFragment
            mode={expertEditor.mode}
            initialValue={draft}
            runtimes={runtimes}
            contextStores={contextStores}
            capabilities={capabilities}
            plugins={plugins}
            resources={project?.resources ?? []}
            onCancel={() => {
              if (expertEditor.mode === "edit" && selectedExpert !== null) {
                setScreen("expert-detail");
                return;
              }
              openExpertDirectory();
            }}
            onCreated={async (expert) => await saveExpert(expert, expertEditor.mode)}
          />
        ) : null}
        {screen === "directory" && activeView === "experts" ? (
          <ExpertDirectoryFragment
            experts={experts}
            onCreate={() => openCreate()}
            onOpen={(expert) => {
              setSelectedExpert(expert);
              setScreen("expert-detail");
            }}
          />
        ) : null}
        {screen === "directory" && activeView === "context-stores" ? (
          <ContextStoreDirectoryFragment
            stores={contextStores}
            onCreate={createContextStore}
            onInspectImport={inspectContextStoreImport}
            onPickFolder={pickContextStoreFolder}
            onOpen={(store) => {
              setSelectedContextStoreId(store.id);
              setScreen("context-store-detail");
            }}
          />
        ) : null}
        {screen === "context-store-detail" && selectedContextStore !== null ? (
          <ContextStoreDetailFragment
            store={selectedContextStore}
            onBack={() => setScreen("directory")}
            onListEntries={listContextStoreEntries}
            onGetContent={getContextStoreContent}
            onCreateFile={createContextStoreFile}
            onCreateFolder={createContextStoreFolder}
            onUpdateFile={updateContextStoreFile}
            onRenameEntry={renameContextStoreEntry}
            onDeleteEntry={deleteContextStoreEntry}
            onSubscribe={subscribeContextStoreChanges}
            onDelete={async () => {
              const api = desktopApi();
              if (api !== undefined)
                await api.deleteContextStore({ storeId: selectedContextStore.id });
              setContextStores((current) =>
                current.filter((store) => store.id !== selectedContextStore.id),
              );
              setSelectedContextStoreId(null);
              setScreen("directory");
            }}
          />
        ) : null}
        {screen === "capability-detail" && selectedCapability !== null ? (
          <CapabilityDetailFragment
            capability={selectedCapability}
            onBack={() => setScreen("directory")}
            onChanged={updateCapability}
          />
        ) : null}
        {screen === "directory" && activeView === "capabilities" ? (
          <CapabilityDirectoryFragment
            capabilities={capabilities}
            onOpen={(capability) => {
              setSelectedCapabilityId(capability.manifest.id);
              setScreen("capability-detail");
            }}
            onChanged={(capability, removedId) => {
              if (removedId !== undefined) {
                setCapabilities((current) =>
                  current.filter((item) => item.manifest.id !== removedId),
                );
                return;
              }
              if (capability === undefined) return;
              updateCapability(capability);
            }}
          />
        ) : null}
        {screen === "directory" && activeView === "plugins" ? (
          <PluginDirectoryFragment
            plugins={plugins}
            onOpen={(plugin) => {
              setSelectedPluginRef(plugin.ref);
              setScreen("plugin-detail");
            }}
            onChanged={(plugin) =>
              setPlugins((current) =>
                current.some((item) => item.ref === plugin.ref)
                  ? current.map((item) => (item.ref === plugin.ref ? plugin : item))
                  : [plugin, ...current],
              )
            }
          />
        ) : null}
        {screen === "directory" && activeView === "integrations" && project !== null ? (
          <AutomationDirectoryFragment
            automations={automations}
            project={project}
            onChanged={async () => {
              const api = desktopApi();
              if (api === undefined) return;
              const [nextProject, nextAutomations] = await Promise.all([
                api.getPragmaProject(),
                api.listAutomations(),
              ]);
              setProject(nextProject);
              setAutomations(nextAutomations);
            }}
          />
        ) : null}
        {screen === "plugin-detail" && selectedPlugin !== null ? (
          <PluginDetailFragment
            plugin={selectedPlugin}
            onBack={() => setScreen("directory")}
            onChanged={(plugin) => {
              setPlugins((current) =>
                current.map((item) => (item.ref === plugin.ref ? plugin : item)),
              );
            }}
            onDeleted={(ref) => {
              setPlugins((current) => current.filter((item) => item.ref !== ref));
              setSelectedPluginRef(null);
              setScreen("directory");
            }}
          />
        ) : null}
        {screen === "resource-detail" &&
        project !== null &&
        (selectedResource?.kind === "ExpertTeam" || selectedResource?.kind === "Flow") ? (
          <PragmaResourceDetailFragment
            resource={selectedResource}
            project={project}
            onBack={() => setScreen("directory")}
            onEdit={() => openResourceEdit(selectedResource)}
            onDelete={deleteSelectedResource}
          />
        ) : null}
        {screen === "resource-edit" && project !== null && resourceEditor !== null ? (
          resourceEditor.kind === "team" ? (
            <TeamEditor
              project={project}
              baseRevision={project.revision}
              mode={resourceEditor.mode}
              newResourceId={resourceEditor.newResourceId}
              initial={selectedResource?.kind === "ExpertTeam" ? selectedResource : undefined}
              error={expertError}
              onCancel={closeResourceEditor}
              onSave={async (resource, expectedRevision, requiredUnchangedRefs) => {
                await savePragmaResource(resource, expectedRevision, requiredUnchangedRefs);
              }}
            />
          ) : (
            <FlowEditor
              project={project}
              expertOptions={experts.flatMap((expert) =>
                expert.ref === undefined ? [] : [{ ref: expert.ref, name: expert.name }],
              )}
              baseRevision={project.revision}
              mode={resourceEditor.mode}
              runtimes={runtimes}
              initial={
                resourceEditor.mode === "create"
                  ? resourceEditor.newResourceId === undefined
                    ? undefined
                    : createEmptyFlow(resourceEditor.newResourceId)
                  : selectedResource?.kind === "Flow"
                    ? selectedResource
                    : undefined
              }
              error={expertError}
              onCancel={closeResourceEditor}
              onSave={saveFlowResource}
            />
          )
        ) : null}
        {expertError ? (
          <p className="form-error studio-page-error" role="alert">
            {expertError}
          </p>
        ) : null}
        {screen === "directory" &&
        (activeView === "teams" || activeView === "flows") &&
        project !== null ? (
          <PragmaResourceDirectoryFragment
            kind={activeView === "teams" ? "team" : "flow"}
            project={project}
            onOpen={openResourceDetail}
            onCreate={openResourceCreate}
          />
        ) : null}
      </div>
      {contextDrawerOpen && selectedExpert !== null ? (
        <ExpertContextMountDrawer
          expertName={selectedExpert.name}
          stores={contextStores}
          mounts={selectedExpert.contextStoreMounts}
          onClose={() => setContextDrawerOpen(false)}
          onSave={saveContextMounts}
          onCreateStore={createContextStore}
          onInspectImport={inspectContextStoreImport}
          onStoreCreated={(store) =>
            setContextStores((current) =>
              current.some((item) => item.id === store.id) ? current : [store, ...current],
            )
          }
          onPickFolder={pickContextStoreFolder}
        />
      ) : null}
    </section>
  );
}
