import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle,
  Key,
  MagnifyingGlass,
  Plus,
  Robot,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  ModelConnectionTestResult,
  ModelProvider,
  ModelProviderModel,
} from "../../../../shared/desktop-api.ts";
import {
  MODEL_PROVIDER_PRESETS,
  findModelProviderPreset,
} from "../../../../shared/model-provider-presets.ts";
import { ModelProviderLogo } from "../../components/ModelProviderLogo.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ProviderDraft = {
  readonly id?: string;
  readonly presetId: string;
  readonly name: string;
  readonly protocol: ModelProvider["protocol"];
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly requiresApiKey: boolean;
  readonly models: readonly ModelProviderModel[];
};

const emptyProviderDraft = (): ProviderDraft => ({
  presetId: "",
  name: "",
  protocol: "openai-completions",
  baseUrl: "",
  apiKey: "",
  requiresApiKey: true,
  models: [],
});

export function ProviderEditor(props: {
  readonly initialValue: ProviderDraft;
  readonly onCancel: () => void;
  readonly onSaved: (provider: ModelProvider) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [draft, setDraft] = useState(props.initialValue);
  const [step, setStep] = useState<1 | 2 | 3>(props.initialValue.presetId === "" ? 1 : 2);
  const [availableModels, setAvailableModels] = useState<readonly ModelProviderModel[]>(
    props.initialValue.models,
  );
  const [modelQuery, setModelQuery] = useState("");
  const [manualModelId, setManualModelId] = useState("");
  const [discoveryMessage, setDiscoveryMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isEditing = draft.id !== undefined;

  const selectPreset = (presetId: string) => {
    const preset = findModelProviderPreset(presetId)!;
    setDraft({
      ...draft,
      presetId: preset.id,
      name: preset.name,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      requiresApiKey: preset.requiresApiKey,
      models: [],
    });
    setAvailableModels([]);
    setStep(2);
  };

  const discover = async () => {
    setError(null);
    if (draft.requiresApiKey && !isEditing && draft.apiKey.trim() === "") {
      setError(t("models.enterApiKey", { ns: "settings" }));
      return;
    }
    setBusy(true);
    try {
      const result = await window.pragmaDesktop.discoverProviderModels({
        presetId: draft.presetId,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl,
        ...(draft.apiKey.trim() === "" ? {} : { apiKey: draft.apiKey }),
        ...(draft.id === undefined ? {} : { providerId: draft.id }),
      });
      const merged = mergeModels(draft.models, result.models);
      setAvailableModels(merged);
      setDiscoveryMessage(result.message);
      if (draft.models.length === 0 && result.models.length > 0) {
        setDraft({ ...draft, models: result.models.slice(0, 3) });
      }
      setStep(3);
    } catch (discoveryError) {
      setAvailableModels(draft.models);
      setDiscoveryMessage(errorMessage(discoveryError));
      setStep(3);
    } finally {
      setBusy(false);
    }
  };

  const save = async (verify: boolean) => {
    setError(null);
    if (draft.models.length === 0) {
      setError(t("models.chooseAtLeastOne", { ns: "settings" }));
      return;
    }
    setBusy(true);
    try {
      const input = {
        presetId: draft.presetId,
        name: draft.name,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl,
        requiresApiKey: draft.requiresApiKey,
        models: [...draft.models],
      };
      const saved = isEditing
        ? await window.pragmaDesktop.updateModelProvider({
            ...input,
            id: draft.id,
            ...(draft.apiKey.trim() === "" ? {} : { apiKey: draft.apiKey }),
          })
        : await window.pragmaDesktop.createModelProvider({ ...input, apiKey: draft.apiKey });
      if (verify) {
        await window.pragmaDesktop.testModelConnection({
          providerId: saved.id,
          modelId: saved.models[0]?.id,
        });
        const refreshed = (await window.pragmaDesktop.getModelProviderSettings()).providers.find(
          (provider) => provider.id === saved.id,
        );
        props.onSaved(refreshed ?? saved);
      } else {
        props.onSaved(saved);
      }
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    return availableModels
      .filter(
        (model) =>
          query === "" ||
          model.id.toLowerCase().includes(query) ||
          model.name.toLowerCase().includes(query),
      )
      .slice(0, 100);
  }, [availableModels, modelQuery]);

  return (
    <div className="provider-editor provider-wizard">
      <ol
        className="provider-wizard-steps"
        aria-label={t("models.setupProgress", { ns: "settings" })}
      >
        {[1, 2, 3].map((number) => (
          <li
            className={number === step ? "is-current" : number < step ? "is-complete" : ""}
            key={number}
          >
            <span className="provider-wizard-step-index">
              {number < step ? <Check size={13} weight="bold" /> : number}
            </span>
            <span className="provider-wizard-step-label">
              {t(`models.step${number}` as "models.step1", { ns: "settings" })}
            </span>
          </li>
        ))}
      </ol>

      {step === 1 ? (
        <section className="provider-wizard-panel">
          <div className="wizard-heading">
            <h3>{t("models.chooseProvider", { ns: "settings" })}</h3>
            <p>{t("models.chooseProviderDescription", { ns: "settings" })}</p>
          </div>
          {(["official", "gateway", "local", "custom"] as const).map((category) => (
            <div className="provider-preset-section" key={category}>
              <h4>
                {t(`models.category.${category}` as "models.category.official", { ns: "settings" })}
              </h4>
              <div className="provider-preset-grid">
                {MODEL_PROVIDER_PRESETS.filter((preset) => preset.category === category).map(
                  (preset) => (
                    <button
                      className="provider-preset-card"
                      type="button"
                      key={preset.id}
                      onClick={() => selectPreset(preset.id)}
                    >
                      <span className="provider-preset-mark">
                        <ModelProviderLogo presetId={preset.id} />
                      </span>
                      <span>
                        <strong>{preset.name}</strong>
                        <small>
                          {t(
                            `models.presetDescription.${preset.category}` as "models.presetDescription.official",
                            {
                              ns: "settings",
                            },
                          )}
                        </small>
                      </span>
                      <ArrowRight size={16} aria-hidden="true" />
                    </button>
                  ),
                )}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {step === 2 ? (
        <section className="provider-wizard-panel">
          <div className="wizard-heading">
            <h3>{t("models.configureConnection", { ns: "settings" })}</h3>
            <p>{t("models.configureConnectionDescription", { ns: "settings" })}</p>
          </div>
          <div className="provider-connection-grid">
            <label className="static-field">
              <span>{t("models.providerName", { ns: "settings" })}</span>
              <input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                autoFocus
              />
            </label>
            <label className="static-field provider-url-field">
              <span>{t("models.baseUrl", { ns: "settings" })}</span>
              <input
                value={draft.baseUrl}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                inputMode="url"
              />
            </label>
            <label className="static-field provider-key-field">
              <span>
                {t("models.apiKey", { ns: "settings" })}
                {draft.requiresApiKey ? "" : ` · ${t("models.optional", { ns: "settings" })}`}
              </span>
              <span className="key-input-wrap">
                <Key size={16} aria-hidden="true" />
                <input
                  type="password"
                  value={draft.apiKey}
                  onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                  placeholder={
                    isEditing
                      ? t("models.savedSecurelyReplace", { ns: "settings" })
                      : draft.requiresApiKey
                        ? "sk-…"
                        : t("models.noKeyRequired", { ns: "settings" })
                  }
                  autoComplete="off"
                />
              </span>
            </label>
            {draft.presetId === "custom-openai" ? (
              <label className="static-field">
                <span>{t("models.protocol", { ns: "settings" })}</span>
                <select
                  value={draft.protocol}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      protocol: event.target.value as ModelProvider["protocol"],
                    })
                  }
                >
                  <option value="openai-completions">OpenAI Chat Completions</option>
                  <option value="openai-responses">OpenAI Responses</option>
                </select>
              </label>
            ) : null}
          </div>
        </section>
      ) : null}

      {step === 3 ? (
        <section className="provider-wizard-panel">
          <div className="wizard-heading">
            <h3>{t("models.chooseModels", { ns: "settings" })}</h3>
            <p>{discoveryMessage ?? t("models.chooseModelsDescription", { ns: "settings" })}</p>
          </div>
          <label className="model-search-shell">
            <MagnifyingGlass size={17} aria-hidden="true" />
            <input
              value={modelQuery}
              onChange={(event) => setModelQuery(event.target.value)}
              placeholder={t("models.searchModels", { ns: "settings" })}
            />
          </label>
          {filteredModels.length > 0 ? (
            <div className="model-picker-list" role="list">
              {filteredModels.map((model) => {
                const selected = draft.models.some((candidate) => candidate.id === model.id);
                return (
                  <button
                    className={selected ? "model-picker-row is-selected" : "model-picker-row"}
                    type="button"
                    key={model.id}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        models: selected
                          ? draft.models.filter((candidate) => candidate.id !== model.id)
                          : [...draft.models, model],
                      })
                    }
                  >
                    <span className="model-picker-check">
                      {selected ? <Check size={13} weight="bold" /> : null}
                    </span>
                    <span>
                      <strong>{model.name}</strong>
                      <small>{model.id}</small>
                    </span>
                    <span className="capability-tags">
                      {model.input.includes("image") ? <em>Vision</em> : null}
                      {model.reasoning ? <em>Reasoning</em> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className="manual-model-row">
            <input
              value={manualModelId}
              onChange={(event) => setManualModelId(event.target.value)}
              placeholder={t("models.manualModelPlaceholder", { ns: "settings" })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addManualModel(
                    manualModelId,
                    draft,
                    setDraft,
                    setAvailableModels,
                    setManualModelId,
                  );
                }
              }}
            />
            <button
              className="secondary-button"
              type="button"
              onClick={() =>
                addManualModel(manualModelId, draft, setDraft, setAvailableModels, setManualModelId)
              }
            >
              <Plus size={16} />
              {t("models.addModel", { ns: "settings" })}
            </button>
          </div>
          {draft.models.length > 0 ? (
            <div className="selected-model-config">
              <h4>{t("models.selectedModels", { ns: "settings", count: draft.models.length })}</h4>
              {draft.models.map((model) => (
                <ModelCapabilityEditor
                  key={model.id}
                  model={model}
                  onChange={(next) =>
                    setDraft({
                      ...draft,
                      models: draft.models.map((candidate) =>
                        candidate.id === next.id ? next : candidate,
                      ),
                    })
                  }
                  onRemove={() =>
                    setDraft({
                      ...draft,
                      models: draft.models.filter((candidate) => candidate.id !== model.id),
                    })
                  }
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="provider-actions provider-wizard-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={step === 1 ? props.onCancel : () => setStep((step - 1) as 1 | 2)}
          disabled={busy}
        >
          <ArrowLeft size={16} />
          {step === 1
            ? t("models.cancel", { ns: "settings" })
            : t("models.back", { ns: "settings" })}
        </button>
        {step === 2 ? (
          <button
            className="primary-button"
            type="button"
            onClick={() => void discover()}
            disabled={busy}
          >
            {busy
              ? t("models.discovering", { ns: "settings" })
              : t("models.continue", { ns: "settings" })}
            <ArrowRight size={16} />
          </button>
        ) : null}
        {step === 3 ? (
          <>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void save(false)}
              disabled={busy}
            >
              {t("models.saveOnly", { ns: "settings" })}
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() => void save(true)}
              disabled={busy}
            >
              {busy
                ? t("actions.saving", { ns: "common" })
                : t("models.saveAndVerify", { ns: "settings" })}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ModelCapabilityEditor(props: {
  readonly model: ModelProviderModel;
  readonly onChange: (model: ModelProviderModel) => void;
  readonly onRemove: () => void;
}) {
  const { t } = useTranslation("settings");
  const supported = supportedThinkingLevels(props.model);
  const setReasoning = (reasoning: boolean) =>
    props.onChange({
      ...props.model,
      reasoning,
      ...(reasoning
        ? { thinkingLevelMap: createThinkingMap(["off", "low", "medium", "high"]) }
        : { thinkingLevelMap: undefined }),
    });
  return (
    <div className="selected-model-row">
      <div>
        <strong>{props.model.name}</strong>
        <small>{props.model.id}</small>
      </div>
      <label className="compact-check">
        <input
          type="checkbox"
          checked={props.model.reasoning}
          onChange={(event) => setReasoning(event.target.checked)}
        />
        {t("models.reasoning")}
      </label>
      {props.model.reasoning ? (
        <div className="thinking-level-options" aria-label={t("models.thinkingLevels")}>
          {THINKING_LEVELS.map((level) => (
            <label key={level}>
              <input
                type="checkbox"
                checked={supported.includes(level)}
                onChange={() => {
                  const next = supported.includes(level)
                    ? supported.filter((value) => value !== level)
                    : [...supported, level];
                  props.onChange({ ...props.model, thinkingLevelMap: createThinkingMap(next) });
                }}
              />
              <span>{level}</span>
            </label>
          ))}
        </div>
      ) : null}
      <button
        className="model-remove-button"
        type="button"
        onClick={props.onRemove}
        aria-label={t("models.removeModel", { model: props.model.id })}
      >
        <X size={15} weight="bold" />
      </button>
    </div>
  );
}

function ProviderCard(props: {
  readonly provider: ModelProvider;
  readonly onDelete: () => void;
  readonly onEdit: () => void;
  readonly onRefresh: (provider: ModelProvider) => void;
}) {
  const { t } = useTranslation("settings");
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<ModelConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const verification =
    result === null
      ? props.provider.verification
      : {
          status: result.ok ? ("verified" as const) : ("failed" as const),
          message: result.message,
        };
  const test = async () => {
    setTesting(true);
    setError(null);
    try {
      const next = await window.pragmaDesktop.testModelConnection({
        providerId: props.provider.id,
      });
      setResult(next);
      const refreshed = (await window.pragmaDesktop.getModelProviderSettings()).providers.find(
        (provider) => provider.id === props.provider.id,
      );
      if (refreshed) props.onRefresh(refreshed);
    } catch (testError) {
      setError(errorMessage(testError));
    } finally {
      setTesting(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(t("models.deleteConfirm", { name: props.provider.name }))) return;
    setDeleting(true);
    try {
      await window.pragmaDesktop.deleteModelProvider({ id: props.provider.id });
      props.onDelete();
    } catch (deleteError) {
      setError(errorMessage(deleteError));
      setDeleting(false);
    }
  };
  return (
    <article className="provider-card provider-summary-card">
      <header className="card-header">
        <span className="card-icon">
          <ModelProviderLogo presetId={props.provider.presetId} />
        </span>
        <div className="card-title-group">
          <h3>{props.provider.name}</h3>
          <p>
            {props.provider.models.length} {t("models.models")} · {props.provider.presetId}
          </p>
        </div>
        <VerificationBadge verification={verification} />
        <button className="text-button" type="button" onClick={props.onEdit}>
          {t("models.edit")}
        </button>
      </header>
      <div className="provider-summary-meta">
        <code>{props.provider.baseUrl}</code>
        <span>
          <Key size={15} />
          {props.provider.hasApiKey ? t("models.savedSecurely") : t("models.noKeyRequired")}
        </span>
      </div>
      <div className="provider-model-chips">
        {props.provider.models.slice(0, 8).map((model) => (
          <span key={model.id}>
            {model.name}
            {model.reasoning ? " · R" : ""}
          </span>
        ))}
        {props.provider.models.length > 8 ? <span>+{props.provider.models.length - 8}</span> : null}
      </div>
      {verification.message ? (
        <p
          className={
            verification.status === "failed"
              ? "connection-result is-error"
              : "connection-result is-success"
          }
        >
          {verification.message}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="provider-card-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={() => void test()}
          disabled={testing}
        >
          {testing ? t("models.testing") : t("models.testConnection")}
        </button>
        <button
          className="danger-button"
          type="button"
          onClick={() => void remove()}
          disabled={deleting}
        >
          <Trash size={16} />
          {deleting ? t("models.deleting") : t("models.deleteProvider")}
        </button>
      </div>
    </article>
  );
}

function VerificationBadge({
  verification,
}: {
  readonly verification: ModelProvider["verification"];
}) {
  const { t } = useTranslation("settings");
  const ok = verification.status === "verified";
  return (
    <span className={`verification-badge is-${verification.status}`}>
      {ok ? (
        <CheckCircle size={16} weight="fill" />
      ) : (
        <WarningCircle size={16} weight={verification.status === "failed" ? "fill" : "regular"} />
      )}
      {t(`models.verification.${verification.status}` as "models.verification.verified")}
    </span>
  );
}

export function ModelProvidersFragment() {
  const { t } = useTranslation("settings");
  const [providers, setProviders] = useState<readonly ModelProvider[]>([]);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetRequired, setResetRequired] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setLoading(true);
    try {
      const snapshot = await window.pragmaDesktop.getModelProviderSettings();
      setProviders(snapshot.providers);
      setResetRequired(
        snapshot.status === "reset_required"
          ? (snapshot.message ?? t("models.resetRequiredDescription"))
          : null,
      );
      setError(null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const saveProvider = (provider: ModelProvider) => {
    setProviders((current) =>
      current.some((item) => item.id === provider.id)
        ? current.map((item) => (item.id === provider.id ? provider : item))
        : [...current, provider],
    );
    setDraft(null);
  };
  return (
    <SettingsScreenFrame
      id="models-panel"
      labelledBy="models-panel-heading"
      header={
        <header className="panel-heading panel-heading-with-action">
          <div>
            <h2 id="models-panel-heading">{t("models.title")}</h2>
            <p>{t("models.description")}</p>
          </div>
          {draft || resetRequired ? null : (
            <button
              className="primary-button"
              type="button"
              onClick={() => setDraft(emptyProviderDraft())}
            >
              <Plus size={17} />
              {t("models.addProvider")}
            </button>
          )}
        </header>
      }
    >
      <div className="provider-list">
        {resetRequired ? (
          <div className="provider-reset-state">
            <WarningCircle size={30} />
            <h3>{t("models.resetRequired")}</h3>
            <p>{resetRequired}</p>
            <button
              className="danger-button"
              type="button"
              onClick={async () => {
                try {
                  const result = await window.pragmaDesktop.resetModelProviders();
                  setProviders(result.providers);
                  setResetRequired(null);
                } catch (resetError) {
                  setError(errorMessage(resetError));
                }
              }}
            >
              {t("models.archiveAndReset")}
            </button>
          </div>
        ) : null}
        {draft ? (
          <article className="provider-card is-expanded">
            <ProviderEditor
              initialValue={draft}
              onCancel={() => setDraft(null)}
              onSaved={saveProvider}
            />
          </article>
        ) : null}
        {loading ? <p className="empty-state">{t("models.loading")}</p> : null}
        {!loading && !draft && !resetRequired && providers.length === 0 ? (
          <div className="empty-state">
            <Robot size={28} />
            <h3>{t("models.empty")}</h3>
            <p>{t("models.addProviderDescription")}</p>
          </div>
        ) : null}
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            onEdit={() =>
              setDraft({
                id: provider.id,
                presetId: provider.presetId,
                name: provider.name,
                protocol: provider.protocol,
                baseUrl: provider.baseUrl,
                apiKey: "",
                requiresApiKey: provider.requiresApiKey,
                models: provider.models,
              })
            }
            onDelete={() =>
              setProviders((current) => current.filter((item) => item.id !== provider.id))
            }
            onRefresh={(next) =>
              setProviders((current) => current.map((item) => (item.id === next.id ? next : item)))
            }
          />
        ))}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </SettingsScreenFrame>
  );
}

function mergeModels(
  current: readonly ModelProviderModel[],
  discovered: readonly ModelProviderModel[],
): readonly ModelProviderModel[] {
  const map = new Map(discovered.map((model) => [model.id, model]));
  for (const model of current) map.set(model.id, model);
  return [...map.values()];
}
export function supportedThinkingLevels(model: ModelProviderModel): string[] {
  if (!model.reasoning) return [];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}
function createThinkingMap(
  supported: readonly string[],
): NonNullable<ModelProviderModel["thinkingLevelMap"]> {
  return Object.fromEntries(
    THINKING_LEVELS.map((level) => [level, supported.includes(level) ? level : null]),
  );
}
function addManualModel(
  idValue: string,
  draft: ProviderDraft,
  setDraft: (draft: ProviderDraft) => void,
  setAvailable: (models: readonly ModelProviderModel[]) => void,
  clear: (value: string) => void,
) {
  const id = idValue.trim();
  if (id === "" || draft.models.some((model) => model.id === id)) return;
  const model: ModelProviderModel = {
    id,
    name: id,
    api: draft.protocol,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    capabilitiesSource: "manual",
  };
  setDraft({ ...draft, models: [...draft.models, model] });
  setAvailable(mergeModels([model], draft.models));
  clear("");
}
