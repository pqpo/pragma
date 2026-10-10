import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_POLICY,
  RuntimeProcessEnvironmentPolicySchema,
  type RuntimeProcessEnvironmentPolicy,
  type RuntimeProcessEnvironmentSettings,
} from "@pragma/shared";

import { errorMessage } from "../../lib/errors.ts";

export function GeneralProcessEnvironmentSettings() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<RuntimeProcessEnvironmentSettings | null>(null);
  const [policyDraft, setPolicyDraft] = useState<RuntimeProcessEnvironmentPolicy>(
    DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_POLICY,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.pragmaDesktop
      .getRuntimeProcessEnvironmentSettings()
      .then((nextSettings) => {
        if (cancelled) return;
        setSettings(nextSettings);
        setPolicyDraft(nextSettings.policy);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const policyValid = RuntimeProcessEnvironmentPolicySchema.safeParse(policyDraft).success;
  const changed = settings !== null && !samePolicy(policyDraft, settings.policy);

  const reloadSettings = async (showConflict = false) => {
    setLoading(true);
    setError(null);
    try {
      const latest = await window.pragmaDesktop.getRuntimeProcessEnvironmentSettings();
      setSettings(latest);
      setPolicyDraft(latest.policy);
      setSaved(false);
      if (showConflict) setError(t("general.processEnvironmentConflict"));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  const savePolicy = async () => {
    if (settings === null || !changed || !policyValid || saving) return;
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const nextSettings = await window.pragmaDesktop.updateRuntimeProcessEnvironmentPolicy({
        expectedRevision: settings.revision,
        policy: policyDraft,
      });
      setSettings(nextSettings);
      setPolicyDraft(nextSettings.policy);
      setSaved(true);
    } catch (cause) {
      if (errorMessage(cause) === "runtime_process_environment_settings_conflict") {
        await reloadSettings(true);
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="general-process-environment-settings"
      aria-labelledby="general-process-environment-heading"
    >
      <header>
        <h3 id="general-process-environment-heading">{t("general.processEnvironmentTitle")}</h3>
        <p>{t("general.processEnvironmentDescription")}</p>
      </header>

      {loading && settings === null ? (
        <p className="general-process-environment-status" role="status">
          {t("general.processEnvironmentLoading")}
        </p>
      ) : settings === null ? (
        <div className="general-process-environment-status" role="alert">
          <p>{t("general.processEnvironmentLoadFailed")}</p>
          <button className="secondary-button" type="button" onClick={() => void reloadSettings()}>
            {t("general.processEnvironmentRetry")}
          </button>
        </div>
      ) : (
        <>
          <label className="general-process-environment-mode">
            <input
              type="checkbox"
              checked={policyDraft.mode === "inherit-all"}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setPolicyDraft((current) => ({
                  ...current,
                  mode: checked ? "inherit-all" : "filtered",
                }));
                setSaved(false);
              }}
              disabled={loading || saving}
            />
            <span>
              <strong>{t("general.processEnvironmentFullAccess")}</strong>
              <small>{t("general.processEnvironmentFullAccessDescription")}</small>
            </span>
          </label>

          {policyDraft.mode === "inherit-all" ? (
            <p className="general-process-environment-warning" role="note">
              {t("general.processEnvironmentFullAccessWarning")}
            </p>
          ) : null}

          <div className="general-process-environment-lists">
            <label>
              <span>{t("general.processEnvironmentAllowlist")}</span>
              <small>{t("general.processEnvironmentAllowlistDescription")}</small>
              <textarea
                value={policyDraft.allowlist.join("\n")}
                onChange={(event) => {
                  const allowlist = parseEnvironmentVariableNames(event.currentTarget.value);
                  setPolicyDraft((current) => ({
                    ...current,
                    allowlist,
                  }));
                  setSaved(false);
                }}
                rows={5}
                spellCheck={false}
                disabled={loading || saving}
              />
            </label>
            <label>
              <span>{t("general.processEnvironmentBlocklist")}</span>
              <small>{t("general.processEnvironmentBlocklistDescription")}</small>
              <textarea
                value={policyDraft.blocklist.join("\n")}
                onChange={(event) => {
                  const blocklist = parseEnvironmentVariableNames(event.currentTarget.value);
                  setPolicyDraft((current) => ({
                    ...current,
                    blocklist,
                  }));
                  setSaved(false);
                }}
                rows={5}
                spellCheck={false}
                disabled={loading || saving}
              />
            </label>
          </div>

          {!policyValid ? (
            <p className="form-error" role="alert">
              {t("general.processEnvironmentInvalidVariable")}
            </p>
          ) : null}

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="general-process-environment-actions">
            {saved ? (
              <p className="general-process-environment-saved" role="status">
                {t("general.processEnvironmentSaved")}
              </p>
            ) : null}
            <button
              className="primary-button"
              type="button"
              onClick={() => void savePolicy()}
              disabled={loading || saving || !changed || !policyValid}
            >
              {saving ? t("general.processEnvironmentSaving") : t("general.processEnvironmentSave")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function parseEnvironmentVariableNames(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function samePolicy(
  left: RuntimeProcessEnvironmentPolicy,
  right: RuntimeProcessEnvironmentPolicy,
): boolean {
  return (
    left.mode === right.mode &&
    left.allowlist.join("\0") === right.allowlist.join("\0") &&
    left.blocklist.join("\0") === right.blocklist.join("\0")
  );
}
