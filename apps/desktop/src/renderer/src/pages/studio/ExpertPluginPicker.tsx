import { ArrowCounterClockwise, MagnifyingGlass, PuzzlePiece, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DesktopPlugin, ExpertPluginReference } from "../../../../shared/desktop-api.ts";
import { PluginConfigFields } from "./PluginConfigFields.tsx";

const PLUGIN_RESULT_LIMIT = 8;

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function matchingPlugins(
  plugins: readonly DesktopPlugin[],
  query: string,
  selectedRefs: ReadonlySet<string>,
  limit = PLUGIN_RESULT_LIMIT,
): readonly DesktopPlugin[] {
  const term = normalized(query);
  return plugins
    .filter((plugin) =>
      term.length === 0
        ? true
        : [
            plugin.manifest.name,
            plugin.manifest.id,
            plugin.manifest.description,
            ...plugin.manifest.tags,
          ].some((value) => normalized(value).includes(term)),
    )
    .toSorted((left, right) => {
      const selectedOrder =
        Number(selectedRefs.has(right.ref)) - Number(selectedRefs.has(left.ref));
      return selectedOrder || left.manifest.name.localeCompare(right.manifest.name);
    })
    .slice(0, limit);
}

export function restorePluginReferenceDefaults(
  reference: ExpertPluginReference,
  secretMutations: Readonly<Record<string, string | null>>,
): {
  readonly reference: ExpertPluginReference;
  readonly secretMutations: Readonly<Record<string, string | null>>;
} {
  const bindings = Object.values(reference.secretBindings ?? {});
  return {
    reference: { ref: reference.ref },
    secretMutations: {
      ...secretMutations,
      ...Object.fromEntries(bindings.map((binding) => [binding, null] as const)),
    },
  };
}

