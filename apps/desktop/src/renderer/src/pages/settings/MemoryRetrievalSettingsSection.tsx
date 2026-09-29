import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MemoryRetrievalStatus } from "@pragma/shared";
import type { ModelProvider } from "../../../../shared/contracts/index.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { Switch } from "../../components/Switch.tsx";
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
        : (choices[0]?.value ?? ""))
    ).split("\0");
    await operation(async () => {
      setStatus(
        await window.pragmaDesktop.updateMemoryRetrievalSettings({
          expectedRevision: status.settings.revision,
          enabled: enabled && Boolean(providerId && modelId),
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
          disabled={busy || status === undefined || choices.length === 0}
          onChange={(enabled) => void update(enabled)}
        />
      </div>
      <div className="setting-row">
        <span className="setting-copy">{t("memory.retrieval.model")}</span>
        <SelectMenu
          className="settings-select memory-model-select"
          ariaLabel={t("memory.retrieval.model")}
          value={
            status?.settings.providerId && status.settings.modelId
              ? `${status.settings.providerId}\0${status.settings.modelId}`
              : ""
          }
          options={[{ value: "", label: t("memory.retrieval.choose") }, ...choices]}
          disabled={busy || status === undefined}
          onChange={(value) => void update(status?.settings.enabled ?? false, value)}
        />
      </div>
      {choices.length === 0 ? <p>{t("memory.retrieval.configure")}</p> : null}
      {status ? (
        <p role="status">
          {t(`memory.retrieval.state.${status.state}`)} ·{" "}
          {t("memory.retrieval.coverage", {
            indexed: status.indexedMemories,
            total: status.totalMemories,
            segments: status.segments,
            failed: status.failed,
          })}
          {status.errorCode ? (
            <>
              <br />
              <code>{status.errorCode}</code>
            </>
          ) : null}
        </p>
      ) : null}
      <div className="memory-retrieval-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !status?.settings.enabled}
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
          disabled={busy || !status?.settings.enabled}
          onClick={() => void operation(() => window.pragmaDesktop.retryMemoryIndex())}
        >
          {t("memory.retrieval.retry")}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !status?.settings.enabled}
          onClick={() => void operation(() => window.pragmaDesktop.rebuildMemoryIndex())}
        >
          {t("memory.retrieval.rebuild")}
        </button>
      </div>
      {test ? <p role="status">{test}</p> : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
