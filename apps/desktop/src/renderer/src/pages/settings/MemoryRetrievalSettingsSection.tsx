import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MemoryRetrievalStatus } from "@pragma/shared";
import type { ModelProvider } from "../../../../shared/contracts/index.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { Switch } from "../../components/Switch.tsx";
import { MemoryAttentionSettingsSection } from "./MemoryAttentionSettingsSection.tsx";
export function MemoryRetrievalSettingsSection() {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<MemoryRetrievalStatus>();
  const [providers, setProviders] = useState<readonly ModelProvider[]>([]);
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [test, setTest] = useState<string>();
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [next, models] = await Promise.all([
          window.pragmaDesktop.getMemoryRetrievalStatus(),
          window.pragmaDesktop.listModelProviders(),
        ]);
        if (active) {
          if (!saving.current)
            setStatus((current) =>
              current !== undefined && current.settings.revision > next.settings.revision
                ? current
                : next,
            );
          setProviders(models);
        }
      } catch {
        if (active) setError(t("memory.retrieval.loadError"));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [t]);
  const choices = providers.flatMap((provider) =>
    provider.models
      .filter((model) => model.kind === "embedding" && model.maxInputTokens !== undefined)
      .map((model) => ({
        value: `${provider.id}\0${model.id}`,
        label: `${provider.name} · ${model.name}`,
      })),
  );
  const hasSelectedModel =
    status !== undefined &&
    status.settings.providerId !== undefined &&
    status.settings.modelId !== undefined;
  const operation = async (run: () => Promise<void>) => {
    saving.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await run();
      setStatus(await window.pragmaDesktop.getMemoryRetrievalStatus());
    } catch {
      setError(t("memory.retrieval.operationError"));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const update = async (enabled: boolean, value?: string) => {
    if (status === undefined) return;
    const [providerId, modelId] = (
      value ??
      (status.settings.providerId && status.settings.modelId
        ? `${status.settings.providerId}\0${status.settings.modelId}`
        : "")
    ).split("\0");
    await operation(async () => {
      setStatus(
        await window.pragmaDesktop.updateMemoryRetrievalSettings({
          expectedRevision: status.settings.revision,
          enabled,
          ...(providerId && modelId ? { providerId, modelId } : {}),
        }),
      );
    });
  };
  return (
    <section className="memory-settings-section">
      <div className="setting-row">
        <div className="setting-copy">
          <strong>{t("memory.retrieval.title")}</strong>
          <small>{t("memory.retrieval.description")}</small>
        </div>
        <Switch
          ariaLabel={t("memory.retrieval.enable")}
          checked={status?.settings.enabled ?? false}
          disabled={busy || status === undefined}
          onChange={(enabled) => void update(enabled)}
        />
      </div>
      {status?.settings.enabled ? (
        <div className="memory-retrieval-fields">
          <div className="memory-retrieval-field">
            <span>{t("memory.retrieval.model")}</span>
            <SelectMenu
              className="settings-select memory-model-select"
              ariaLabel={t("memory.retrieval.model")}
              value={
                status.settings.providerId && status.settings.modelId
                  ? `${status.settings.providerId}\0${status.settings.modelId}`
                  : ""
              }
              options={[{ value: "", label: t("memory.retrieval.choose") }, ...choices]}
              disabled={busy}
              onChange={(value) => void update(true, value)}
            />
          </div>
          <MemoryAttentionSettingsSection />
        </div>
      ) : null}
      {status?.settings.enabled ? (
        <>
          {choices.length === 0 ? <p>{t("memory.retrieval.configure")}</p> : null}
          <div className="memory-retrieval-footer">
            <p className="memory-retrieval-status" role="status">
              {t(`memory.retrieval.state.${status.state}`)} ·{" "}
              {t("memory.retrieval.coverage", {
                indexed: status.indexedMemories,
                total: status.totalMemories,
                segments: status.segments,
                failed: status.failed,
              })}
              {status.errorCode ? <code>{status.errorCode}</code> : null}
            </p>
            <div className="memory-retrieval-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={busy || !hasSelectedModel}
                onClick={() =>
                  void operation(async () => {
                    const result = await window.pragmaDesktop.testMemoryEmbedding();
                    setTest(
                      t("memory.retrieval.testPassed", {
                        model: result.model,
                        dimensions: result.dimensions,
                      }),
                    );
                  })
                }
              >
                {t("memory.retrieval.test")}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy || !hasSelectedModel}
                onClick={() => void operation(() => window.pragmaDesktop.retryMemoryIndex())}
              >
                {t("memory.retrieval.retry")}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy || !hasSelectedModel}
                onClick={() => void operation(() => window.pragmaDesktop.rebuildMemoryIndex())}
              >
                {t("memory.retrieval.rebuild")}
              </button>
            </div>
          </div>
          {test ? <p role="status">{test}</p> : null}
        </>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
