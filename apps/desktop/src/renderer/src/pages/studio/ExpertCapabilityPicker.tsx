import {
  BookOpenText,
  CaretDown,
  Database,
  MagnifyingGlass,
  Network,
  Wrench,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { PragmaResource } from "@pragma/interpreter/ast";
import { useTranslation } from "react-i18next";

import type { Capability, ContextStore } from "../../../../shared/contracts/index.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import {
  PragmaResourcePickerDialog,
  type PragmaResourcePickerItem,
} from "../../components/PragmaResourcePickerDialog.tsx";
import { ContextStorePickerDialog } from "../../components/ContextStorePickerDialog.tsx";
import type { ExpertDraft } from "./studio-model.ts";

type PickerKind = "resources" | "context-stores" | "skills" | "tools";
const TOOL_SERVICE_PAGE_SIZE = 20;
type InvocableResource = Extract<
  PragmaResource,
  { readonly kind: "Expert" | "ExpertTeam" | "Flow" }
>;

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
    ref: `${kind}:${resource.metadata.id}`,
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

export function updateToolSelection(input: {
  readonly capability: Capability;
  readonly capabilityReferences: ExpertDraft["capabilities"];
  readonly toolApprovals: ExpertDraft["toolApprovals"];
  readonly toolNames: readonly string[];
}): {
  readonly capabilityReferences: ExpertDraft["capabilities"];
  readonly toolApprovals: ExpertDraft["toolApprovals"];
} {
  const existing = input.capabilityReferences.find(
    (reference) =>
      reference.kind === "tools" && reference.capabilityId === input.capability.manifest.id,
  );
  const capabilityReferences = input.capabilityReferences.filter(
    (reference) => reference !== existing,
  );
  const removedNames = (existing?.kind === "tools" ? existing.toolNames : []).filter(
    (name) => !input.toolNames.includes(name),
  );
  const removedKeys = new Set(
    removedNames.map((name) => toolApprovalKey(input.capability.manifest.runtimeKey, name)),
  );

  return {
    capabilityReferences:
      input.toolNames.length === 0
        ? capabilityReferences
        : [
            ...capabilityReferences,
            {
              kind: "tools",
              capabilityId: input.capability.manifest.id,
              revision:
                existing?.kind === "tools"
                  ? existing.revision
                  : input.capability.manifest.latestRevision,
              toolNames: [...input.toolNames],
            },
          ],
    toolApprovals: Object.fromEntries(
      Object.entries(input.toolApprovals).filter(([key]) => !removedKeys.has(key)),
    ),
  };
}

