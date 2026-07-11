import { User } from "@phosphor-icons/react";
import { useState } from "react";

import { errorMessage } from "../../lib/errors.ts";
import { ExpertIdSchema, type ModelProvider } from "../../../../shared/desktop-api.ts";
import type { ExpertDraft, ExpertModel, ExpertRecord } from "./studio-model.ts";

type CreateStep = "identity" | "instructions" | "capabilities" | "review";

export function ExpertEditorFragment(props: {
  readonly initialValue: ExpertDraft;
  readonly modelProviders: readonly ModelProvider[];
  readonly onCancel: () => void;
  readonly onCreated: (expert: ExpertRecord) => Promise<void>;
}) {
  const [draft, setDraft] = useState(props.initialValue);
  const [step, setStep] = useState<CreateStep>("identity");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isEditing = props.initialValue.persisted !== undefined;
  const configuredModelExists =
    draft.model !== null &&
    props.modelProviders.some(
      (provider) =>
        provider.id === draft.model?.providerId && provider.models.includes(draft.model.modelName),
    );
  const steps: readonly { readonly id: CreateStep; readonly label: string }[] = [
    { id: "identity", label: "Identity" },
    { id: "instructions", label: "Instructions" },
    { id: "capabilities", label: "Capabilities" },
    { id: "review", label: "Review" },
  ];
  const index = steps.findIndex((item) => item.id === step);
  const advance = () => {
    if (step === "identity") {
      const idResult = ExpertIdSchema.safeParse(draft.id);
      if (!draft.name.trim() || !draft.description.trim() || !idResult.success) {
        setError(
          idResult.success
            ? "Name, ID, and description are required to define an expert."
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
    if (!tag || draft.tags.includes(tag)) return;
    setDraft({ ...draft, tags: [...draft.tags, tag], tagInput: "" });
  };
  const submit = async () => {
    setError(null);
    const name = draft.name.trim();
    const idResult = ExpertIdSchema.safeParse(draft.id);
    const description = draft.description.trim();
    if (!name || !description || !idResult.success) {
      setError(
        idResult.success
          ? "Name, ID, and description are required to define an expert."
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
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="Market Research Analyst"
                  autoFocus
                />
              </label>
              <label>
                ID
                <input
                  value={draft.id}
                  onChange={(event) => setDraft({ ...draft, id: event.target.value })}
                  placeholder="market-research-analyst"
                  disabled={isEditing}
                />
                <small>
                  Stable programmatic identifier. Use lowercase letters, numbers, and hyphens.
                </small>
              </label>
              <label>
                Description
                <textarea
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  placeholder="What does this expert do?"
                />
              </label>
              <label>
                Tags
                <input
                  value={draft.tagInput}
                  onChange={(event) => setDraft({ ...draft, tagInput: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addTag();
                    }
                  }}
                  placeholder="Add a tag and press Enter"
                />
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
              <div className="creator-field-row">
                <label>
                  Version
                  <input
                    value={draft.version}
                    onChange={(event) => setDraft({ ...draft, version: event.target.value })}
                  />
                </label>
                <label>
                  Scope
                  <select
                    value={draft.scope}
                    onChange={(event) => setDraft({ ...draft, scope: event.target.value })}
                  >
                    <option value="personal">Personal</option>
                    <option value="organization">Organization</option>
                  </select>
                </label>
              </div>
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
                Choose a model now. Skills, tools, MCP servers, and plugins are managed as named
                references after creation.
              </p>
              <label>
                Model
                <select
                  value={draft.model === null ? "" : JSON.stringify(draft.model)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      model:
                        event.target.value === ""
                          ? null
                          : (JSON.parse(event.target.value) as ExpertModel),
                    })
                  }
                >
                  <option value="">Not configured</option>
                  {draft.model !== null && !configuredModelExists ? (
                    <option value={JSON.stringify(draft.model)}>
                      {draft.model.modelName} (saved configuration)
                    </option>
                  ) : null}
                  {props.modelProviders.map((provider) => (
                    <optgroup label={provider.name} key={provider.id}>
                      {provider.models.map((modelName) => {
                        const model = { providerId: provider.id, modelName };
                        return (
                          <option value={JSON.stringify(model)} key={modelName}>
                            {modelName}
                          </option>
                        );
                      })}
                    </optgroup>
                  ))}
                </select>
              </label>
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
                    {draft.model?.modelName ?? "No model"} · {draft.skills} skills · {draft.tools}{" "}
                    tools · {draft.mcpServers} MCP server
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
