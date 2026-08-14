import { ArrowLeft, User } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PragmaResource } from "@pragma/interpreter/ast";
import {
  PRAGMA_TEXT_LIMITS,
  pragmaUnicodeLength,
  truncatePragmaTrimmedUnicode,
} from "@pragma/shared";

import { SelectMenu } from "../../components/SelectMenu.tsx";
import { ProfiledExpertAvatar } from "../../components/ProfiledExpertAvatar.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { runtimeDisplayName } from "../../lib/runtime-display.ts";
import {
  ExpertAdditionalInstructionsSchema,
  ExpertInstructionsSchema,
  ExpertScopeSchema,
  type Capability,
  type ContextStore,
  type DesktopRuntimeAvailability,
  type DesktopRuntimeModel,
  type DesktopPlugin,
} from "../../../../shared/contracts/index.ts";
import {
  desktopApi,
  isBuiltInExpert,
  type ExpertDraft,
  type ExpertRecord,
} from "./studio-model.ts";
import { ExpertCapabilityPicker } from "./ExpertCapabilityPicker.tsx";
import { ExpertPluginPicker } from "./ExpertPluginPicker.tsx";
import { ExpertAvatarPicker } from "./ExpertAvatarPicker.tsx";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { AssetMemoryPolicySection } from "../settings/AssetMemoryPolicySection.tsx";

type CreateStep = "identity" | "instructions" | "capabilities" | "review";
export type ExpertEditorMode = "create" | "edit";