function SummaryNames(props: { readonly names: readonly string[] }) {
  const { t } = useTranslation("studio");
  if (props.names.length === 0) {
    return <span className="capability-summary-empty">{t("noneSelected")}</span>;
  }
  const visible = props.names.slice(0, 3);
  return (
    <span className="capability-summary-names">
      {visible.map((name, index) => (
        <span key={`${name}-${index}`}>{name}</span>
      ))}
      {props.names.length > visible.length ? (
        <span>{t("moreCount", { count: props.names.length - visible.length })}</span>
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
  readonly toolApprovals: ExpertDraft["toolApprovals"];
  readonly allowResourceTools?: boolean | undefined;
  readonly onResourceToolsChange: (value: ExpertDraft["resourceTools"]) => void;
  readonly onContextStoreMountsChange: (value: ExpertDraft["contextStoreMounts"]) => void;
  readonly onCapabilityReferencesChange: (value: ExpertDraft["capabilities"]) => void;
  readonly onToolApprovalsChange: (value: ExpertDraft["toolApprovals"]) => void;
}) {
  const { t } = useTranslation("studio");
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
  const pickerCopy = {
    resources: {
      eyebrow: t("asTools"),
      title: t("expertsTeamsFlows"),
      description: t("resourcesPickerDescription"),
      searchPlaceholder: t("searchResources"),
    },
    "context-stores": {
      eyebrow: t("knowledge"),
      title: t("contextStores"),
      description: t("contextStoresPickerDescription"),
      searchPlaceholder: t("searchContextStores"),
    },
    skills: {
      eyebrow: t("guidance"),
      title: t("skills"),
      description: t("skillsPickerDescription"),
      searchPlaceholder: t("searchSkills"),
    },
    tools: {
      eyebrow: t("actions"),
      title: t("tools"),
      description: t("toolsPickerDescription"),
      searchPlaceholder: t("searchTools"),
    },
  } as const;

  const closePicker = () => {
    setActivePicker(null);
    setSearch("");
  };
  const openPicker = (picker: PickerKind) => {
    setSearch("");
    setActivePicker(picker);
  };

  useEffect(() => {
    if (activePicker === null || activePicker === "context-stores" || activePicker === "resources")
      return;
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
  const resourcePickerItems: readonly PragmaResourcePickerItem[] = invocableResources.map(
    (resource) => {
      const details = resourceDetails(resource);
      return {
        ref: details.ref,
        name: resource.metadata.name,
        description: resource.metadata.description,
        searchTerms: [resource.metadata.id, ...resource.metadata.tags],
        kind: details.kind,
        avatarId: "avatarId" in resource.metadata ? resource.metadata.avatarId : undefined,
      };
    },
  );

  const summaries: readonly {
    readonly id: PickerKind;
    readonly icon: typeof Network;
    readonly selected: number;
    readonly available: number;
    readonly names: readonly string[];
  }[] = [
    ...(props.allowResourceTools === false
      ? []
      : [
          {
            id: "resources" as const,
            icon: Network,
            selected: props.resourceTools.length,
            available: invocableResources.length,
            names: selectedResourceNames,
          },
        ]),
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
        props.onToolApprovalsChange({});
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
    const next = updateToolSelection({
      capability,
      capabilityReferences: props.capabilityReferences,
      toolApprovals: props.toolApprovals,
      toolNames,
    });
    props.onCapabilityReferencesChange(next.capabilityReferences);
    props.onToolApprovalsChange(next.toolApprovals);
  };

  return (
    <>
      <section className="capability-summary-section" aria-labelledby="capability-library-heading">
        <div className="capability-section-heading">
          <div>
            <h3 id="capability-library-heading">{t("capabilityLibrary")}</h3>
            <p>{t("capabilityLibraryDescription")}</p>
          </div>
          <span>
            {t("selectedCount", {
              count:
                props.resourceTools.length +
                props.contextStoreMounts.length +
                selectedSkillReferences.length +
                selectedToolCount,
            })}
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
                    {t("selectedCount", { count: summary.selected })}
                  </span>
                </header>
                <div>
                  <small>{copy.eyebrow}</small>
                  <h4>{copy.title}</h4>
                  <p>{copy.description}</p>
                </div>
                <SummaryNames names={summary.names} />
                <footer>
                  <span>{t("availableCount", { count: summary.available })}</span>
                  <button type="button" onClick={() => openPicker(summary.id)}>
                    {summary.id === "context-stores" || summary.selected === 0
                      ? t("choose")
                      : t("editSelection")}
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      </section>

      {activePicker === "resources" ? (
        <PragmaResourcePickerDialog
          title={pickerCopy.resources.title}
          description={pickerCopy.resources.description}
          items={resourcePickerItems}
          selectedRefs={props.resourceTools.flatMap((binding) =>
            binding.target === undefined ? [] : [binding.target.ref],
          )}
          selectionMode="multiple"
          searchPlaceholder={pickerCopy.resources.searchPlaceholder}
          onSelectedRefsChange={(refs) =>
            props.onResourceToolsChange(
              refs.flatMap((ref) => {
                const existing = props.resourceTools.find((binding) => binding.target?.ref === ref);
                if (existing !== undefined) return [existing];
                const resource = invocableResources.find(
                  (candidate) => resourceDetails(candidate).ref === ref,
                );
                if (resource === undefined) return [];
                const details = resourceDetails(resource);
                return [
                  {
                    adapter: "pragma.tool.call@v1",
                    target: { ref },
                    tool: {
                      name: `call_${details.kind}_${resource.metadata.id}`.replace(
                        /[^A-Za-z0-9_-]/g,
                        "_",
                      ),
                      description: `Call ${resource.metadata.name}.`,
                      approval: "ask",
                    },
                  },
                ];
              }),
            )
          }
          onClose={closePicker}
        />
      ) : activePicker === "context-stores" ? (
        <ContextStorePickerDialog
          stores={props.contextStores}
          selectedStoreIds={props.contextStoreMounts.map((mount) => mount.storeId)}
          description={pickerCopy["context-stores"].description}
          footerHint={t("changesImmediate")}
          onSelectedStoreIdsChange={(storeIds) => {
            const currentMounts = new Map(
              props.contextStoreMounts.map((mount) => [mount.storeId, mount]),
            );
            props.onContextStoreMountsChange(
              storeIds.map((storeId, priority) => ({
                ...(currentMounts.get(storeId) ?? { storeId, enabled: true }),
                priority,
              })),
            );
          }}
          onClose={closePicker}
        />
      ) : activePicker !== null ? (
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
              <button type="button" aria-label={t("closeCapabilityPicker")} onClick={closePicker}>
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
                <button type="button" aria-label={t("clearSearch")} onClick={() => setSearch("")}>
                  <X size={16} aria-hidden="true" />
                </button>
              ) : null}
            </label>
            <div className="expert-picker-toolbar">
              <span>{t("selectedCount", { count: activeSelectedCount })}</span>
              {activeSelectedCount > 0 ? (
                <button type="button" onClick={clearActivePicker}>
                  {t("clearSelection")}
                </button>
              ) : null}
            </div>
            <div className="expert-picker-results">
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
                  toolApprovals={props.toolApprovals}
                  onUpdate={updateToolReference}
                  onApprovalChange={(key, mode) => {
                    const next = { ...props.toolApprovals };
                    if (mode === undefined) delete next[key];
                    else next[key] = mode;
                    props.onToolApprovalsChange(next);
                  }}
                />
              ) : null}
            </div>
            <footer className="expert-picker-actions">
              <span>{t("changesImmediate")}</span>
              <button className="primary-button" type="button" onClick={closePicker}>
                {t("common:actions.done")}
              </button>
            </footer>
          </aside>
        </div>
      ) : null}
    </>
  );
}

