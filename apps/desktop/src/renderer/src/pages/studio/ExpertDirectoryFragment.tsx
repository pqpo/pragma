import {
  ArrowLeft,
  BookOpenText,
  CaretDown,
  CaretRight,
  Info,
  Folder,
  MagnifyingGlass,
  PencilSimple,
  Play,
  Plus,
} from "@phosphor-icons/react";
import { useState } from "react";

import type { ContextStore } from "../../../../shared/desktop-api.ts";
import type { ExpertRecord } from "./studio-model.ts";

const DESCRIPTION_PREVIEW_LENGTH = 200;
const INSTRUCTIONS_PREVIEW_LENGTH = 420;

function truncateText(value: string, maximumLength: number): string {
  const normalized = value.trim();
  return normalized.length > maximumLength
    ? `${normalized.slice(0, maximumLength).trimEnd()}…`
    : normalized;
}

export function ExpertDirectoryFragment(props: {
  readonly experts: readonly ExpertRecord[];
  readonly onCreate: () => void;
  readonly onOpen: (expert: ExpertRecord) => void;
}) {
  const [query, setQuery] = useState("");
  const matchingExperts = props.experts.filter((expert) =>
    `${expert.name} ${expert.description} ${expert.tags.join(" ")}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );

  return (
    <section className="expert-directory" aria-labelledby="experts-heading">
      <header className="studio-heading expert-directory-heading">
        <div>
          <h1 id="experts-heading">Experts</h1>
          <p>Reusable specialists available to your missions.</p>
        </div>
        <button className="primary-button" type="button" onClick={props.onCreate}>
          <Plus size={17} aria-hidden="true" />
          Create expert
        </button>
      </header>

      <div className="directory-controls">
        <label className="directory-search">
          <MagnifyingGlass size={18} aria-hidden="true" />
          <span className="sr-only">Search experts</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search experts"
          />
        </label>
        <button className="directory-filter" type="button">
          All experts
          <CaretDown size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="expert-table" role="list" aria-label="Available experts">
        <div className="expert-table-heading" aria-hidden="true">
          <span>Expert</span>
          <span>Tags</span>
          <span>Scope</span>
        </div>
        {matchingExperts.map((expert) => {
          const ExpertIcon = expert.icon;
          return (
            <button
              className="expert-list-row"
              type="button"
              key={expert.id}
              onClick={() => props.onOpen(expert)}
            >
              <span className="expert-list-name">
                <span className="studio-asset-icon" aria-hidden="true">
                  <ExpertIcon size={24} weight="regular" />
                </span>
                <span>
                  <strong>{expert.name}</strong>
                  <small>{expert.description}</small>
                </span>
              </span>
              <span className="expert-tag-list">
                {expert.tags.slice(0, 2).map((tag) => (
                  <em key={tag}>{tag}</em>
                ))}
              </span>
              <span className="expert-list-scope">{expert.scope}</span>
              <CaretRight size={19} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <p className="directory-count">{matchingExperts.length} experts</p>
    </section>
  );
}

export function ExpertDetailFragment(props: {
  readonly expert: ExpertRecord;
  readonly contextStores: readonly ContextStore[];
  readonly onBack: () => void;
  readonly onEdit: () => void;
  readonly onConfigureContext: () => void;
  readonly onTryInSession: () => void;
}) {
  const ExpertIcon = props.expert.icon;
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  const hasLongInstructions = props.expert.instructions.trim().length > INSTRUCTIONS_PREVIEW_LENGTH;
  const displayedInstructions =
    hasLongInstructions && !instructionsExpanded
      ? truncateText(props.expert.instructions, INSTRUCTIONS_PREVIEW_LENGTH)
      : props.expert.instructions.trim();
  return (
    <section className="expert-detail" aria-labelledby="expert-name">
      <button className="back-link" type="button" onClick={props.onBack}>
        <ArrowLeft size={18} aria-hidden="true" />
        Back to Experts
      </button>
      <header className="expert-detail-header">
        <span className="expert-avatar" aria-hidden="true">
          <ExpertIcon size={42} weight="regular" />
        </span>
        <div className="expert-detail-title">
          <div>
            <h1 id="expert-name">{props.expert.name}</h1>
            <span className="version-label">v{props.expert.version}</span>
            <span className="expert-id-label">ID: {props.expert.id}</span>
          </div>
          <p>{truncateText(props.expert.description, DESCRIPTION_PREVIEW_LENGTH)}</p>
          <div className="expert-tag-list">
            {props.expert.tags.map((tag) => (
              <em key={tag}>{tag}</em>
            ))}
          </div>
        </div>
        <div className="detail-actions">
          <button className="primary-button" type="button" onClick={props.onEdit}>
            <PencilSimple size={17} aria-hidden="true" />
            Edit expert
          </button>
          <button className="secondary-button" type="button" onClick={props.onTryInSession}>
            <Play size={17} aria-hidden="true" />
            Try in session
          </button>
        </div>
      </header>
      <section className="expert-scope" aria-labelledby="expert-scope-heading">
        <h2 id="expert-scope-heading">Scope</h2>
        <p>{props.expert.scope}</p>
      </section>
      <section className="instructions-preview">
        <h2>Instructions</h2>
        <p>{displayedInstructions || "No instructions provided."}</p>
        {hasLongInstructions ? (
          <button
            className="text-button instructions-toggle"
            type="button"
            aria-expanded={instructionsExpanded}
            onClick={() => setInstructionsExpanded((expanded) => !expanded)}
          >
            {instructionsExpanded ? "Show less" : "Show more"}
          </button>
        ) : null}
      </section>
      <section className="expert-capabilities" aria-label="Expert capabilities">
        <div>
          <h2>Model</h2>
          <p>{props.expert.model?.modelName ?? "Not configured"}</p>
        </div>
        <div>
          <h2>Capabilities</h2>
          <p>
            {props.expert.skills} skills <span>•</span> {props.expert.tools} tools <span>•</span>{" "}
            {props.expert.mcpServers} MCP server{props.expert.mcpServers === 1 ? "" : "s"}{" "}
            <span>•</span> {props.expert.plugins.length} plugin
            {props.expert.plugins.length === 1 ? "" : "s"}
          </p>
        </div>
      </section>
      <section className="expert-context-section" aria-labelledby="expert-context-heading">
        <header>
          <div>
            <h2 id="expert-context-heading">Context</h2>
            <p>Reusable stores this expert can apply or retrieve at runtime.</p>
          </div>
          <button className="secondary-button" type="button" onClick={props.onConfigureContext}>
            <Plus size={16} /> Configure context
          </button>
        </header>
        {props.expert.contextStoreMounts.length === 0 ? (
          <p className="expert-context-empty">No context stores mounted.</p>
        ) : (
          <div className="expert-context-list">
            {props.expert.contextStoreMounts.map((mount) => {
              const store = props.contextStores.find((item) => item.id === mount.storeId);
              if (!store) return null;
              const StoreIcon = store.type === "file" ? Folder : BookOpenText;
              const loadingBehavior =
                store.type === "file"
                  ? "From file metadata"
                  : store.entries.length === 1
                    ? store.entries[0]!.trigger === "always_on"
                      ? "Load immediately"
                      : store.entries[0]!.trigger === "model_decision"
                        ? "Model decides"
                        : "On demand"
                    : "Per note entry";
              return (
                <div key={mount.storeId}>
                  <span className="store-icon">
                    <StoreIcon size={20} />
                  </span>
                  <span>
                    <strong>{store.name}</strong>
                    <small>{store.type === "file" ? "File store" : "Context note"}</small>
                  </span>
                  <em>{loadingBehavior}</em>
                  <span className="store-status">
                    <i className="is-ready" />
                    {mount.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
      {props.expert.usesApproval ? (
        <p className="approval-note">
          <Info size={19} aria-hidden="true" /> One tool requires approval before use in sessions.
        </p>
      ) : null}
    </section>
  );
}
