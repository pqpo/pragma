import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MemoryAttentionStatus } from "@pragma/shared";

const REDACTED_API_KEY = "••••••••";

export function MemoryAttentionSettingsSection() {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<MemoryAttentionStatus>();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<string>();
  const statusRef = useRef<MemoryAttentionStatus | undefined>(undefined);
  const savingRef = useRef(false);
  const lastAttemptRef = useRef("");
  const draftRef = useRef("");
  const mountedRef = useRef(true);
  const pendingSaveRef = useRef<{ key: string; retry: boolean } | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (savingRef.current) return;
      try {
        const value = await window.pragmaDesktop.getMemoryAttentionStatus();
        if (cancelled || savingRef.current) return;
        if (statusRef.current === undefined) {
          const initialKey = value.configured ? REDACTED_API_KEY : "";
          lastAttemptRef.current = initialKey;
          draftRef.current = initialKey;
          setApiKey(initialKey);
        }
        if (value.revision < (statusRef.current?.revision ?? 0)) return;
        statusRef.current = value;
        setStatus(value);
      } catch {
        if (!cancelled) setError(t("memory.attention.loadError"));
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [t]);

  const update = useCallback(
    async (draft: string, retry = false) => {
      if (statusRef.current === undefined) return;
      pendingSaveRef.current = { key: draft.trim(), retry };
      if (savingRef.current) return;
      savingRef.current = true;
      if (mountedRef.current) setSaving(true);
      try {
        while (pendingSaveRef.current !== undefined) {
          const { key, retry: retryPending } = pendingSaveRef.current;
          pendingSaveRef.current = undefined;
          if (key === REDACTED_API_KEY || (!retryPending && key === lastAttemptRef.current))
            continue;
          lastAttemptRef.current = key;
          if (mountedRef.current) setError(undefined);
          try {
            const next = await window.pragmaDesktop.updateMemoryAttentionSettings({
              expectedRevision: statusRef.current.revision,
              apiKey: key === "" ? null : key,
            });
            statusRef.current = next;
            if (mountedRef.current) setStatus(next);
          } catch {
            if (mountedRef.current) setError(t("memory.attention.error"));
          }
        }
      } finally {
        savingRef.current = false;
        if (mountedRef.current) setSaving(false);
      }
    },
    [t],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void update(draftRef.current);
    };
  }, [update]);

  useEffect(() => {
    if (saving || composing || status === undefined || apiKey.trim() === lastAttemptRef.current)
      return;
    const timer = setTimeout(() => void update(apiKey), 700);
    return () => clearTimeout(timer);
  }, [apiKey, composing, saving, status, update]);

  return (
    <div className="memory-retrieval-field memory-attention-settings">
      <label htmlFor="memory-attention-key">
        <span id="memory-attention-label">{t("memory.attention.key")}</span>
      </label>
      <div className="memory-attention-input">
        <input
          id="memory-attention-key"
          type="password"
          aria-labelledby="memory-attention-label"
          aria-describedby={
            error === undefined
              ? "memory-attention-hint"
              : "memory-attention-hint memory-attention-error"
          }
          aria-invalid={error === undefined ? undefined : true}
          aria-busy={saving}
          autoComplete="off"
          value={apiKey}
          disabled={status === undefined}
          onChange={(event) => {
            draftRef.current = event.target.value;
            setApiKey(event.target.value);
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onBlur={() => void update(draftRef.current, error !== undefined)}
        />
        <p className="memory-attention-hint" id="memory-attention-hint">
          {t("memory.attention.description")}
        </p>
        {status?.state === "degraded" || status?.state === "needs_attention" ? (
          <p role="status">
            {t(`memory.attention.${status.state}`)}
            {status.errorCode === undefined ? null : ` · ${status.errorCode}`}
          </p>
        ) : null}
        {error === undefined ? null : (
          <p id="memory-attention-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