export function ExpertEditorFragment(props: {
  readonly mode: ExpertEditorMode;
  readonly initialValue: ExpertDraft;
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly contextStores: readonly ContextStore[];
  readonly capabilities: readonly Capability[];
  readonly plugins: readonly DesktopPlugin[];
  readonly resources: readonly PragmaResource[];
  readonly onCancel: () => void;
  readonly onCreated: (expert: ExpertRecord) => Promise<void>;
}) {
  const { t } = useTranslation(["studio", "common"]);
  const [draft, setDraft] = useState(props.initialValue);
  const [step, setStep] = useState<CreateStep>("identity");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [selectedRuntime, setSelectedRuntime] = useState(props.initialValue.model?.runtimeId ?? "");
  const isEditing = props.mode === "edit";
  const isBuiltIn = isBuiltInExpert(props.initialValue);
  const selectedRuntimeInfo = props.runtimes.find((runtime) => runtime.id === selectedRuntime);
  const modelOptions = selectedRuntimeInfo?.models ?? [];
  const selectedModel = modelOptions.find(
    (model) => model.id === draft.model?.modelId && model.provider.id === draft.model?.providerId,
  );
  const steps: readonly { readonly id: CreateStep; readonly label: string }[] = [
    { id: "identity", label: t("identity", { ns: "studio" }) },
    {
      id: "instructions",
      label: t(isBuiltIn ? "behaviorPreferences" : "instructions", { ns: "studio" }),
    },
    { id: "capabilities", label: t("capabilities", { ns: "studio" }) },
    { id: "review", label: t("review", { ns: "studio" }) },
  ];
  const index = steps.findIndex((item) => item.id === step);
  const advance = () => {
    if (step === "identity") {
      const scopeResult = ExpertScopeSchema.safeParse(draft.scope);
      const hasInvalidLength =
        pragmaUnicodeLength(draft.name.trim()) > PRAGMA_TEXT_LIMITS.expert.name ||
        pragmaUnicodeLength(draft.description.trim()) > PRAGMA_TEXT_LIMITS.expert.description ||
        draft.tags.length > PRAGMA_TEXT_LIMITS.expert.tags ||
        draft.tags.some((tag) => pragmaUnicodeLength(tag.trim()) > PRAGMA_TEXT_LIMITS.expert.tag);
      if (
        !draft.name.trim() ||
        !draft.description.trim() ||
        !scopeResult.success ||
        hasInvalidLength
      ) {
        setError(
          hasInvalidLength
            ? "Name, description, or tags exceed their character limits."
            : "Name, description, and scope are required to define an expert.",
        );
        return;
      }
    }
    if (step === "instructions") {
      const instructionsResult = isBuiltIn
        ? ExpertAdditionalInstructionsSchema.safeParse(draft.additionalInstructions)
        : ExpertInstructionsSchema.safeParse(draft.instructions);
      if (!instructionsResult.success) {
        setError(
          instructionsResult.error.issues[0]?.message ??
            "Instructions are required to define an expert.",
        );
        return;
      }
    }
    if (
      step === "capabilities" &&
      !isBuiltIn &&
      (draft.model === null ||
        selectedRuntimeInfo?.status !== "available" ||
        selectedModel === undefined)
    ) {
      setError("Choose an available Runtime and model before continuing.");
      return;
    }
    setError(null);
    setStep(steps[Math.min(index + 1, steps.length - 1)]!.id);
  };
  const retreat = () => (index === 0 ? props.onCancel() : setStep(steps[index - 1]!.id));
  const addTag = () => {
    const tag = draft.tagInput.trim();
    if (
      !tag ||
      draft.tags.length >= PRAGMA_TEXT_LIMITS.expert.tags ||
      draft.tags.some((item) => item.toLowerCase() === tag.toLowerCase())
    )
      return;
    setDraft({ ...draft, tags: [...draft.tags, tag], tagInput: "" });
  };
  const setCapabilityReferences = (capabilities: ExpertDraft["capabilities"]) => {
    setDraft((current) => ({
      ...current,
      capabilities,
      skills: capabilities.filter((reference) => reference.kind === "skill").length,
      tools: capabilities
        .filter((reference) => reference.kind === "tools")
        .reduce((total, reference) => total + reference.toolNames.length, 0),
      mcpServers: capabilities.filter((reference) => reference.kind === "tools").length,
    }));
  };
  const submit = async () => {
    setError(null);
    const name = draft.name.trim();
    const description = draft.description.trim();
    const scopeResult = ExpertScopeSchema.safeParse(draft.scope);
    const instructionsResult = ExpertInstructionsSchema.safeParse(draft.instructions);
    const additionalInstructionsResult = ExpertAdditionalInstructionsSchema.safeParse(
      draft.additionalInstructions,
    );
    if (
      !name ||
      !description ||
      !scopeResult.success ||
      !instructionsResult.success ||
      !additionalInstructionsResult.success ||
      (!isBuiltIn &&
        (draft.model === null ||
          selectedRuntimeInfo?.status !== "available" ||
          selectedModel === undefined))
    ) {
      setError(
        !scopeResult.success
          ? (scopeResult.error.issues[0]?.message ?? "The expert scope is invalid.")
          : !instructionsResult.success
            ? (instructionsResult.error.issues[0]?.message ?? "Expert instructions are invalid.")
            : !additionalInstructionsResult.success
              ? (additionalInstructionsResult.error.issues[0]?.message ??
                "Additional instructions are invalid.")
              : !isBuiltIn && (draft.model === null || selectedModel === undefined)
                ? "Choose an available Runtime and model before creating the expert."
                : "Name, description, scope, and instructions are required.",
      );
      return;
    }
    setSaving(true);
    try {
      const api = desktopApi();
      if (api !== undefined && Object.keys(draft.pluginSecretMutations).length > 0) {
        await api.setPluginSecrets(draft.pluginSecretMutations);
      }
      const {
        pluginSecretMutations: _pluginSecretMutations,
        tagInput: _tagInput,
        ...record
      } = draft;
      void _pluginSecretMutations;
      void _tagInput;
      await props.onCreated({
        ...record,
        name,
        description,
        scope: scopeResult.data,
        instructions: instructionsResult.data,
        additionalInstructions: additionalInstructionsResult.data,
        model: draft.model,
        icon: User,
      });
    } catch (submitError) {
      setError(errorMessage(submitError));
      setSaving(false);
    }
  };

  return (
    <StudioScreenFrame
      className="expert-creator"
      labelledBy="create-expert-heading"
      header={
        <header className="studio-heading creator-heading">
          <button className="back-link" type="button" onClick={props.onCancel}>
            <ArrowLeft size={18} aria-hidden="true" />
            {t(isEditing ? "backExpertDetail" : "backExperts", { ns: "studio" })}
          </button>
          <div>
            <h1 id="create-expert-heading">
              {isBuiltIn
                ? t("customizeBuiltInExpert", { ns: "studio" })
                : isEditing
                  ? t("editExpert", { ns: "studio" })
                  : t("createExpert", { ns: "studio" })}
            </h1>
            {isBuiltIn || !isEditing ? (
              <p>
                {isBuiltIn
                  ? t("updateBuiltInExpertDescription", { ns: "studio" })
                  : t("createExpertDescription", { ns: "studio" })}
              </p>
            ) : null}
          </div>
        </header>
      }
    >
      <div className="creator-layout">
        <ol className="creator-steps" aria-label={t("createExpertSteps", { ns: "studio" })}>
          {steps.map((item, itemIndex) => (
            <li
              className={item.id === step ? "is-active" : itemIndex < index ? "is-complete" : ""}
              key={item.id}
            >
              <button
                type="button"
                disabled={!isEditing}
                aria-current={item.id === step ? "step" : undefined}
                onClick={() => {
                  if (isEditing) {
                    setError(null);
                    setStep(item.id);
                  }
                }}
              >
                <span>{itemIndex + 1}</span>
                {item.label}
              </button>
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
          <div className="creator-form-content">
            {step === "identity" ? (
              <>
                <div className="creator-preview">
                  <button
                    className="creator-avatar-button"
                    type="button"
                    aria-label={t("chooseAvatar", { ns: "studio" })}
                    title={t("chooseAvatar", { ns: "studio" })}
                    onClick={() => setAvatarPickerOpen(true)}
                  >
                    <ProfiledExpertAvatar avatarId={draft.avatarId} size="md" />
                  </button>
                  <div>
                    <strong>{draft.name || t("expertName", { ns: "studio" })}</strong>
                    <p>{draft.description || t("conciseDescription", { ns: "studio" })}</p>
                  </div>
                </div>
                <label>
                  {t("name", { ns: "studio" })}
                  <input
                    value={draft.name}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        name: truncatePragmaTrimmedUnicode(
                          event.target.value,
                          PRAGMA_TEXT_LIMITS.expert.name,
                        ),
                      })
                    }
                    placeholder={t("expertName", { ns: "studio" })}
                    maxLength={PRAGMA_TEXT_LIMITS.expert.name * 2}
                    autoFocus
                  />
                  <small className="field-hint">
                    <span>{t("chooseName", { ns: "studio" })}</span>
                    <span>
                      {pragmaUnicodeLength(draft.name.trim())}/{PRAGMA_TEXT_LIMITS.expert.name}
                    </span>
                  </small>
                </label>
                <label>
                  {t("description", { ns: "studio" })}
                  <textarea
                    value={draft.description}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        description: truncatePragmaTrimmedUnicode(
                          event.target.value,
                          PRAGMA_TEXT_LIMITS.expert.description,
                        ),
                      })
                    }
                    placeholder={t("expertPurpose", { ns: "studio" })}
                    maxLength={PRAGMA_TEXT_LIMITS.expert.description * 2}
                  />
                  <small className="field-hint">
                    <span>{t("descriptionHint", { ns: "studio" })}</span>
                    <span>
                      {pragmaUnicodeLength(draft.description.trim())}/
                      {PRAGMA_TEXT_LIMITS.expert.description}
                    </span>
                  </small>
                </label>
                <label>
                  {t("tags", { ns: "studio" })}
                  <input
                    value={draft.tagInput}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        tagInput: truncatePragmaTrimmedUnicode(
                          event.target.value,
                          PRAGMA_TEXT_LIMITS.expert.tag,
                        ),
                      })
                    }
                    maxLength={PRAGMA_TEXT_LIMITS.expert.tag * 2}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addTag();
                      }
                    }}
                    placeholder={t("addTag", { ns: "studio" })}
                  />
                  <small className="field-hint">
                    <span>
                      {t("tagLimit", { ns: "studio", count: PRAGMA_TEXT_LIMITS.expert.tag })}
                    </span>
                    <span>
                      {pragmaUnicodeLength(draft.tagInput.trim())}/{PRAGMA_TEXT_LIMITS.expert.tag}
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
                  {t("scope", { ns: "studio" })}
                  <textarea
                    value={draft.scope}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        scope: truncatePragmaTrimmedUnicode(
                          event.target.value,
                          PRAGMA_TEXT_LIMITS.expert.scope,
                        ),
                      })
                    }
                    placeholder={t("scopePrompt", { ns: "studio" })}
                    maxLength={PRAGMA_TEXT_LIMITS.expert.scope * 2}
                    readOnly={isBuiltIn}
                  />
                  <small className="field-hint">
                    <span>
                      {t(isBuiltIn ? "builtInScopeLocked" : "scopeHint", { ns: "studio" })}
                    </span>
                    <span>
                      {pragmaUnicodeLength(draft.scope.trim())}/{PRAGMA_TEXT_LIMITS.expert.scope}
                    </span>
                  </small>
                </label>
              </>
            ) : null}
            {step === "instructions" ? (
              <div className="instructions-editor">
                {isBuiltIn ? (
                  <label>
                    {t("builtInFoundationInstructions", { ns: "studio" })}
                    <textarea className="instructions-input" value={draft.instructions} readOnly />
                    <small className="field-hint">
                      <span>{t("builtInFoundationLocked", { ns: "studio" })}</span>
                    </small>
                  </label>
                ) : null}
                <label>
                  {t(isBuiltIn ? "additionalInstructions" : "instructions", { ns: "studio" })}
                  <textarea
                    className="instructions-input"
                    value={isBuiltIn ? draft.additionalInstructions : draft.instructions}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        ...(isBuiltIn
                          ? {
                              additionalInstructions: truncatePragmaTrimmedUnicode(
                                event.target.value,
                                PRAGMA_TEXT_LIMITS.expert.instructions,
                              ),
                            }
                          : {
                              instructions: truncatePragmaTrimmedUnicode(
                                event.target.value,
                                PRAGMA_TEXT_LIMITS.expert.instructions,
                              ),
                            }),
                      })
                    }
                    placeholder={t(
                      isBuiltIn ? "additionalInstructionsPrompt" : "instructionsPrompt",
                      { ns: "studio" },
                    )}
                    maxLength={PRAGMA_TEXT_LIMITS.expert.instructions * 2}
                    autoFocus
                  />
                  <small className="field-hint">
                    <span>
                      {t(isBuiltIn ? "additionalInstructionsHint" : "instructionsHint", {
                        ns: "studio",
                      })}
                    </span>
                    <span>
                      {pragmaUnicodeLength(
                        (isBuiltIn ? draft.additionalInstructions : draft.instructions).trim(),
                      )}
                      /{PRAGMA_TEXT_LIMITS.expert.instructions}
                    </span>
                  </small>
                </label>
              </div>
            ) : null}
            {step === "capabilities" ? (
              <div className="capability-editor">
                <h2>{t("addCapabilities", { ns: "studio" })}</h2>
                <p>{t("modelSelectionHint", { ns: "studio" })}</p>
                <div className="capability-editor-field">
                  <span>{t("runtime", { ns: "studio" })}</span>
                  <SelectMenu
                    ariaLabel={t("runtime", { ns: "studio" })}
                    className="form-select"
                    value={selectedRuntime}
                    options={[
                      {
                        value: "",
                        label: t(isBuiltIn ? "systemDefault" : "notConfigured", { ns: "studio" }),
                      },
                      ...props.runtimes.map((runtime) => ({
                        value: runtime.id,
                        label: `${runtimeDisplayName(t, runtime)}${
                          runtime.status === "available"
                            ? ""
                            : ` (${t("unavailable", { ns: "studio" })})`
                        }`,
                        disabled: runtime.status !== "available",
                      })),
                    ]}
                    onChange={(runtimeId) => {
                      setSelectedRuntime(runtimeId);
                      setDraft({ ...draft, model: null });
                    }}
                  />
                </div>
                {selectedRuntime ? (
                  <div className="capability-editor-field">
                    <span>{t("model", { ns: "studio" })}</span>
                    <SelectMenu
                      ariaLabel={t("model", { ns: "studio" })}
                      className="form-select"
                      value={selectedModel === undefined ? "" : runtimeModelKey(selectedModel)}
                      searchable={modelOptions.length > 8}
                      options={[
                        {
                          value: "",
                          label:
                            draft.model === null
                              ? t("selectModel", { ns: "studio" })
                              : t("unavailableModel", {
                                  ns: "studio",
                                  model: draft.model.modelId,
                                }),
                        },
                        ...modelOptions.map((model) => ({
                          value: runtimeModelKey(model),
                          label:
                            model.provider.kind === "registered"
                              ? `${model.provider.displayName} / ${model.displayName}`
                              : model.displayName,
                        })),
                      ]}
                      onChange={(modelKey) => {
                        const model = modelOptions.find(
                          (candidate) => runtimeModelKey(candidate) === modelKey,
                        );
                        setDraft({
                          ...draft,
                          model:
                            model === undefined
                              ? null
                              : {
                                  runtimeId: selectedRuntime,
                                  providerId: model.provider.id,
                                  modelId: model.id,
                                },
                        });
                      }}
                    />
                    {selectedRuntimeInfo?.modelDiscoveryError ? (
                      <small className="form-error">
                        {selectedRuntimeInfo.modelDiscoveryError}
                      </small>
                    ) : null}
                  </div>
                ) : null}
                {selectedModel?.thinking !== undefined ? (
                  <div className="capability-editor-field">
                    <span>{t("thinkingLevel", { ns: "studio" })}</span>
                    <SelectMenu
                      ariaLabel={t("thinkingLevel", { ns: "studio" })}
                      className="form-select"
                      value={draft.model?.thinkingLevel ?? ""}
                      options={[
                        {
                          value: "",
                          label: `${t("runtimeDefault", { ns: "studio" })}${
                            selectedModel.thinking.defaultLevel === undefined
                              ? ""
                              : ` (${selectedModel.thinking.defaultLevel})`
                          }`,
                        },
                        ...selectedModel.thinking.supportedLevels.map((level) => ({
                          value: level.value,
                          label: level.label,
                        })),
                      ]}
                      onChange={(thinkingLevel) => {
                        if (draft.model === null) return;
                        const model = { ...draft.model };
                        delete model.thinkingLevel;
                        setDraft({
                          ...draft,
                          model: {
                            ...model,
                            ...(thinkingLevel === "" ? {} : { thinkingLevel }),
                          },
                        });
                      }}
                    />
                  </div>
                ) : null}
                <ExpertCapabilityPicker
                  currentExpertId={draft.id}
                  resources={props.resources}
                  contextStores={props.contextStores}
                  capabilities={props.capabilities}
                  resourceTools={draft.resourceTools}
                  contextStoreMounts={draft.contextStoreMounts}
                  capabilityReferences={draft.capabilities}
                  toolApprovals={draft.toolApprovals}
                  allowResourceTools={!isBuiltIn}
                  onResourceToolsChange={(resourceTools) =>
                    setDraft((current) => ({ ...current, resourceTools }))
                  }
                  onContextStoreMountsChange={(contextStoreMounts) =>
                    setDraft((current) => ({ ...current, contextStoreMounts }))
                  }
                  onCapabilityReferencesChange={setCapabilityReferences}
                  onToolApprovalsChange={(toolApprovals) =>
                    setDraft((current) => ({ ...current, toolApprovals }))
                  }
                />
                <ExpertPluginPicker
                  plugins={props.plugins}
                  references={draft.plugins}
                  secretMutations={draft.pluginSecretMutations}
                  onReferencesChange={(plugins) => setDraft({ ...draft, plugins: [...plugins] })}
                  onSecretMutationsChange={(pluginSecretMutations) =>
                    setDraft({ ...draft, pluginSecretMutations })
                  }
                />
              </div>
            ) : null}
            {step === "review" ? (
              <div className="review-summary">
                <h2>
                  {isEditing
                    ? t("readySave", { ns: "studio" })
                    : t("readyCreate", { ns: "studio" })}
                </h2>
                <p>
                  {isEditing
                    ? t("reviewSave", { ns: "studio" })
                    : t("reviewCreate", { ns: "studio" })}
                </p>
                <dl>
                  <div>
                    <dt>{t("name", { ns: "studio" })}</dt>
                    <dd>{draft.name || t("untitledExpert", { ns: "studio" })}</dd>
                  </div>
                  <div>
                    <dt>{t("id", { ns: "studio" })}</dt>
                    <dd>{draft.id || t("generatedName", { ns: "studio" })}</dd>
                  </div>
                  <div>
                    <dt>{t("scope", { ns: "studio" })}</dt>
                    <dd>{draft.scope}</dd>
                  </div>
                  <div>
                    <dt>{t("capabilities", { ns: "studio" })}</dt>
                    <dd>
                      {draft.model === null
                        ? t(isBuiltIn ? "systemDefault" : "notConfigured", { ns: "studio" })
                        : `${draft.model.runtimeId} / ${draft.model.modelId}`}{" "}
                      · {draft.contextStoreMounts.length} knowledge bases · {draft.skills} skills ·{" "}
                      {draft.tools} tools · {draft.mcpServers} MCP server · {draft.plugins.length}{" "}
                      plugins
                      {isBuiltIn
                        ? ` · ${t("requiredSystemCapabilitiesLocked", { ns: "studio" })}`
                        : ""}
                    </dd>
                  </div>
                </dl>
                {isEditing ? (
                  <AssetMemoryPolicySection targetRef={{ type: "pragma.expert", id: draft.id }} />
                ) : null}
              </div>
            ) : null}
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <footer className="creator-actions">
            <button className="secondary-button" type="button" onClick={retreat} disabled={saving}>
              {index === 0 ? t("cancel", { ns: "studio" }) : t("back", { ns: "studio" })}
            </button>
            <button className="primary-button" type="submit" disabled={saving}>
              {saving
                ? isEditing
                  ? t("actions.saving", { ns: "common" })
                  : t("creating", { ns: "studio" })
                : step === "review"
                  ? isEditing
                    ? t("saveExpert", { ns: "studio" })
                    : t("createExpert", { ns: "studio" })
                  : t("continue", { ns: "studio" })}
            </button>
          </footer>
        </form>
      </div>
      {avatarPickerOpen ? (
        <ExpertAvatarPicker
          value={draft.avatarId}
          onCancel={() => setAvatarPickerOpen(false)}
          onChange={(avatarId) => {
            setDraft({ ...draft, avatarId });
            setAvatarPickerOpen(false);
          }}
        />
      ) : null}
    </StudioScreenFrame>
  );
}

function runtimeModelKey(model: DesktopRuntimeModel): string {
  return JSON.stringify([model.provider.kind, model.provider.id, model.id]);
}
