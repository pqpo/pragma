import { Check, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_POLICY,
  RuntimeProcessEnvironmentPolicySchema,
  type RuntimeProcessEnvironmentPolicy,
  type RuntimeProcessEnvironmentSettings,
} from "@pragma/shared";

import { Dialog } from "../../components/Dialog.tsx";
import { errorMessage } from "../../lib/errors.ts";

export function GeneralProcessEnvironmentSettings() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<RuntimeProcessEnvironmentSettings | null>(null);
  const [policyDraft, setPolicyDraft] = useState<RuntimeProcessEnvironmentPolicy>(
    DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_POLICY,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [activeList, setActiveList] = useState<"allowlist" | "blocklist" | null>(null);
  const [variableName, setVariableName] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

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

  const reloadSettings = async (showConflict = false) => {
    setLoading(true);
    setError(null);
    try {
      const latest = await window.pragmaDesktop.getRuntimeProcessEnvironmentSettings();
      setSettings(latest);
      setPolicyDraft(latest.policy);
      if (showConflict) setError(t("general.processEnvironmentConflict"));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  const savePolicy = async (policy: RuntimeProcessEnvironmentPolicy): Promise<boolean> => {
    if (
      settings === null ||
      saving ||
      !RuntimeProcessEnvironmentPolicySchema.safeParse(policy).success
    )
      return false;
    if (samePolicy(policy, settings.policy)) return true;
    setError(null);
    setSaving(true);
    try {
      const nextSettings = await window.pragmaDesktop.updateRuntimeProcessEnvironmentPolicy({
        expectedRevision: settings.revision,
        policy,
      });
      setSettings(nextSettings);
      setPolicyDraft(nextSettings.policy);
      return true;
    } catch (cause) {
      if (errorMessage(cause) === "runtime_process_environment_settings_conflict") {
        await reloadSettings(true);
      } else {
        setError(errorMessage(cause));
        if (activeList === null) setPolicyDraft(settings.policy);
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  const policyWithVariable = (): RuntimeProcessEnvironmentPolicy | null => {
    if (activeList === null || !variableName.trim()) return policyDraft;
    const name = variableName.trim();
    if (policyDraft[activeList].includes(name)) {
      setInputError(t("general.processEnvironmentDuplicateVariable"));
      return null;
    }
    const next = { ...policyDraft, [activeList]: [...policyDraft[activeList], name] };
    if (!RuntimeProcessEnvironmentPolicySchema.safeParse(next).success) {
      setInputError(t("general.processEnvironmentInvalidVariable"));
      return null;
    }
    return next;
  };

  const addVariable = () => {
    const next = policyWithVariable();
    if (next === null) return;
    setPolicyDraft(next);
    setVariableName("");
    setInputError(null);
  };

  const closeList = () => {
    if (saving) return;
    if (settings !== null) setPolicyDraft(settings.policy);
    setActiveList(null);
    setError(null);
  };

  const confirmList = async () => {
    const next = policyWithVariable();
    if (next !== null && (await savePolicy(next))) setActiveList(null);
  };

  return (
    <section
      className="setting-row general-process-environment-settings"
      aria-labelledby="general-process-environment-heading"
    >
      <header className="setting-copy">
        <strong id="general-process-environment-heading">
          {t("general.processEnvironmentTitle")}
        </strong>
        <span>{t("general.processEnvironmentDescription")}</span>
        {saving && activeList === null ? (
          <span role="status">{t("general.processEnvironmentSaving")}</span>
        ) : null}
        {error && activeList === null ? (
          <span className="form-error" role="alert">
            {error}
          </span>
        ) : null}
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
          <div className="general-process-environment-controls">
            <label
              className="general-process-environment-mode"
              title={`${t("general.processEnvironmentFullAccessDescription")} ${t("general.processEnvironmentFullAccessWarning")}`}
            >
              <input
                type="checkbox"
                checked={policyDraft.mode === "inherit-all"}
                onChange={(event) => {
                  const next: RuntimeProcessEnvironmentPolicy = {
                    ...policyDraft,
                    mode: event.currentTarget.checked ? "inherit-all" : "filtered",
                  };
                  setPolicyDraft(next);
                  void savePolicy(next);
                }}
                disabled={loading || saving}
              />
              <span>{t("general.processEnvironmentFullAccess")}</span>
            </label>
            {(["allowlist", "blocklist"] as const).map((list) => (
              <button
                key={list}
                className="secondary-button"
                type="button"
                aria-haspopup="dialog"
                aria-label={`${t(list === "allowlist" ? "general.processEnvironmentAllowlist" : "general.processEnvironmentBlocklist")} · ${t("general.processEnvironmentCount", { count: settings.policy[list].length })}`}
                disabled={loading || saving}
                onClick={() => {
                  setPolicyDraft(settings.policy);
                  setActiveList(list);
                  setVariableName("");
                  setInputError(null);
                  setError(null);
                }}
              >
                {t(
                  list === "allowlist"
                    ? "general.processEnvironmentAllowlist"
                    : "general.processEnvironmentBlocklist",
                )}
                <span>{settings.policy[list].length}</span>
              </button>
            ))}
          </div>

          {activeList !== null ? (
            <Dialog
              title={t(
                activeList === "allowlist"
                  ? "general.processEnvironmentAllowlist"
                  : "general.processEnvironmentBlocklist",
              )}
              description={t(
                activeList === "allowlist"
                  ? "general.processEnvironmentAllowlistDescription"
                  : "general.processEnvironmentBlocklistDescription",
              )}
              className="general-process-environment-dialog"
              busy={saving}
              onCancel={closeList}
              footer={
                <button
                  className="primary-button"
                  type="button"
                  disabled={saving}
                  onClick={() => void confirmList()}
                >
                  {t(
                    saving ? "general.processEnvironmentSaving" : "general.processEnvironmentDone",
                  )}
                </button>
              }
            >
              {error ? (
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : null}
              <label
                className="general-process-environment-input-label"
                htmlFor="process-environment-variable"
              >
                {t("general.processEnvironmentVariableName")}
              </label>
              <div className="general-process-environment-add">
                <input
                  id="process-environment-variable"
                  data-dialog-initial-focus
                  value={variableName}
                  placeholder="JAVA_HOME"
                  disabled={saving}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={inputError ? true : undefined}
                  aria-describedby={inputError ? "process-environment-variable-error" : undefined}
                  onChange={(event) => {
                    setVariableName(event.currentTarget.value);
                    setInputError(null);
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.nativeEvent.isComposing &&
                      event.keyCode !== 229
                    ) {
                      event.preventDefault();
                      addVariable();
                    }
                  }}
                />
                <button
                  className="secondary-button"
                  type="button"
                  aria-label={t("general.processEnvironmentAdd")}
                  title={t("general.processEnvironmentAdd")}
                  disabled={saving || !variableName.trim()}
                  onClick={addVariable}
                >
                  <Check size={18} aria-hidden="true" />
                </button>
              </div>
              {inputError ? (
                <p className="form-error" id="process-environment-variable-error" role="alert">
                  {inputError}
                </p>
              ) : null}
              <p className="general-process-environment-status">
                {t("general.processEnvironmentCount", { count: policyDraft[activeList].length })}
              </p>
              <div className="general-process-environment-tags">
                {policyDraft[activeList].length === 0 ? (
                  <p className="general-process-environment-status">
                    {t("general.processEnvironmentEmpty")}
                  </p>
                ) : (
                  policyDraft[activeList].map((name) => (
                    <span className="general-process-environment-tag" key={name}>
                      <code>{name}</code>
                      <button
                        type="button"
                        disabled={saving}
                        aria-label={t("general.processEnvironmentRemove", { name })}
                        title={t("general.processEnvironmentRemove", { name })}
                        onClick={() => {
                          setPolicyDraft((current) => ({
                            ...current,
                            [activeList]: current[activeList].filter((value) => value !== name),
                          }));
                        }}
                      >
                        <X size={16} aria-hidden="true" />
                      </button>
                    </span>
                  ))
                )}
              </div>
            </Dialog>
          ) : null}
        </>
      )}
    </section>
  );
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
