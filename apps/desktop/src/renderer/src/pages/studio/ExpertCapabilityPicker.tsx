import { BookOpenText, Database, MagnifyingGlass, Network, Wrench, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { PragmaResource } from "@pragma/interpreter/ast";

import type { Capability, ContextStore } from "../../../../shared/desktop-api.ts";
import type { ExpertDraft } from "./studio-model.ts";

type PickerKind = "resources" | "context-stores" | "skills" | "tools";
type InvocableResource = Extract<
  PragmaResource,
  { readonly kind: "Expert" | "ExpertTeam" | "Flow" }
>;

const pickerCopy = {
  resources: {
    eyebrow: "As tools",
    title: "Experts, teams & flows",
    description: "Let this expert call other Pragma resources when a task needs them.",
    searchPlaceholder: "Search experts, teams, and flows",
  },
  "context-stores": {
    eyebrow: "Knowledge",
    title: "Context stores",
    description: "Mount the stores this expert can use for durable context.",
    searchPlaceholder: "Search context stores",
  },
  skills: {
    eyebrow: "Guidance",
    title: "Skills",
    description: "Load reusable instructions and specialist workflows.",
    searchPlaceholder: "Search skills",
  },
  tools: {
    eyebrow: "Actions",
    title: "Tools",
    description: "Choose individual MCP, HTTP, and code tools this expert can call.",
    searchPlaceholder: "Search tools and services",
  },
} as const;

function isInvocableResource(resource: PragmaResource): resource is InvocableResource {
  return resource.kind === "Expert" || resource.kind === "ExpertTeam" || resource.kind === "Flow";
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function includesQuery(query: string, ...values: readonly (string | undefined)[]): boolean {
  const term = normalized(query);
  return term.length === 0 || values.some((value) => normalized(value ?? "").includes(term));
}

function resourceDetails(resource: InvocableResource): {
  readonly kind: "expert" | "team" | "flow";
  readonly label: string;
  readonly ref: string;
} {
  const kind =
    resource.kind === "Expert" ? "expert" : resource.kind === "ExpertTeam" ? "team" : "flow";
  return {
    kind,
    label: resource.kind === "ExpertTeam" ? "Expert team" : resource.kind,
    ref: `${kind}:${resource.metadata.id}@${resource.metadata.version}`,
  };
}

function serviceLabel(capability: Capability): string {
  switch (capability.definition.kind) {
    case "mcp_server":
      return "MCP server";
    case "http_service":
      return "HTTP service";
    case "code_service":
      return "Code service";
    case "skill":
      return "Skill";
  }
}

function getTools(capability: Capability) {
  const definition = capability.definition;
  return definition.kind === "skill"
    ? []
    : definition.kind === "code_service"
      ? [definition.tool]
      : definition.tools;
}

export function matchingToolNames(capability: Capability, query: string): readonly string[] {
  const tools = getTools(capability);
  const serviceMatches = includesQuery(
    query,
    capability.manifest.name,
    capability.manifest.id,
    capability.definition.description,
    serviceLabel(capability),
  );
  return (
    serviceMatches
      ? tools
      : tools.filter((tool) => includesQuery(query, tool.name, tool.description))
  ).map((tool) => tool.name);
}

function SummaryNames(props: { readonly names: readonly string[] }) {
  if (props.names.length === 0) {
    return <span className="capability-summary-empty">None selected</span>;
  }
  const visible = props.names.slice(0, 3);
  return (
    <span className="capability-summary-names">
      {visible.map((name, index) => (
        <span key={`${name}-${index}`}>{name}</span>
      ))}
      {props.names.length > visible.length ? (
        <span>+{props.names.length - visible.length} more</span>
      ) : null}
    </span>
  );
}

export function ExpertCapabilityPicker(props: {
  readonly currentExpertId: string;
  readonly resources: readonly PragmaResource[];
  readonly contextStores: readonly ContextStore[];
  readonly capabilities: readonly Capability[];
  readonly resourceTools: ExpertDraft["resourceTools"];
  readonly contextStoreMounts: ExpertDraft["contextStoreMounts"];
  readonly capabilityReferences: ExpertDraft["capabilities"];
  readonly onResourceToolsChange: (value: ExpertDraft["resourceTools"]) => void;
  readonly onContextStoreMountsChange: (value: ExpertDraft["contextStoreMounts"]) => void;
  readonly onCapabilityReferencesChange: (value: ExpertDraft["capabilities"]) => void;
}) {
  const [activePicker, setActivePicker] = useState<PickerKind | null>(null);
  const [search, setSearch] = useState("");
  const invocableResources = useMemo(
    () =>
      props.resources.filter(
        (resource): resource is InvocableResource =>
          isInvocableResource(resource) &&
          !(resource.kind === "Expert" && resource.metadata.id === props.currentExpertId),
      ),
    [props.currentExpertId, props.resources],
  );
  const skills = props.capabilities.filter((capability) => capability.definition.kind === "skill");
  const toolServices = props.capabilities.filter(
    (capability) => capability.definition.kind !== "skill",
  );
  const allToolCount = toolServices.reduce(
    (total, capability) => total + getTools(capability).length,
    0,
  );
  const selectedSkillReferences = props.capabilityReferences.filter(
    (reference) => reference.kind === "skill",
  );
  const selectedToolReferences = props.capabilityReferences.filter(
    (reference) => reference.kind === "tools",
  );
  const selectedToolCount = selectedToolReferences.reduce(
    (total, reference) => total + reference.toolNames.length,
    0,
  );

  const closePicker = () => {
    setActivePicker(null);
    setSearch("");
  };
  const openPicker = (picker: PickerKind) => {
    setSearch("");
    setActivePicker(picker);
  };

  useEffect(() => {
    if (activePicker === null) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePicker();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [activePicker]);

  const selectedResourceNames = props.resourceTools.flatMap((binding) => {
    const resource = invocableResources.find(
      (candidate) => resourceDetails(candidate).ref === binding.target?.ref,
    );
    return resource ? [resource.metadata.name] : [];
  });
  const selectedStoreNames = props.contextStoreMounts.flatMap((mount) => {
    const store = props.contextStores.find((candidate) => candidate.id === mount.storeId);
    return store ? [store.name] : [];
  });
  const selectedSkillNames = selectedSkillReferences.flatMap((reference) => {
    const skill = skills.find((candidate) => candidate.manifest.id === reference.capabilityId);
    return skill ? [skill.manifest.name] : [];
  });
  const selectedToolNames = selectedToolReferences.flatMap((reference) => reference.toolNames);

  const summaries: readonly {
    readonly id: PickerKind;
    readonly icon: typeof Network;
    readonly selected: number;
    readonly available: number;
    readonly names: readonly string[];
  }[] = [
    {
      id: "resources",
      icon: Network,
      selected: props.resourceTools.length,
      available: invocableResources.length,
      names: selectedResourceNames,
    },
    {
      id: "context-stores",
      icon: Database,
      selected: props.contextStoreMounts.length,
      available: props.contextStores.length,
      names: selectedStoreNames,
    },
    {
      id: "skills",
      icon: BookOpenText,
      selected: selectedSkillReferences.length,
      available: skills.length,
      names: selectedSkillNames,
    },
    {
      id: "tools",
      icon: Wrench,
      selected: selectedToolCount,
      available: allToolCount,
      names: selectedToolNames,
    },
  ];

  const clearActivePicker = () => {
    switch (activePicker) {
      case "resources":
        props.onResourceToolsChange([]);
        break;
      case "context-stores":
        props.onContextStoreMountsChange([]);
        break;
      case "skills":
        props.onCapabilityReferencesChange(
          props.capabilityReferences.filter((reference) => reference.kind !== "skill"),
        );
        break;
      case "tools":
        props.onCapabilityReferencesChange(
          props.capabilityReferences.filter((reference) => reference.kind !== "tools"),
        );
        break;
      case null:
        break;
    }
  };

  const activeSelectedCount =
    activePicker === "resources"
      ? props.resourceTools.length
      : activePicker === "context-stores"
        ? props.contextStoreMounts.length
        : activePicker === "skills"
          ? selectedSkillReferences.length
          : selectedToolCount;

  const updateToolReference = (capability: Capability, toolNames: readonly string[]) => {
    const existing = selectedToolReferences.find(
      (reference) => reference.capabilityId === capability.manifest.id,
    );
    const without = props.capabilityReferences.filter((reference) => reference !== existing);
    props.onCapabilityReferencesChange(
      toolNames.length === 0
        ? without
        : [
            ...without,
            {
              kind: "tools",
              capabilityId: capability.manifest.id,
              revision: existing?.revision ?? capability.manifest.latestRevision,
              toolNames: [...toolNames],
            },
          ],
    );
  };

  return (
    <>
      <section className="capability-summary-section" aria-labelledby="capability-library-heading">
        <div className="capability-section-heading">
          <div>
            <h3 id="capability-library-heading">Capability library</h3>
            <p>Open a category to search and choose only what this expert needs.</p>
          </div>
          <span>
            {props.resourceTools.length +
              props.contextStoreMounts.length +
              selectedSkillReferences.length +
              selectedToolCount}{" "}
            selected
          </span>
        </div>
        <div className="capability-summary-grid">
          {summaries.map((summary) => {
            const copy = pickerCopy[summary.id];
            const Icon = summary.icon;
            return (
              <article className="capability-summary-card" key={summary.id}>
                <header>
                  <span className="capability-summary-icon">
                    <Icon size={19} aria-hidden="true" />
                  </span>
                  <span className="capability-summary-count">
                    <strong>{summary.selected}</strong> selected
                  </span>
                </header>
                <div>
                  <small>{copy.eyebrow}</small>
                  <h4>{copy.title}</h4>
                  <p>{copy.description}</p>
                </div>
                <SummaryNames names={summary.names} />
                <footer>
                  <span>{summary.available} available</span>
                  <button type="button" onClick={() => openPicker(summary.id)}>
                    {summary.selected > 0 ? "Edit selection" : "Choose"}
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      </section>

      {activePicker !== null ? (
        <div
          className="expert-picker-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePicker();
          }}
        >
          <aside
            className="expert-picker-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="expert-picker-heading"
          >
            <header className="expert-picker-heading">
              <div>
                <small>{pickerCopy[activePicker].eyebrow}</small>
                <h2 id="expert-picker-heading">{pickerCopy[activePicker].title}</h2>
                <p>{pickerCopy[activePicker].description}</p>
              </div>
              <button type="button" aria-label="Close capability picker" onClick={closePicker}>
                <X size={19} aria-hidden="true" />
              </button>
            </header>
            <label className="expert-picker-search">
              <MagnifyingGlass size={18} aria-hidden="true" />
              <span className="sr-only">{pickerCopy[activePicker].searchPlaceholder}</span>
              <input
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={pickerCopy[activePicker].searchPlaceholder}
              />
              {search ? (
                <button type="button" aria-label="Clear search" onClick={() => setSearch("")}>
                  <X size={16} aria-hidden="true" />
                </button>
              ) : null}
            </label>
            <div className="expert-picker-toolbar">
              <span>{activeSelectedCount} selected</span>
              {activeSelectedCount > 0 ? (
                <button type="button" onClick={clearActivePicker}>
                  Clear selection
                </button>
              ) : null}
            </div>
            <div className="expert-picker-results">
              {activePicker === "resources" ? (
                <ResourceResults
                  resources={invocableResources}
                  query={search}
                  selected={props.resourceTools}
                  onChange={props.onResourceToolsChange}
                />
              ) : null}
              {activePicker === "context-stores" ? (
                <ContextStoreResults
                  stores={props.contextStores}
                  query={search}
                  selected={props.contextStoreMounts}
                  onChange={props.onContextStoreMountsChange}
                />
              ) : null}
              {activePicker === "skills" ? (
                <SkillResults
                  capabilities={skills}
                  query={search}
                  references={props.capabilityReferences}
                  onChange={props.onCapabilityReferencesChange}
                />
              ) : null}
              {activePicker === "tools" ? (
                <ToolResults
                  capabilities={toolServices}
                  query={search}
                  references={props.capabilityReferences}
                  onUpdate={updateToolReference}
                  onUpgrade={(selected, capability) =>
                    props.onCapabilityReferencesChange(
                      props.capabilityReferences.map((reference) =>
                        reference === selected
                          ? { ...reference, revision: capability.manifest.latestRevision }
                          : reference,
                      ),
                    )
                  }
                />
              ) : null}
            </div>
            <footer className="expert-picker-actions">
              <span>Changes are applied to this expert immediately.</span>
              <button className="primary-button" type="button" onClick={closePicker}>
                Done
              </button>
            </footer>
          </aside>
        </div>
      ) : null}
    </>
  );
}

function EmptyResults(props: { readonly hasQuery: boolean; readonly label: string }) {
  return (
    <div className="expert-picker-empty">
      <strong>{props.hasQuery ? "No matches found" : `No ${props.label} available`}</strong>
      <p>
        {props.hasQuery
          ? "Try a different name or description."
          : "Add items in Studio, then return here."}
      </p>
    </div>
  );
}

function ResourceResults(props: {
  readonly resources: readonly InvocableResource[];
  readonly query: string;
  readonly selected: ExpertDraft["resourceTools"];
  readonly onChange: (value: ExpertDraft["resourceTools"]) => void;
}) {
  const visible = props.resources.filter((resource) => {
    const details = resourceDetails(resource);
    return includesQuery(
      props.query,
      resource.metadata.name,
      resource.metadata.id,
      resource.metadata.version,
      details.label,
    );
  });
  if (visible.length === 0)
    return <EmptyResults hasQuery={Boolean(props.query.trim())} label="resources" />;
  return (
    <div className="expert-picker-list">
      {visible.map((resource) => {
        const details = resourceDetails(resource);
        const selected = props.selected.some((binding) => binding.target?.ref === details.ref);
        return (
          <label className="expert-picker-row" key={details.ref}>
            <input
              type="checkbox"
              checked={selected}
              onChange={(event) =>
                props.onChange(
                  event.target.checked
                    ? [
                        ...props.selected,
                        {
                          adapter: "pragma.tool.call@v1",
                          target: { ref: details.ref },
                          tool: {
                            name: `call_${details.kind}_${resource.metadata.id}`.replace(
                              /[^A-Za-z0-9_-]/g,
                              "_",
                            ),
                            description: `Call ${resource.metadata.name}.`,
                            approval: "ask",
                          },
                        },
                      ]
                    : props.selected.filter((binding) => binding.target?.ref !== details.ref),
                )
              }
            />
            <span>
              <strong>{resource.metadata.name}</strong>
              <small>
                {details.label} · {resource.metadata.version}
              </small>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function ContextStoreResults(props: {
  readonly stores: readonly ContextStore[];
  readonly query: string;
  readonly selected: ExpertDraft["contextStoreMounts"];
  readonly onChange: (value: ExpertDraft["contextStoreMounts"]) => void;
}) {
  const visible = props.stores.filter((store) =>
    includesQuery(
      props.query,
      store.name,
      store.description,
      store.type === "file" ? "File store" : "Context note",
    ),
  );
  if (visible.length === 0)
    return <EmptyResults hasQuery={Boolean(props.query.trim())} label="context stores" />;
  return (
    <div className="expert-picker-list">
      {visible.map((store) => {
        const mounted = props.selected.some((mount) => mount.storeId === store.id);
        return (
          <label className="expert-picker-row" key={store.id}>
            <input
              type="checkbox"
              checked={mounted}
              onChange={() => {
                const next = mounted
                  ? props.selected.filter((mount) => mount.storeId !== store.id)
                  : [
                      ...props.selected,
                      { storeId: store.id, enabled: true, priority: props.selected.length },
                    ];
                props.onChange(next.map((mount, priority) => ({ ...mount, priority })));
              }}
            />
            <span>
              <strong>{store.name}</strong>
              <small>
                {store.description || (store.type === "file" ? "File store" : "Context note")}
              </small>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function SkillResults(props: {
  readonly capabilities: readonly Capability[];
  readonly query: string;
  readonly references: ExpertDraft["capabilities"];
  readonly onChange: (value: ExpertDraft["capabilities"]) => void;
}) {
  const visible = props.capabilities.filter((capability) =>
    includesQuery(
      props.query,
      capability.manifest.name,
      capability.manifest.id,
      capability.definition.description,
    ),
  );
  if (visible.length === 0)
    return <EmptyResults hasQuery={Boolean(props.query.trim())} label="skills" />;
  return (
    <div className="expert-picker-list">
      {visible.map((capability) => {
        const selected = props.references.find(
          (reference) =>
            reference.kind === "skill" && reference.capabilityId === capability.manifest.id,
        );
        const unavailable = capability.health.status !== "ready" && selected === undefined;
        return (
          <label
            className={`expert-picker-row${unavailable ? " is-disabled" : ""}`}
            key={capability.manifest.id}
          >
            <input
              type="checkbox"
              disabled={unavailable}
              checked={selected !== undefined}
              onChange={() =>
                props.onChange(
                  selected === undefined
                    ? [
                        ...props.references,
                        {
                          kind: "skill",
                          capabilityId: capability.manifest.id,
                          revision: capability.manifest.latestRevision,
                        },
                      ]
                    : props.references.filter((reference) => reference !== selected),
                )
              }
            />
            <span>
              <strong>{capability.manifest.name}</strong>
              <small>
                {capability.definition.description}
                {unavailable ? " · Needs attention" : ""}
              </small>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function ToolResults(props: {
  readonly capabilities: readonly Capability[];
  readonly query: string;
  readonly references: ExpertDraft["capabilities"];
  readonly onUpdate: (capability: Capability, toolNames: readonly string[]) => void;
  readonly onUpgrade: (
    selected: Extract<ExpertDraft["capabilities"][number], { readonly kind: "tools" }>,
    capability: Capability,
  ) => void;
}) {
  const visible = props.capabilities.flatMap((capability) => {
    const tools = getTools(capability);
    const matchingNames = matchingToolNames(capability, props.query);
    const visibleTools = tools.filter((tool) => matchingNames.includes(tool.name));
    return visibleTools.length > 0 ? [{ capability, tools, visibleTools }] : [];
  });
  if (visible.length === 0)
    return <EmptyResults hasQuery={Boolean(props.query.trim())} label="tools" />;
  return (
    <div className="expert-tool-results">
      {visible.map(({ capability, tools, visibleTools }) => {
        const found = props.references.find(
          (reference) =>
            reference.kind === "tools" && reference.capabilityId === capability.manifest.id,
        );
        const selected = found?.kind === "tools" ? found : undefined;
        const selectedNames = selected?.toolNames ?? [];
        const unavailable = capability.health.status !== "ready" && selected === undefined;
        const allSelected =
          tools.length > 0 && tools.every((tool) => selectedNames.includes(tool.name));
        return (
          <section
            className={`expert-tool-service${unavailable ? " is-disabled" : ""}`}
            key={capability.manifest.id}
          >
            <header>
              <div>
                <strong>{capability.manifest.name}</strong>
                <small>
                  {serviceLabel(capability)} · {selectedNames.length} of {tools.length} selected
                  {unavailable ? " · Needs attention" : ""}
                </small>
              </div>
              <div>
                {selected && selected.revision < capability.manifest.latestRevision ? (
                  <button type="button" onClick={() => props.onUpgrade(selected, capability)}>
                    Upgrade to r{capability.manifest.latestRevision}
                  </button>
                ) : null}
                <label>
                  <input
                    type="checkbox"
                    disabled={unavailable}
                    checked={allSelected}
                    onChange={() =>
                      props.onUpdate(capability, allSelected ? [] : tools.map((tool) => tool.name))
                    }
                  />{" "}
                  Select all
                </label>
              </div>
            </header>
            <div className="expert-picker-list">
              {visibleTools.map((tool) => {
                const checked = selectedNames.includes(tool.name);
                return (
                  <label className="expert-picker-row expert-tool-row" key={tool.name}>
                    <input
                      type="checkbox"
                      disabled={unavailable}
                      checked={checked}
                      onChange={() =>
                        props.onUpdate(
                          capability,
                          checked
                            ? selectedNames.filter((name) => name !== tool.name)
                            : [...selectedNames, tool.name],
                        )
                      }
                    />
                    <span>
                      <strong>{tool.name}</strong>
                      <small>{tool.description ?? "External tool"}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
