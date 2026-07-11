import { useEffect, useState } from "react";

import type {
  ContextStore,
  CreateContextStore,
  CreateExpertDefinition,
  ExpertContextStoreMount,
  ModelProvider,
  UpdateExpertDefinition,
} from "../../../../shared/desktop-api.ts";
import { ContextStoreSchema } from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";
import {
  ContextStoreDirectoryFragment,
  ExpertContextMountDrawer,
} from "./ContextStoreFragment.tsx";
import { ExpertDetailFragment, ExpertDirectoryFragment } from "./ExpertDirectoryFragment.tsx";
import { ExpertEditorFragment } from "./ExpertEditorFragment.tsx";
import { StudioCollectionFragment, StudioOverviewFragment } from "./StudioOverviewFragment.tsx";
import {
  collectionAssets,
  desktopApi,
  emptyDraft,
  initialExperts,
  studioSections,
  toExpertRecord,
  toPersistedInput,
  type ExpertDraft,
  type ExpertRecord,
  type StudioView,
} from "./studio-model.ts";

export function StudioPage() {
  const [activeView, setActiveView] = useState<StudioView>("experts");
  const [screen, setScreen] = useState<"directory" | "detail" | "create">("directory");
  const [experts, setExperts] = useState<readonly ExpertRecord[]>(initialExperts);
  const [selectedExpert, setSelectedExpert] = useState<ExpertRecord>(initialExperts[0]!);
  const [draft, setDraft] = useState<ExpertDraft>(emptyDraft());
  const [modelProviders, setModelProviders] = useState<readonly ModelProvider[]>([]);
  const [contextStores, setContextStores] = useState<readonly ContextStore[]>([]);
  const [contextDrawerOpen, setContextDrawerOpen] = useState(false);
  const [expertError, setExpertError] = useState<string | null>(null);

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
        if (storedExperts[0] !== undefined) setSelectedExpert(storedExperts[0]);
        setExpertError(null);
      } catch (loadError) {
        if (cancelled) return;
        setExpertError(errorMessage(loadError));
      }
    })();
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
    return () => {
      cancelled = true;
    };
  }, []);
  const openDirectory = () => {
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
    }
    setExperts((current) =>
      current.some((item) => item.id === saved.id)
        ? current.map((item) => (item.id === saved.id ? saved : item))
        : [saved, ...current],
    );
    setSelectedExpert(saved);
    setExpertError(null);
    setScreen("detail");
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
  const saveContextMounts = async (mounts: readonly ExpertContextStoreMount[]) => {
    const updated = { ...selectedExpert, contextStoreMounts: [...mounts] };
    await saveExpert(updated);
    setContextDrawerOpen(false);
  };

  return (
    <section className="studio-page">
      <nav className="studio-navigation" aria-label="Studio sections">
        {studioSections.map((section) => {
          const SectionIcon = section.icon;
          const isActive = section.id === activeView;
          const count =
            section.id === "overview"
              ? undefined
              : section.id === "context-stores"
                ? contextStores.length
                : section.id === "experts"
                  ? experts.length
                  : collectionAssets[section.id].length;
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
        {screen === "detail" ? (
          <ExpertDetailFragment
            expert={selectedExpert}
            contextStores={contextStores}
            onBack={openDirectory}
            onEdit={() => openCreate(selectedExpert)}
            onConfigureContext={() => setContextDrawerOpen(true)}
          />
        ) : null}
        {screen === "create" ? (
          <ExpertEditorFragment
            initialValue={draft}
            modelProviders={modelProviders}
            onCancel={openDirectory}
            onCreated={saveExpert}
          />
        ) : null}
        {screen === "directory" && activeView === "experts" ? (
          <ExpertDirectoryFragment
            experts={experts}
            onCreate={() => openCreate()}
            onOpen={(expert) => {
              setSelectedExpert(expert);
              setScreen("detail");
            }}
          />
        ) : null}
        {screen === "directory" && activeView === "context-stores" ? (
          <ContextStoreDirectoryFragment
            stores={contextStores}
            onCreate={createContextStore}
            onPickFolder={pickContextStoreFolder}
          />
        ) : null}
        {expertError ? (
          <p className="form-error" role="alert">
            {expertError}
          </p>
        ) : null}
        {screen === "directory" && activeView === "overview" ? (
          <StudioOverviewFragment
            experts={experts}
            onNavigate={(view) => {
              setActiveView(view);
              setScreen("directory");
            }}
          />
        ) : null}
        {screen === "directory" && (activeView === "teams" || activeView === "tools") ? (
          <StudioCollectionFragment view={activeView} />
        ) : null}
      </div>
      {contextDrawerOpen ? (
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