function EmptyResults(props: { readonly hasQuery: boolean; readonly label: string }) {
  const { t } = useTranslation("studio");
  return (
    <div className="expert-picker-empty">
      <strong>
        {props.hasQuery ? t("noMatchesFound") : t("noAvailable", { label: props.label })}
      </strong>
      <p>{props.hasQuery ? t("tryDifferentDescription") : t("addItemsStudio")}</p>
    </div>
  );
}

function SkillResults(props: {
  readonly capabilities: readonly Capability[];
  readonly query: string;
  readonly references: ExpertDraft["capabilities"];
  readonly onChange: (value: ExpertDraft["capabilities"]) => void;
}) {
  const { t } = useTranslation("studio");
  const visible = props.capabilities.filter((capability) =>
    includesQuery(
      props.query,
      capability.manifest.name,
      capability.manifest.id,
      capability.definition.description,
    ),
  );
  if (visible.length === 0)
    return <EmptyResults hasQuery={Boolean(props.query.trim())} label={t("skillsLower")} />;
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
                {unavailable ? ` · ${t("needsAttention")}` : ""}
              </small>
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function ToolResults(props: {
  readonly capabilities: readonly Capability[];
  readonly query: string;
  readonly references: ExpertDraft["capabilities"];
  readonly toolApprovals: ExpertDraft["toolApprovals"];
  readonly onUpdate: (capability: Capability, toolNames: readonly string[]) => void;
  readonly onApprovalChange: (
    key: string,
    mode: ExpertDraft["toolApprovals"][string] | undefined,
  ) => void;
}) {
  const { t } = useTranslation("studio");
  const [expandedServices, setExpandedServices] = useState<ReadonlySet<string>>(() => new Set());
  const [visibleLimit, setVisibleLimit] = useState(TOOL_SERVICE_PAGE_SIZE);
  useEffect(() => {
    setVisibleLimit(TOOL_SERVICE_PAGE_SIZE);
  }, [props.query]);

  const matchingServices = props.capabilities.flatMap((capability) => {
    const tools = getTools(capability);
    const matchingNames = matchingToolNames(capability, props.query);
    const visibleTools = tools.filter((tool) => matchingNames.includes(tool.name));
    return visibleTools.length > 0 ? [{ capability, tools, visibleTools }] : [];
  });
  const visible = matchingServices.slice(0, visibleLimit);
  if (visible.length === 0)
    return <EmptyResults hasQuery={Boolean(props.query.trim())} label={t("toolsLower")} />;
  const autoExpandSearchResults = props.query.trim().length > 0 && visible.length <= 8;
  const allVisibleExpanded = visible.every(({ capability }) =>
    expandedServices.has(capability.manifest.id),
  );
  const setAllVisibleExpanded = (expanded: boolean) => {
    setExpandedServices((current) => {
      const next = new Set(current);
      for (const { capability } of visible) {
        if (expanded) next.add(capability.manifest.id);
        else next.delete(capability.manifest.id);
      }
      return next;
    });
  };
  return (
    <div className="expert-tool-results">
      <div className="expert-tool-results-toolbar">
        <span>
          {t("showingToolServices", {
            shown: visible.length,
            total: matchingServices.length,
          })}
        </span>
        {!autoExpandSearchResults ? (
          <button type="button" onClick={() => setAllVisibleExpanded(!allVisibleExpanded)}>
            {allVisibleExpanded ? t("collapseAllServices") : t("expandAllServices")}
          </button>
        ) : null}
      </div>
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
        const isExpanded = autoExpandSearchResults || expandedServices.has(capability.manifest.id);
        return (
          <section
            className={`expert-tool-service${unavailable ? " is-disabled" : ""}`}
            key={capability.manifest.id}
          >
            <header>
              <button
                className="expert-tool-service-toggle"
                type="button"
                aria-expanded={isExpanded}
                onClick={() =>
                  setExpandedServices((current) => {
                    const next = new Set(current);
                    if (next.has(capability.manifest.id)) next.delete(capability.manifest.id);
                    else next.add(capability.manifest.id);
                    return next;
                  })
                }
              >
                <CaretDown
                  className={isExpanded ? "is-expanded" : ""}
                  size={16}
                  aria-hidden="true"
                />
                <span>
                  <strong>{capability.manifest.name}</strong>
                  <small>
                    {capability.definition.kind === "mcp_server"
                      ? t("mcpServer")
                      : capability.definition.kind === "http_service"
                        ? t("httpService")
                        : t("codeService")}{" "}
                    ·{" "}
                    {t("selectedOfTotal", { selected: selectedNames.length, total: tools.length })}
                    {props.query.trim().length > 0
                      ? ` · ${t("matchingTools", { count: visibleTools.length })}`
                      : ""}
                    {unavailable ? ` · ${t("needsAttention")}` : ""}
                  </small>
                </span>
              </button>
              <div>
                <button
                  className="expert-tool-service-select-all"
                  type="button"
                  disabled={unavailable}
                  aria-pressed={allSelected}
                  onClick={() =>
                    props.onUpdate(capability, allSelected ? [] : tools.map((tool) => tool.name))
                  }
                >
                  {allSelected ? t("clearAll") : t("selectAll")}
                </button>
              </div>
            </header>
            {isExpanded ? (
              <div className="expert-picker-list">
                {visibleTools.map((tool) => {
                  const checked = selectedNames.includes(tool.name);
                  const approvalKey = toolApprovalKey(capability.manifest.runtimeKey, tool.name);
                  return (
                    <div
                      className={`expert-picker-row expert-tool-row${
                        checked ? " is-selected" : ""
                      }`}
                      key={tool.name}
                    >
                      <label className="expert-tool-row-selection">
                        <input
                          type="checkbox"
                          aria-label={t("selectExpertTool", { name: tool.name })}
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
                          <small>{tool.description ?? t("externalTool")}</small>
                        </span>
                      </label>
                      {checked ? (
                        <div className="tool-approval-select">
                          <span className="sr-only">
                            {t("toolApprovalFor", { name: tool.name })}
                          </span>
                          <SelectMenu<"" | "none" | "ask" | "required">
                            ariaLabel={t("toolApprovalFor", { name: tool.name })}
                            className="form-select"
                            overlayOwnerId="expert-capability-picker"
                            value={props.toolApprovals[approvalKey] ?? ""}
                            options={[
                              { value: "", label: t("approvalDefault") },
                              { value: "none", label: t("approvalNone") },
                              { value: "ask", label: t("approvalAsk") },
                              { value: "required", label: t("approvalRequired") },
                            ]}
                            onChange={(approval) =>
                              props.onApprovalChange(
                                approvalKey,
                                approval === ""
                                  ? undefined
                                  : (approval as ExpertDraft["toolApprovals"][string]),
                              )
                            }
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>
        );
      })}
      {visible.length < matchingServices.length ? (
        <button
          className="expert-tool-load-more"
          type="button"
          onClick={() => setVisibleLimit((current) => current + TOOL_SERVICE_PAGE_SIZE)}
        >
          {t("loadMoreServices", {
            count: Math.min(TOOL_SERVICE_PAGE_SIZE, matchingServices.length - visible.length),
          })}
        </button>
      ) : null}
    </div>
  );
}

function toolApprovalKey(runtimeKey: string, toolName: string): string {
  const sanitized = toolName.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_") || "tool";
  return `mcp_${runtimeKey}_${sanitized}`;
}
