import { CaretDown, Key, Plus, Robot, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import type { ModelConnectionTestResult, ModelProvider } from "../../../../shared/desktop-api.ts";
import { errorMessage } from "../../lib/errors.ts";
import { SettingsScreenFrame } from "./SettingsScreenFrame.tsx";

type ProviderDraft = {
  readonly id?: string;
  readonly name: string;
  readonly protocol: ModelProvider["protocol"];
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: readonly string[];
  readonly modelMetadata: ModelProvider["modelMetadata"];
};

const emptyProviderDraft = (): ProviderDraft => ({
  name: "",
  protocol: "openai-completions",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  models: [],
  modelMetadata: {},
});

function ProviderEditor(props: {
  readonly initialValue: ProviderDraft;
  readonly onCancel: () => void;
  readonly onSaved: (provider: ModelProvider) => void;
}) {
  const [draft, setDraft] = useState(props.initialValue);
  const [modelId, setModelId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isEditing = draft.id !== undefined;

  const addModel = () => {
    const normalized = modelId.trim();
    if (!normalized || draft.models.includes(normalized)) return;
    setDraft({ ...draft, models: [...draft.models, normalized] });
    setModelId("");
  };

  const save = async () => {
    setError(null);
    if (!isEditing && !draft.apiKey.trim()) {
      setError("Enter an API key before saving the provider.");
      return;
    }
    setSaving(true);
    try {
      const input = {
        name: draft.name,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl,
        models: [...draft.models],
        modelMetadata: draft.modelMetadata,
      };
      const provider = isEditing
        ? await window.pragmaDesktop.updateModelProvider({
            ...input,
            id: draft.id,
            ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
          })
        : await window.pragmaDesktop.createModelProvider({ ...input, apiKey: draft.apiKey });
      props.onSaved(provider);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="provider-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="static-field">
        <span>Provider name</span>
        <input
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          placeholder="My OpenAI-compatible API"
          autoFocus
        />
      </label>
      <label className="static-field">
        <span>API protocol</span>
        <span className="protocol-select-shell">
          <select
            value={draft.protocol}
            onChange={(event) =>
              setDraft({ ...draft, protocol: event.target.value as ModelProvider["protocol"] })
            }
          >
            <option value="openai-completions">OpenAI Chat Completions</option>
            <option value="openai-responses">OpenAI Responses</option>
            <option value="anthropic-messages">Anthropic Messages</option>
          </select>
          <CaretDown size={17} weight="bold" aria-hidden="true" />
        </span>
      </label>
      <label className="static-field">
        <span>API base URL</span>
        <input
          value={draft.baseUrl}
          onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
          placeholder="https://api.example.com/v1"
          inputMode="url"
        />
      </label>
      <label className="static-field">
        <span>API key</span>
        <span className="key-input-wrap">
          <Key size={16} aria-hidden="true" />
          <input
            type="password"
            value={draft.apiKey}
            onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            placeholder={isEditing ? "Saved securely — enter to replace" : "sk-..."}
            autoComplete="off"
          />
        </span>
      </label>
      <div className="static-field">
        <span>Models</span>
        <div className="model-input-row">
          <input
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addModel();
              }
            }}
            placeholder="e.g. gpt-4.1-mini"
          />
          <button className="secondary-button" type="button" onClick={addModel}>
            <Plus size={16} aria-hidden="true" />
            Add model
          </button>
        </div>
        <div className="model-chip-list" aria-label="Configured models">
          {draft.models.map((model) => (
            <span className="model-chip" key={model}>
              {model}
              <button
                type="button"
                aria-label={`Remove ${model}`}
                onClick={() =>
                  setDraft({
                    ...draft,
                    models: draft.models.filter((item) => item !== model),
                    modelMetadata: Object.fromEntries(
                      Object.entries(draft.modelMetadata).filter(([id]) => id !== model),
                    ),
                  })
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="configured-model-list">
          {draft.models.map((model) => {
            const metadata = draft.modelMetadata[model];
            const levels = metadata?.thinking?.supportedLevels ?? [];
            return (
              <div className="configured-model" key={`${model}:metadata`}>
                <div>
                  <strong>{model}</strong>
                  <label className="static-field">
                    <span>Display name</span>
                    <input
                      value={metadata?.displayName ?? ""}
                      placeholder={model}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          modelMetadata: updateModelMetadata(
                            draft.modelMetadata,
                            model,
                            event.target.value,
                            levels.map((level) => level.value),
                            metadata?.thinking?.defaultLevel,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="static-field">
                    <span>Thinking levels</span>
                    <input
                      key={`${model}:${levels.map((level) => level.value).join(",")}`}
                      defaultValue={levels.map((level) => level.value).join(", ")}
                      placeholder="low, medium, high"
                      onBlur={(event) => {
                        const values = parseThinkingLevels(event.target.value);
                        const defaultLevel = values.includes(metadata?.thinking?.defaultLevel ?? "")
                          ? metadata?.thinking?.defaultLevel
                          : undefined;
                        setDraft({
                          ...draft,
                          modelMetadata: updateModelMetadata(
                            draft.modelMetadata,
                            model,
                            metadata?.displayName,
                            values,
                            defaultLevel,
                          ),
                        });
                      }}
                    />
                  </label>
                  {levels.length > 0 ? (
                    <label className="static-field">
                      <span>Default thinking level</span>
                      <select
                        value={metadata?.thinking?.defaultLevel ?? ""}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            modelMetadata: updateModelMetadata(
                              draft.modelMetadata,
                              model,
                              metadata?.displayName,
                              levels.map((level) => level.value),
                              event.target.value || undefined,
                            ),
                          })
                        }
                      >
                        <option value="">Runtime default</option>
                        {levels.map((level) => (
                          <option key={level.value} value={level.value}>
                            {level.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="provider-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={props.onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save provider"}
        </button>
      </div>
    </form>
  );
}

function ProviderCard(props: {
  readonly provider: ModelProvider;
  readonly onDelete: () => void;
  readonly onEdit: () => void;
}) {
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ModelConnectionTestResult>>({});
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const testModel = async (modelId: string) => {
    setTestingModel(modelId);
    setError(null);
    try {
      const result = await window.pragmaDesktop.testModelConnection({
        providerId: props.provider.id,
        modelId,
      });
      setResults((current) => ({ ...current, [modelId]: result }));
    } catch (testError) {
      setError(errorMessage(testError));
    } finally {
      setTestingModel(null);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${props.provider.name}? This removes its saved API key.`)) return;
    setDeleting(true);
    setError(null);
    try {
      await window.pragmaDesktop.deleteModelProvider({ id: props.provider.id });
      props.onDelete();
    } catch (deleteError) {
      setError(errorMessage(deleteError));
      setDeleting(false);
    }
  };

  return (
    <article className="provider-card is-expanded">
      <header className="card-header">
        <span className="card-icon" aria-hidden="true">
          <Robot size={24} />
        </span>
        <div className="card-title-group">
          <h3>{props.provider.name}</h3>
          <p className="status-copy is-active">
            {props.provider.models.length} {props.provider.models.length === 1 ? "model" : "models"}
            <span aria-hidden="true">•</span>
            {props.provider.protocol}
          </p>
        </div>
        <button className="text-button" type="button" onClick={props.onEdit}>
          Edit
        </button>
      </header>
      <div className="provider-fields">
        <div className="static-field">
          <span>API base URL</span>
          <code className="configured-value">{props.provider.baseUrl}</code>
        </div>
        <div className="static-field">
          <span>API key</span>
          <span className="configured-value secret-value">
            <Key size={16} aria-hidden="true" />
            {props.provider.hasApiKey ? "Saved securely" : "Missing"}
          </span>
        </div>
        <div className="static-field">
          <span>Configured models</span>
          <div className="configured-model-list">
            {props.provider.models.map((model) => {
              const result = results[model];
              const isTesting = testingModel === model;
              return (
                <div className="configured-model" key={model}>
                  <div>
                    <strong>{model}</strong>
                    {props.provider.modelMetadata[model]?.thinking !== undefined ? (
                      <p>
                        Thinking:{" "}
                        {props.provider.modelMetadata[model]!.thinking!.supportedLevels.map(
                          (level) => level.label,
                        ).join(", ")}
                      </p>
                    ) : null}
                    {result ? (
                      <p
                        className={
                          result.ok ? "connection-result is-success" : "connection-result is-error"
                        }
                      >
                        {result.message}
                        {result.latencyMs !== undefined ? ` (${result.latencyMs} ms)` : ""}
                      </p>
                    ) : null}
                  </div>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void testModel(model)}
                    disabled={testingModel !== null}
                  >
                    {isTesting ? "Testing…" : "Test connection"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="provider-danger-zone">
        <button
          className="danger-button"
          type="button"
          onClick={() => void remove()}
          disabled={deleting}
        >
          <Trash size={16} aria-hidden="true" />
          {deleting ? "Deleting…" : "Delete provider"}
        </button>
      </div>
    </article>
  );
}

export function ModelProvidersFragment() {
  const [providers, setProviders] = useState<readonly ModelProvider[]>([]);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProviders = async () => {
    setLoading(true);
    try {
      setProviders(await window.pragmaDesktop.listModelProviders());
      setError(null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadProviders();
  }, []);

  const saveProvider = (provider: ModelProvider) => {
    setProviders((current) => {
      const existing = current.some((item) => item.id === provider.id);
      return existing
        ? current.map((item) => (item.id === provider.id ? provider : item))
        : [...current, provider];
    });
    setDraft(null);
  };

  return (
    <SettingsScreenFrame
      id="models-panel"
      labelledBy="models-panel-heading"
      header={
        <header className="panel-heading panel-heading-with-action">
          <div>
            <h2 id="models-panel-heading">Models &amp; Providers</h2>
            <p>Add OpenAI-compatible APIs and test each configured model.</p>
          </div>
          {draft ? null : (
            <button
              className="primary-button"
              type="button"
              onClick={() => setDraft(emptyProviderDraft())}
            >
              <Plus size={17} aria-hidden="true" />
              Add provider
            </button>
          )}
        </header>
      }
    >
      <div className="provider-list">
        {draft ? (
          <article className="provider-card is-expanded">
            <ProviderEditor
              initialValue={draft}
              onCancel={() => setDraft(null)}
              onSaved={saveProvider}
            />
          </article>
        ) : null}
        {loading ? <p className="empty-state">Loading providers…</p> : null}
        {!loading && !draft && providers.length === 0 ? (
          <div className="empty-state">
            <Robot size={28} aria-hidden="true" />
            <h3>No providers configured</h3>
            <p>Add an OpenAI-compatible API to configure models for this device.</p>
          </div>
        ) : null}
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            onEdit={() =>
              setDraft({
                id: provider.id,
                name: provider.name,
                protocol: provider.protocol,
                baseUrl: provider.baseUrl,
                apiKey: "",
                models: provider.models,
                modelMetadata: provider.modelMetadata,
              })
            }
            onDelete={() =>
              setProviders((current) => current.filter((item) => item.id !== provider.id))
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

function parseThinkingLevels(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function updateModelMetadata(
  current: ModelProvider["modelMetadata"],
  modelId: string,
  displayName: string | undefined,
  thinkingLevels: readonly string[],
  defaultLevel: string | undefined,
): ModelProvider["modelMetadata"] {
  const normalizedDisplayName = displayName?.trim();
  const metadata = {
    ...(normalizedDisplayName ? { displayName: normalizedDisplayName } : {}),
    ...(thinkingLevels.length === 0
      ? {}
      : {
          thinking: {
            supportedLevels: thinkingLevels.map((value) => ({ value, label: value })),
            ...(defaultLevel === undefined ? {} : { defaultLevel }),
          },
        }),
  };
  if (Object.keys(metadata).length === 0) {
    return Object.fromEntries(Object.entries(current).filter(([id]) => id !== modelId));
  }
  return { ...current, [modelId]: metadata };
}
