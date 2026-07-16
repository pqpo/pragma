import { useEffect, useState } from "react";

import type {
  ContextStore,
  Capability,
  ContextNoteEntry,
  CreateContextStore,
  CreateExpertDefinition,
  ExpertContextStoreMount,
  DesktopRuntimeAvailability,
  ModelProvider,
  PragmaProjectSnapshot,
  UpdateExpertDefinition,
} from "../../../../shared/desktop-api.ts";
import { ContextStoreSchema } from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";
import {
  ContextStoreDetailFragment,
  ContextStoreDirectoryFragment,
  ExpertContextMountDrawer,
} from "./ContextStoreFragment.tsx";
import { ExpertDetailFragment, ExpertDirectoryFragment } from "./ExpertDirectoryFragment.tsx";
import { ExpertEditorFragment } from "./ExpertEditorFragment.tsx";
import { CapabilityDirectoryFragment } from "./CapabilityDirectoryFragment.tsx";
import { PragmaResourceDirectoryFragment } from "./PragmaResourceDirectoryFragment.tsx";
import {
  desktopApi,
  emptyDraft,
  studioSections,
  toExpertRecord,
  toPersistedInput,
  type ExpertDraft,
  type ExpertRecord,
  type StudioView,
} from "./studio-model.ts";

export function StudioPage() {
  const [activeView, setActiveView] = useState<StudioView>("experts");
  const [screen, setScreen] = useState<
    "directory" | "expert-detail" | "context-store-detail" | "create"
  >("directory");
  const [experts, setExperts] = useState<readonly ExpertRecord[]>([]);
  const [selectedExpert, setSelectedExpert] = useState<ExpertRecord | null>(null);
  const [draft, setDraft] = useState<ExpertDraft>(emptyDraft());
  const [modelProviders, setModelProviders] = useState<readonly ModelProvider[]>([]);
  const [runtimes, setRuntimes] = useState<readonly DesktopRuntimeAvailability[]>([]);
  const [contextStores, setContextStores] = useState<readonly ContextStore[]>([]);
  const [selectedContextStoreId, setSelectedContextStoreId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<readonly Capability[]>([]);
  const [contextDrawerOpen, setContextDrawerOpen] = useState(false);
  const [expertError, setExpertError] = useState<string | null>(null);
  const [project, setProject] = useState<PragmaProjectSnapshot | null>(null);

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const summaries = await api.listExperts();
        const definitions = await Promise.all(
          summaries.map((summary) => api.getExpert(summary.id)),
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
      .listModelProviders()
      .then((providers) => {
        if (!cancelled) setModelProviders(providers);
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
  const openCreate = (expert?: ExpertRecord) => {
    setDraft(expert === undefined ? emptyDraft() : { ...expert, tagInput: "" });
    setScreen("create");
  };
  const saveExpert = async (expert: ExpertRecord) => {
    const api = desktopApi();
    let saved = expert;
    if (api !== undefined) {
      const input = toPersistedInput(expert);
      const definition =
        expert.persisted === undefined
          ? await api.createExpert(input as CreateExpertDefinition)
          : await api.updateExpert(expert.id, input as UpdateExpertDefinition);
      saved = toExpertRecord(definition);
      setProject(await api.getPragmaProject());
    }
    setExperts((current) =>
      current.some((item) => item.id === saved.id)
        ? current.map((item) => (item.id === saved.id ? saved : item))
        : [saved, ...current],
    );
    setSelectedExpert(saved);
    setExpertError(null);
    setScreen("expert-detail");
  };
  const createContextStore = async (input: CreateContextStore): Promise<ContextStore> => {
    const api = desktopApi();
    const timestamp = new Date().toISOString();
    const store =
      api === undefined
        ? ContextStoreSchema.parse({
            schemaVersion: "pragma.context-store/v1",
            id: crypto.randomUUID(),
            ...input,
            ...(input.type === "note" ? { entries: [] } : {}),
            status: input.type === "file" ? "configured" : "ready",
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
  const addContextNoteEntry = async (
    storeId: string,
    entry: ContextNoteEntry,
  ): Promise<ContextStore> => {
    const api = desktopApi();
    const current = contextStores.find((store) => store.id === storeId);
    if (current?.type !== "note") throw new Error("Context note store not found.");
    const updated =
      api === undefined
        ? ContextStoreSchema.parse({
            ...current,
            entries: [...current.entries, entry],
            updatedAt: new Date().toISOString(),
          })
        : await api.addContextNoteEntry({ storeId, entry });
    setContextStores((stores) => stores.map((store) => (store.id === storeId ? updated : store)));
    return updated;
  };
  const saveContextMounts = async (mounts: readonly ExpertContextStoreMount[]) => {
    if (selectedExpert === null) return;
    const updated = { ...selectedExpert, contextStoreMounts: [...mounts] };
    await saveExpert(updated);
    setContextDrawerOpen(false);
  };
  const selectedContextStore =
    contextStores.find((store) => store.id === selectedContextStoreId) ?? null;

  return (
    <section className="studio-page">
      <nav className="studio-navigation" aria-label="Studio sections">
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
                    : section.id === "capabilities"
                      ? capabilities.length
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
              }}
            >
              <SectionIcon size={20} weight={isActive ? "fill" : "regular"} aria-hidden="true" />
              <span>{section.label}</span>
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
          />
        ) : null}
        {screen === "create" ? (
          <ExpertEditorFragment
            initialValue={draft}
            modelProviders={modelProviders}
            runtimes={runtimes}
            contextStores={contextStores}
            capabilities={capabilities}
            resources={project?.resources ?? []}
            existingExpertIds={experts.map((expert) => expert.id)}
            onCancel={openExpertDirectory}
            onCreated={saveExpert}
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
            onAddNoteEntry={addContextNoteEntry}
          />
        ) : null}
        {screen === "directory" && activeView === "capabilities" ? (
          <CapabilityDirectoryFragment
            capabilities={capabilities}
            onChanged={(capability, removedId) => {
              if (removedId !== undefined) {
                setCapabilities((current) =>
                  current.filter((item) => item.manifest.id !== removedId),
                );
                return;
              }
              if (capability === undefined) return;
              setCapabilities((current) =>
                current.some((item) => item.manifest.id === capability.manifest.id)
                  ? current.map((item) =>
                      item.manifest.id === capability.manifest.id ? capability : item,
                    )
                  : [capability, ...current],
              );
            }}
          />
        ) : null}
        {expertError ? (
          <p className="form-error" role="alert">
            {expertError}
          </p>
        ) : null}
        {screen === "directory" &&
        (activeView === "teams" || activeView === "flows") &&
        project !== null ? (
          <PragmaResourceDirectoryFragment
            kind={activeView === "teams" ? "team" : "flow"}
            project={project}
            onProjectChanged={setProject}
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
