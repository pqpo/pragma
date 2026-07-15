import { User } from "@phosphor-icons/react";
import { useState } from "react";
import type { PragmaResource } from "@pragma/interpreter/ast";

import { errorMessage } from "../../lib/errors.ts";
import {
  EXPERT_DESCRIPTION_MAX_LENGTH,
  EXPERT_ID_MAX_LENGTH,
  EXPERT_NAME_MAX_LENGTH,
  EXPERT_TAG_MAX_LENGTH,
  CreateExpertIdSchema,
  type Capability,
  type ContextStore,
  type DesktopRuntimeAvailability,
  type ModelProvider,
} from "../../../../shared/desktop-api.ts";
import type { ExpertDraft, ExpertRecord } from "./studio-model.ts";

type CreateStep = "identity" | "instructions" | "capabilities" | "review";

export function ExpertEditorFragment(props: {
  readonly initialValue: ExpertDraft;
  readonly modelProviders: readonly ModelProvider[];
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly contextStores: readonly ContextStore[];
  readonly capabilities: readonly Capability[];
  readonly resources: readonly PragmaResource[];
  readonly existingExpertIds: readonly string[];
  readonly onCancel: () => void;
  readonly onCreated: (expert: ExpertRecord) => Promise<void>;
}) {
  const [draft, setDraft] = useState(props.initialValue);
  const [step, setStep] = useState<CreateStep>("identity");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedRuntime, setSelectedRuntime] = useState(props.initialValue.model?.runtimeId ?? "");
  const [selectedProviderId, setSelectedProviderId] = useState(
    props.initialValue.model?.runtimeId === "pi" ? props.initialValue.model.providerId : "",
  );
  const isEditing = props.initialValue.persisted !== undefined;
  const selectedProvider = props.modelProviders.find(
    (provider) => provider.id === selectedProviderId,
  );
  const selectedRuntimeInfo = props.runtimes.find((runtime) => runtime.id === selectedRuntime);
  const modelOptions =
    selectedRuntime === "pi"
      ? (selectedProvider?.models ?? [])
      : (selectedRuntimeInfo?.models ?? []);
  const steps: readonly { readonly id: CreateStep; readonly label: string }[] = [
    { id: "identity", label: "Identity" },
    { id: "instructions", label: "Instructions" },
    { id: "capabilities", label: "Capabilities" },
    { id: "review", label: "Review" },
  ];
  const index = steps.findIndex((item) => item.id === step);
  const advance = () => {
    if (step === "identity") {
      const idResult = CreateExpertIdSchema.safeParse(draft.id);
      const idAlreadyExists =
        !isEditing &&
        props.existingExpertIds.some((id) => id.toLowerCase() === draft.id.trim().toLowerCase());
      const hasInvalidLength =
        draft.name.trim().length > EXPERT_NAME_MAX_LENGTH ||
        draft.description.trim().length > EXPERT_DESCRIPTION_MAX_LENGTH ||
        draft.tags.some((tag) => tag.trim().length > EXPERT_TAG_MAX_LENGTH);
      if (
        !draft.name.trim() ||
        !draft.description.trim() ||
        !draft.scope.trim() ||
        !idResult.success ||
        idAlreadyExists ||
        hasInvalidLength
      ) {
        setError(
          idAlreadyExists
            ? "This expert ID is already in use. Choose a unique ID."
            : hasInvalidLength
              ? "Name, description, or tags exceed their character limits."
              : idResult.success
                ? "Name, ID, description, and scope are required to define an expert."
                : (idResult.error.issues[0]?.message ?? "The expert ID is invalid."),
        );
        return;
      }
    }
    setError(null);
    setStep(steps[Math.min(index + 1, steps.length - 1)]!.id);
  };
  const retreat = () => (index === 0 ? props.onCancel() : setStep(steps[index - 1]!.id));
  const addTag = () => {
    const tag = draft.tagInput.trim();
    if (!tag || draft.tags.some((item) => item.toLowerCase() === tag.toLowerCase())) return;
    setDraft({ ...draft, tags: [...draft.tags, tag], tagInput: "" });
  };
  const setCapabilityReferences = (capabilities: ExpertDraft["capabilities"]) => {
    setDraft({
      ...draft,
      capabilities,
      skills: capabilities.filter((reference) => reference.kind === "skill").length,
      tools: capabilities
        .filter((reference) => reference.kind === "tools")
        .reduce((total, reference) => total + reference.toolNames.length, 0),
      mcpServers: capabilities.filter((reference) => reference.kind === "tools").length,
    });
  };
  const submit = async () => {
    setError(null);
    const name = draft.name.trim();
    const idResult = CreateExpertIdSchema.safeParse(draft.id);
    const description = draft.description.trim();
    if (!name || !description || !draft.scope.trim() || !idResult.success) {
      setError(
        idResult.success
          ? "Name, ID, description, and scope are required to define an expert."
          : (idResult.error.issues[0]?.message ?? "The expert ID is invalid."),
      );
      return;
    }
    setSaving(true);
    try {
      await props.onCreated({
        ...draft,
        id: idResult.data,
        name,
        description,
        instructions: draft.instructions.trim(),
        icon: User,
      });
    } catch (submitError) {
      setError(errorMessage(submitError));
      setSaving(false);
    }
  };

  return (
    <section className="expert-creator" aria-labelledby="create-expert-heading">
      <header className="studio-heading creator-heading">
        <div>
          <h1 id="create-expert-heading">{isEditing ? "Edit expert" : "Create expert"}</h1>
          <p>
            {isEditing
              ? "Update this reusable expert declaration."
              : "Build a reusable expert to power missions."}
          </p>
        </div>
      </header>
      <div className="creator-layout">
        <ol className="creator-steps" aria-label="Create expert steps">
          {steps.map((item, itemIndex) => (
            <li
              className={item.id === step ? "is-active" : itemIndex < index ? "is-complete" : ""}
              key={item.id}
            >
              <span>{itemIndex + 1}</span>
              {item.label}
            </li>
          ))}
        </ol>
        <form
          className="creator-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (step === "review") {
              void submit();
              return;
            }
            advance();
          }}
        >
          {step === "identity" ? (
            <>
              <div className="creator-preview">
                <span className="studio-asset-icon">
                  <User size={24} />
                </span>
                <div>
                  <strong>{draft.name || "Expert name"}</strong>
                  <p>{draft.description || "A concise description will appear here."}</p>
                </div>
              </div>
              <label>
                Name
                <input
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      name: event.target.value.slice(0, EXPERT_NAME_MAX_LENGTH),
                    })
                  }
                  placeholder="Expert name"
                  maxLength={EXPERT_NAME_MAX_LENGTH}
                  autoFocus
                />
                <small className="field-hint">
                  <span>Choose a short, recognizable name.</span>
                  <span>
                    {draft.name.length}/{EXPERT_NAME_MAX_LENGTH}
                  </span>
                </small>
              </label>
              <label>
                ID
                <input
                  value={draft.id}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      id: event.target.value.slice(0, EXPERT_ID_MAX_LENGTH),
                    })
                  }
                  placeholder="market_research"
                  maxLength={EXPERT_ID_MAX_LENGTH}
                  disabled={isEditing}
                />
                <small className="field-hint">
                  <span>Unique identifier. Use only letters, numbers, and underscores.</span>
                  <span>
                    {draft.id.length}/{EXPERT_ID_MAX_LENGTH}
                  </span>
                </small>
              </label>
              <label>
                Description
                <textarea
                  value={draft.description}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      description: event.target.value.slice(0, EXPERT_DESCRIPTION_MAX_LENGTH),
                    })
                  }
                  placeholder="What does this expert do?"
                  maxLength={EXPERT_DESCRIPTION_MAX_LENGTH}
                />
                <small className="field-hint">
                  <span>Summarize the expert's purpose in one or two sentences.</span>
                  <span>
                    {draft.description.length}/{EXPERT_DESCRIPTION_MAX_LENGTH}
                  </span>
                </small>
              </label>
              <label>
                Tags
                <input
                  value={draft.tagInput}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      tagInput: event.target.value.slice(0, EXPERT_TAG_MAX_LENGTH),
                    })
                  }
                  maxLength={EXPERT_TAG_MAX_LENGTH}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addTag();
                    }
                  }}
                  placeholder="Add a tag and press Enter"
                />
                <small className="field-hint">
                  <span>Each tag can contain up to {EXPERT_TAG_MAX_LENGTH} characters.</span>
                  <span>
                    {draft.tagInput.length}/{EXPERT_TAG_MAX_LENGTH}
                  </span>
                </small>
                <span className="draft-tags">
                  {draft.tags.map((tag) => (
                    <button
                      type="button"
                      key={tag}
                      onClick={() =>
                        setDraft({ ...draft, tags: draft.tags.filter((item) => item !== tag) })
                      }
                    >
                      {tag} ×
                    </button>
                  ))}
                </span>
              </label>
              <label>
                Scope
                <textarea
                  value={draft.scope}
                  onChange={(event) => setDraft({ ...draft, scope: event.target.value })}
                  placeholder="What is this expert responsible for, and what is explicitly outside its responsibility?"
                />
                <small>
                  A responsibility boundary shown to callers and included in the expert context.
                  This is not an access level.
                </small>
              </label>
              <label>
                Version
                <input
                  value={draft.version}
                  onChange={(event) => setDraft({ ...draft, version: event.target.value })}
                />
              </label>
            </>
          ) : null}
          {step === "instructions" ? (
            <label>
              Instructions
              <textarea
                className="instructions-input"
                value={draft.instructions}
                onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                placeholder="Define how this expert should work, reason, and communicate."
                autoFocus
              />
              <small>Instructions become part of the expert's system context.</small>
            </label>
          ) : null}
          {step === "capabilities" ? (
            <div className="capability-editor">
              <h2>Add capabilities</h2>
              <p>
                Choose the execution runtime first, then select one of the models available to that
                runtime.
              </p>
              <label>
                Runtime
                <select
                  value={selectedRuntime}
                  onChange={(event) => {
                    setSelectedRuntime(event.target.value);
                    setSelectedProviderId("");
                    setDraft({ ...draft, model: null });
                  }}
                >
                  <option value="">Not configured</option>
                  {props.runtimes.map((runtime) => (
                    <option
                      key={runtime.id}
                      value={runtime.id}
                      disabled={runtime.status !== "available"}
                    >
                      {runtime.id === "pi"
                        ? "PI"
                        : runtime.id === "codex"
                          ? "Codex"
                          : "Claude Code"}
                      {runtime.status === "available" ? "" : " (unavailable)"}
                    </option>
                  ))}
                </select>
              </label>
              {selectedRuntime === "pi" ? (
                <label>
                  Model provider
                  <select
                    value={selectedProviderId}
                    onChange={(event) => {
                      setSelectedProviderId(event.target.value);
                      setDraft({ ...draft, model: null });
                    }}
                  >
                    <option value="">Select a configured provider</option>
                    {props.modelProviders.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {selectedRuntime ? (
                <label>
                  Model
                  <select
                    value={draft.model?.modelName ?? ""}
                    disabled={selectedRuntime === "pi" && !selectedProviderId}
                    onChange={(event) => {
                      const modelName = event.target.value;
                      setDraft({
                        ...draft,
                        model: !modelName
                          ? null
                          : selectedRuntime === "pi"
                            ? { runtimeId: "pi", providerId: selectedProviderId, modelName }
                            : selectedRuntime === "codex"
                              ? { runtimeId: "codex", modelName }
                              : { runtimeId: "claude-code", modelName },
                      });
                    }}
                  >
                    <option value="">Select a model</option>
                    {modelOptions.map((model) => {
                      const id = typeof model === "string" ? model : model.id;
                      const label = typeof model === "string" ? model : model.displayName;
                      return (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      );
                    })}
                  </select>
                  {selectedRuntime !== "pi" && selectedRuntimeInfo?.modelDiscoveryError ? (
                    <small className="form-error">{selectedRuntimeInfo.modelDiscoveryError}</small>
                  ) : null}
                </label>
              ) : null}
              <fieldset className="expert-context-store-picker expert-capability-picker">
                <legend>Experts, teams, and flows as tools</legend>
                <small>
                  Each selection is compiled through the versioned pragma.tool.call@v1 adapter.
                </small>
                {props.resources
                  .filter(
                    (resource) =>
                      !(resource.kind === "Expert" && resource.metadata.id === draft.id),
                  )
                  .map((resource) => {
                    const kind =
                      resource.kind === "Expert"
                        ? "expert"
                        : resource.kind === "ExpertTeam"
                          ? "team"
                          : "flow";
                    const ref = `${kind}:${resource.metadata.id}@${resource.metadata.version}`;
                    const selected = draft.resourceTools.some(
                      (binding) => binding.target?.ref === ref,
                    );
                    return (
                      <label key={ref}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              resourceTools: event.target.checked
                                ? [
                                    ...draft.resourceTools,
                                    {
                                      adapter: "pragma.tool.call@v1",
                                      target: { ref },
                                      tool: {
                                        name: `call_${kind}_${resource.metadata.id}`.replace(
                                          /[^A-Za-z0-9_-]/g,
                                          "_",
                                        ),
                                        description: `Call ${resource.metadata.name}.`,
                                        approval: "ask",
                                      },
                                    },
                                  ]
                                : draft.resourceTools.filter(
                                    (binding) => binding.target?.ref !== ref,
                                  ),
                            })
                          }
                        />
                        <span>
                          <strong>{resource.metadata.name}</strong>
                          <small>
                            {kind} · {resource.metadata.version}
                          </small>
                        </span>
                      </label>
                    );
                  })}
              </fieldset>
              <fieldset className="expert-context-store-picker">
                <legend>Context stores</legend>
                <small>An expert can mount multiple stores.</small>
                {props.contextStores.length === 0 ? <p>No context stores available.</p> : null}
                {props.contextStores.map((store) => {
                  const mounted = draft.contextStoreMounts.some(
                    (mount) => mount.storeId === store.id,
                  );
                  return (
                    <label key={store.id}>
                      <input
                        type="checkbox"
                        checked={mounted}
                        onChange={() => {
                          const mounts = mounted
                            ? draft.contextStoreMounts.filter((mount) => mount.storeId !== store.id)
                            : [
                                ...draft.contextStoreMounts,
                                {
                                  storeId: store.id,
                                  enabled: true,
                                  priority: draft.contextStoreMounts.length,
                                },
                              ];
                          setDraft({
                            ...draft,
                            contextStoreMounts: mounts.map((mount, priority) => ({
                              ...mount,
                              priority,
                            })),
                          });
                        }}
                      />
                      <span>
                        <strong>{store.name}</strong>
                        <small>
                          {store.description ||
                            (store.type === "file" ? "File store" : "Context note")}
                        </small>
                      </span>
                    </label>
                  );
                })}
              </fieldset>
              <fieldset className="expert-context-store-picker expert-capability-picker">
                <legend>Skills</legend>
                <small>Load reusable guidance packages into this Expert.</small>
                {props.capabilities.filter((capability) => capability.definition.kind === "skill")
                  .length === 0 ? (
                  <p>No Skills have been imported.</p>
                ) : null}
                {props.capabilities
                  .filter((capability) => capability.definition.kind === "skill")
                  .map((capability) => {
                    const selected = draft.capabilities.find(
                      (reference) =>
                        reference.kind === "skill" &&
                        reference.capabilityId === capability.manifest.id,
                    );
                    const unavailable =
                      capability.health.status !== "ready" && selected === undefined;
                    return (
                      <label
                        key={capability.manifest.id}
                        className={unavailable ? "is-disabled" : ""}
                      >
                        <input
                          type="checkbox"
                          disabled={unavailable}
                          checked={selected !== undefined}
                          onChange={() =>
                            setCapabilityReferences(
                              selected === undefined
                                ? [
                                    ...draft.capabilities,
                                    {
                                      kind: "skill",
                                      capabilityId: capability.manifest.id,
                                      revision: capability.manifest.latestRevision,
                                    },
                                  ]
                                : draft.capabilities.filter((reference) => reference !== selected),
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
              </fieldset>
              <fieldset className="expert-context-store-picker expert-capability-picker">
                <legend>Tools</legend>
                <small>Select only the MCP or HTTP tools this Expert needs.</small>
                {props.capabilities.map((capability) => {
                  const definition = capability.definition;
                  if (definition.kind === "skill") return null;
                  const foundReference = draft.capabilities.find(
                    (reference) =>
                      reference.kind === "tools" &&
                      reference.capabilityId === capability.manifest.id,
                  );
                  const selected = foundReference?.kind === "tools" ? foundReference : undefined;
                  const unavailable =
                    capability.health.status !== "ready" && selected === undefined;
                  const tools = definition.tools;
                  return (
                    <div className="expert-tool-capability" key={capability.manifest.id}>
                      <header>
                        <span>
                          <strong>{capability.manifest.name}</strong>
                          <small>
                            {definition.kind === "mcp_server" ? "MCP server" : "HTTP service"}
                            {unavailable ? " · Needs attention" : ""}
                          </small>
                        </span>
                        {selected && selected.revision < capability.manifest.latestRevision ? (
                          <button
                            type="button"
                            onClick={() =>
                              setCapabilityReferences(
                                draft.capabilities.map((reference) =>
                                  reference === selected
                                    ? { ...reference, revision: capability.manifest.latestRevision }
                                    : reference,
                                ),
                              )
                            }
                          >
                            Upgrade to r{capability.manifest.latestRevision}
                          </button>
                        ) : null}
                      </header>
                      {tools.map((tool) => {
                        const checked =
                          selected?.kind === "tools" && selected.toolNames.includes(tool.name);
                        return (
                          <label key={tool.name} className={unavailable ? "is-disabled" : ""}>
                            <input
                              type="checkbox"
                              disabled={unavailable}
                              checked={checked}
                              onChange={() => {
                                const nextNames = checked
                                  ? (selected?.toolNames ?? []).filter((name) => name !== tool.name)
                                  : [...(selected?.toolNames ?? []), tool.name];
                                const without = draft.capabilities.filter(
                                  (reference) => reference !== selected,
                                );
                                setCapabilityReferences(
                                  nextNames.length === 0
                                    ? without
                                    : [
                                        ...without,
                                        {
                                          kind: "tools",
                                          capabilityId: capability.manifest.id,
                                          revision:
                                            selected?.revision ??
                                            capability.manifest.latestRevision,
                                          toolNames: nextNames,
                                        },
                                      ],
                                );
                              }}
                            />
                            <span>
                              <strong>{tool.name}</strong>
                              <small>{tool.description ?? "External tool"}</small>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  );
                })}
              </fieldset>
            </div>
          ) : null}
          {step === "review" ? (
            <div className="review-summary">
              <h2>{isEditing ? "Ready to save" : "Ready to create"}</h2>
              <p>Review the declaration before {isEditing ? "saving" : "creating"} this expert.</p>
              <dl>
                <div>
                  <dt>Name</dt>
                  <dd>{draft.name || "Untitled Expert"}</dd>
                </div>
                <div>
                  <dt>ID</dt>
                  <dd>{draft.id || "Generated from name"}</dd>
                </div>
                <div>
                  <dt>Scope</dt>
                  <dd>{draft.scope}</dd>
                </div>
                <div>
                  <dt>Capabilities</dt>
                  <dd>
                    {draft.model === null
                      ? "No runtime/model"
                      : `${draft.model.runtimeId} / ${draft.model.modelName}`}{" "}
                    · {draft.contextStoreMounts.length} context stores · {draft.skills} skills ·{" "}
                    {draft.tools} tools · {draft.mcpServers} MCP server
                  </dd>
                </div>
              </dl>
            </div>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <footer className="creator-actions">
            <button className="secondary-button" type="button" onClick={retreat} disabled={saving}>
              {index === 0 ? "Cancel" : "Back"}
            </button>
            <button className="primary-button" type="submit" disabled={saving}>
              {saving
                ? isEditing
                  ? "Saving…"
                  : "Creating…"
                : step === "review"
                  ? isEditing
                    ? "Save expert"
                    : "Create expert"
                  : "Continue"}
            </button>
          </footer>
        </form>
      </div>
    </section>
  );
}
