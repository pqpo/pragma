import {
  ArrowLeft,
  CaretDown,
  CaretRight,
  Info,
  MagnifyingGlass,
  PencilSimple,
  Play,
  Plus,
} from "@phosphor-icons/react";
import { useState } from "react";

import type { ExpertRecord } from "./studio-model.ts";

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
  readonly onBack: () => void;
  readonly onEdit: () => void;
}) {
  const ExpertIcon = props.expert.icon;
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
          </div>
          <p>{props.expert.description}</p>
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
          <button className="secondary-button" type="button">
            <Play size={17} aria-hidden="true" />
            Try in session
          </button>
        </div>
      </header>
      <dl className="expert-meta">
        <div>
          <dt>Scope</dt>
          <dd>{props.expert.scope}</dd>
        </div>
        <div>
          <dt>Availability</dt>
          <dd>Any authorized workspace</dd>
        </div>
        <div>
          <dt>ID</dt>
          <dd>{props.expert.id}</dd>
        </div>
      </dl>
      <section className="instructions-preview">
        <h2>Instructions</h2>
        <p>{props.expert.instructions}</p>
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
            {props.expert.mcpServers} MCP server{props.expert.mcpServers === 1 ? "" : "s"}
          </p>
        </div>
      </section>
      {props.expert.usesApproval ? (
        <p className="approval-note">
          <Info size={19} aria-hidden="true" /> One tool requires approval before use in sessions.
        </p>
      ) : null}
    </section>
  );
}
