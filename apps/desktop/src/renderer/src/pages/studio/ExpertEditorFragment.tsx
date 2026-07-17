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
import { ExpertCapabilityPicker } from "./ExpertCapabilityPicker.tsx";

type CreateStep = "identity" | "instructions" | "capabilities" | "review";

export function ExpertEditorFragment(props: {
  readonly initialValue: ExpertDraft;
  readonly modelProviders: readonly ModelProvider[];
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly contextStores: readonly ContextStore[];
  readonly capabilities: readonly Capability[];
  readonly resources: readonly PragmaResource[];
  readonly existingExpertRefs: readonly string[];
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
        props.existingExpertRefs.some(
          (ref) =>
            ref.toLowerCase() === `expert:${draft.id.trim()}@${draft.version.trim()}`.toLowerCase(),
        );
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
            ? "This expert ID and version already exist. Choose a different version."
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
              <ExpertCapabilityPicker
                currentExpertId={draft.id}
                resources={props.resources}
                contextStores={props.contextStores}
                capabilities={props.capabilities}
                resourceTools={draft.resourceTools}
                contextStoreMounts={draft.contextStoreMounts}
                capabilityReferences={draft.capabilities}
                onResourceToolsChange={(resourceTools) => setDraft({ ...draft, resourceTools })}
                onContextStoreMountsChange={(contextStoreMounts) =>
                  setDraft({ ...draft, contextStoreMounts })
                }
                onCapabilityReferencesChange={setCapabilityReferences}
              />
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