export function ExpertPluginPicker(props: {
  readonly plugins: readonly DesktopPlugin[];
  readonly references: readonly ExpertPluginReference[];
  readonly secretMutations: Readonly<Record<string, string | null>>;
  readonly onReferencesChange: (references: readonly ExpertPluginReference[]) => void;
  readonly onSecretMutationsChange: (values: Readonly<Record<string, string | null>>) => void;
}) {
  const { t } = useTranslation("studio");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [resetCandidate, setResetCandidate] = useState<DesktopPlugin | null>(null);
  const selectedRefs = useMemo(
    () => new Set(props.references.map((reference) => reference.ref)),
    [props.references],
  );
  const activePlugins = props.references.flatMap((reference) => {
    const plugin = props.plugins.find((candidate) => candidate.ref === reference.ref);
    return plugin === undefined ? [] : [{ plugin, reference }];
  });
  const matchingCount = props.plugins.filter((plugin) => {
    const term = normalized(search);
    return (
      term.length === 0 ||
      [
        plugin.manifest.name,
        plugin.manifest.id,
        plugin.manifest.description,
        ...plugin.manifest.tags,
      ].some((value) => normalized(value).includes(term))
    );
  }).length;
  const visiblePlugins = matchingPlugins(props.plugins, search, selectedRefs);

  useEffect(() => {
    if (!pickerOpen && resetCandidate === null) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (resetCandidate !== null) setResetCandidate(null);
      else setPickerOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [pickerOpen, resetCandidate]);

  const closePicker = () => {
    setPickerOpen(false);
    setSearch("");
  };
  const clearSecretBindings = (references: readonly ExpertPluginReference[]) => {
    const bindings = references.flatMap((reference) =>
      Object.values(reference.secretBindings ?? {}),
    );
    if (bindings.length === 0) return;
    props.onSecretMutationsChange({
      ...props.secretMutations,
      ...Object.fromEntries(bindings.map((binding) => [binding, null] as const)),
    });
  };
  const toggle = (plugin: DesktopPlugin, enabled: boolean) => {
    const affected = props.references.filter(
      (reference) =>
        reference.ref === plugin.ref ||
        (enabled && reference.ref.startsWith(`plugin:${plugin.manifest.id}@`)),
    );
    clearSecretBindings(affected);
    props.onReferencesChange(
      enabled
        ? [
            ...props.references.filter(
              (reference) => !reference.ref.startsWith(`plugin:${plugin.manifest.id}@`),
            ),
            { ref: plugin.ref },
          ]
        : props.references.filter((reference) => reference.ref !== plugin.ref),
    );
  };
  const update = (ref: string, next: ExpertPluginReference) => {
    props.onReferencesChange(
      props.references.map((reference) => (reference.ref === ref ? next : reference)),
    );
  };
  const restoreDefaults = () => {
    if (resetCandidate === null) return;
    const reference = props.references.find((candidate) => candidate.ref === resetCandidate.ref);
    if (reference === undefined) return;
    const restored = restorePluginReferenceDefaults(reference, props.secretMutations);
    if (Object.keys(reference.secretBindings ?? {}).length > 0) {
      props.onSecretMutationsChange(restored.secretMutations);
    }
    update(reference.ref, restored.reference);
    setResetCandidate(null);
  };

  return (
    <>
      <section className="expert-plugin-picker" aria-labelledby="expert-plugins-heading">
        <header>
          <div>
            <h3 id="expert-plugins-heading">{t("plugins")}</h3>
            <p>{t("addInstalledExtensions")}</p>
          </div>
          <span>{t("activeCount", { count: props.references.length })}</span>
        </header>
        <div className="expert-plugin-toolbar">
          <span>{t("installedPluginSummary", { count: props.plugins.length })}</span>
          <button className="secondary-button" type="button" onClick={() => setPickerOpen(true)}>
            <PuzzlePiece size={16} aria-hidden="true" />
            {props.references.length > 0 ? t("editPlugins") : t("addPlugins")}
          </button>
        </div>
        <div className="expert-plugin-list">
          {activePlugins.map(({ plugin, reference }) => {
            const hasOverrides =
              Object.keys(reference.config ?? {}).length > 0 ||
              Object.keys(reference.secretBindings ?? {}).length > 0;
            return (
              <article key={plugin.ref} className="is-active">
                <header>
                  <span className="studio-asset-icon">
                    <PuzzlePiece size={19} aria-hidden="true" />
                  </span>
                  <div>
                    <strong>{plugin.manifest.name}</strong>
                    <small>{plugin.manifest.description}</small>
                  </div>
                  <span className="expert-plugin-active-label">{t("active")}</span>
                </header>
                <details>
                  <summary>{t("configureParameters")}</summary>
                  <div className="expert-plugin-config-heading">
                    <p>{t("overrideDefaults")}</p>
                    <button
                      type="button"
                      disabled={!hasOverrides}
                      onClick={() => setResetCandidate(plugin)}
                    >
                      <ArrowCounterClockwise size={15} aria-hidden="true" />{" "}
                      {t("restoreDefaultsAction")}
                    </button>
                  </div>
                  <PluginConfigFields
                    manifest={plugin.manifest}
                    values={reference.config ?? {}}
                    inherited={plugin.defaultConfig}
                    configuredSecrets={new Set(Object.keys(reference.secretBindings ?? {}))}
                    onValuesChange={(config) =>
                      update(plugin.ref, {
                        ...reference,
                        ...(Object.keys(config).length === 0 ? { config: undefined } : { config }),
                      })
                    }
                    onSecretChange={(path, value) => {
                      const currentBindings = { ...(reference.secretBindings ?? {}) };
                      const existing = currentBindings[path];
                      if (value === null) {
                        if (existing !== undefined) {
                          props.onSecretMutationsChange({
                            ...props.secretMutations,
                            [existing]: null,
                          });
                        }
                        delete currentBindings[path];
                      } else {
                        const binding = existing ?? `binding:plugin-secret-${crypto.randomUUID()}`;
                        currentBindings[path] = binding;
                        props.onSecretMutationsChange({
                          ...props.secretMutations,
                          [binding]: value,
                        });
                      }
                      update(plugin.ref, {
                        ...reference,
                        ...(Object.keys(currentBindings).length === 0
                          ? { secretBindings: undefined }
                          : { secretBindings: currentBindings }),
                      });
                    }}
                  />
                </details>
              </article>
            );
          })}
          {props.references.length === 0 ? (
            <div className="expert-plugin-empty">
              <span className="studio-asset-icon">
                <PuzzlePiece size={20} aria-hidden="true" />
              </span>
              <div>
                <strong>{t("noPluginsAdded")}</strong>
                <p>{t("noPluginsAddedDescription")}</p>
              </div>
            </div>
          ) : null}
          {props.references.length > activePlugins.length ? (
            <p className="capability-empty">
              {t("missingPluginReferences", {
                count: props.references.length - activePlugins.length,
              })}
            </p>
          ) : null}
        </div>
      </section>

      {pickerOpen ? (
        <div
          className="expert-picker-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePicker();
          }}
        >
          <aside
            className="expert-picker-dialog expert-plugin-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="plugin-library-heading"
          >
            <header className="expert-picker-heading">
              <div>
                <small>{t("extensions")}</small>
                <h2 id="plugin-library-heading">{t("pluginLibrary")}</h2>
                <p>{t("pluginLibraryDescription")}</p>
              </div>
              <button type="button" aria-label={t("closePluginLibrary")} onClick={closePicker}>
                <X size={19} aria-hidden="true" />
              </button>
            </header>
            <label className="expert-picker-search">
              <MagnifyingGlass size={18} aria-hidden="true" />
              <span className="sr-only">{t("searchInstalledPlugins")}</span>
              <input
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("searchPluginsDescription")}
              />
              {search ? (
                <button type="button" aria-label={t("clearSearch")} onClick={() => setSearch("")}>
                  <X size={16} aria-hidden="true" />
                </button>
              ) : null}
            </label>
            <div className="expert-picker-toolbar">
              <span>{t("selectedCount", { count: props.references.length })}</span>
              <span>
                {t("showingMatching", { visible: visiblePlugins.length, total: matchingCount })}
              </span>
            </div>
            <div className="expert-picker-results">
              {visiblePlugins.length > 0 ? (
                <div className="expert-picker-list">
                  {visiblePlugins.map((plugin) => {
                    const active = selectedRefs.has(plugin.ref);
                    const unavailable = plugin.status !== "ready" && !active;
                    return (
                      <label
                        className={`expert-picker-row${unavailable ? " is-disabled" : ""}`}
                        key={plugin.ref}
                      >
                        <input
                          type="checkbox"
                          checked={active}
                          disabled={unavailable}
                          onChange={(event) => toggle(plugin, event.target.checked)}
                        />
                        <span>
                          <strong>{plugin.manifest.name}</strong>
                          <small>
                            {plugin.manifest.description}
                            {unavailable ? ` · ${t("needsAttention")}` : ""}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="expert-picker-empty">
                  <strong>{search.trim() ? t("noMatchesFound") : t("noPluginsInstalled")}</strong>
                  <p>{search.trim() ? t("tryPluginSearch") : t("installPluginFirst")}</p>
                </div>
              )}
              {matchingCount > visiblePlugins.length ? (
                <p className="expert-plugin-result-hint">
                  {t("hiddenPlugins", { count: matchingCount - visiblePlugins.length })}
                </p>
              ) : null}
            </div>
            <footer className="expert-picker-actions">
              <span>{t("pluginConfigurable")}</span>
              <button className="primary-button" type="button" onClick={closePicker}>
                {t("common:actions.done")}
              </button>
            </footer>
          </aside>
        </div>
      ) : null}

      {resetCandidate !== null ? (
        <div className="capability-confirm-backdrop expert-plugin-reset-backdrop">
          <section
            className="capability-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="restore-plugin-defaults-title"
            aria-describedby="restore-plugin-defaults-description"
          >
            <h2 id="restore-plugin-defaults-title">{t("restoreDefaults")}</h2>
            <p id="restore-plugin-defaults-description">
              {t("restoreDefaultsDescription", { name: resetCandidate.manifest.name })}
            </p>
            <footer>
              <button
                className="secondary-button"
                type="button"
                autoFocus
                onClick={() => setResetCandidate(null)}
              >
                {t("cancel")}
              </button>
              <button className="primary-button" type="button" onClick={restoreDefaults}>
                <ArrowCounterClockwise size={16} aria-hidden="true" /> {t("restoreDefaultsAction")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
