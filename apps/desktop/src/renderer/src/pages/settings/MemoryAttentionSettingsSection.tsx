import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MemoryAttentionStatus } from "@pragma/shared";

export function MemoryAttentionSettingsSection({ enabled }: { readonly enabled: boolean }) {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<MemoryAttentionStatus>();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      void window.pragmaDesktop
        .getMemoryAttentionStatus()
        .then((value) => {
          if (!cancelled) setStatus(value);
        })
        .catch(() => {
          if (!cancelled) setError(t("memory.attention.loadError"));
        });
    refresh();
    const timer = setInterval(refresh, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [t]);
  const update = async (key: string | null) => {
    if (status === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      setStatus(
        await window.pragmaDesktop.updateMemoryAttentionSettings({
          expectedRevision: status.revision,
          apiKey: key,
        }),
      );
      setApiKey("");
    } catch {
      setError(t("memory.attention.error"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="memory-attention-settings" aria-labelledby="memory-attention-heading">
      <h3 id="memory-attention-heading">{t("memory.attention.title")}</h3>
      <p>{t("memory.attention.description")}</p>
      <p role="status">
        {!enabled
          ? t("memory.attention.paused")
          : status === undefined
            ? "…"
            : t(`memory.attention.${status.state}`)}
      </p>
      {status?.errorCode === undefined ? null : <p className="muted">{status.errorCode}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void update(apiKey.trim());
        }}
      >
        <label className="static-field" htmlFor="memory-attention-key">
          <span>{t("memory.attention.key")}</span>
          <input
            id="memory-attention-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            disabled={!enabled || saving}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <div className="memory-attention-actions">
          <button
            className="primary-button"
            type="submit"
            disabled={!enabled || saving || status === undefined || apiKey.trim() === ""}
          >
            {t("memory.attention.save")}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={saving || !status?.configured}
            onClick={() => void update(null)}
          >
            {t("memory.attention.remove")}
          </button>
        </div>
      </form>
      {error === undefined ? null : <p role="alert">{error}</p>}
    </section>
  );
}
