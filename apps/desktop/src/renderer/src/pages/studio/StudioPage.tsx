import { useEffect, useState } from "react";

import type {
  CreateExpertDefinition,
  ModelProvider,
  UpdateExpertDefinition,
} from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";
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

  return (
    <section className="studio-page">
      <nav className="studio-navigation" aria-label="Studio sections">
        {studioSections.map((section) => {
          const SectionIcon = section.icon;
          const isActive = section.id === activeView;
          const count =
            section.id === "overview"
              ? undefined
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
            onBack={openDirectory}
            onEdit={() => openCreate(selectedExpert)}
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
    </section>
  );
}
