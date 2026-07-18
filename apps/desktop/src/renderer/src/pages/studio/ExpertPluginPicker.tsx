import { ArrowCounterClockwise, MagnifyingGlass, PuzzlePiece, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";

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
            <h3 id="expert-plugins-heading">Plugins</h3>
            <p>Add installed extensions, then configure only the ones this expert uses.</p>
          </div>
          <span>{props.references.length} active</span>
        </header>
        <div className="expert-plugin-toolbar">
          <span>
            {props.plugins.length} installed · Search the library instead of browsing a long list.
          </span>
          <button className="secondary-button" type="button" onClick={() => setPickerOpen(true)}>
            <PuzzlePiece size={16} aria-hidden="true" />
            {props.references.length > 0 ? "Edit plugins" : "Add plugins"}
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
                  <span className="expert-plugin-active-label">Active</span>
                </header>
                <details>
                  <summary>Configure expert parameters</summary>
                  <div className="expert-plugin-config-heading">
                    <p>Values changed here override this plugin’s Desktop defaults.</p>
                    <button
                      type="button"
                      disabled={!hasOverrides}
                      onClick={() => setResetCandidate(plugin)}
                    >
                      <ArrowCounterClockwise size={15} aria-hidden="true" /> Restore defaults
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
                <strong>No plugins added</strong>
                <p>Search installed plugins and add only what this expert needs.</p>
              </div>
            </div>
          ) : null}
          {props.references.length > activePlugins.length ? (
            <p className="capability-empty">
              {props.references.length - activePlugins.length} selected plugin reference(s) are no
              longer installed.
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
                <small>Extensions</small>
                <h2 id="plugin-library-heading">Plugin library</h2>
                <p>Search installed plugins and choose the extensions this expert can use.</p>
              </div>
              <button type="button" aria-label="Close plugin library" onClick={closePicker}>
                <X size={19} aria-hidden="true" />
              </button>
            </header>
            <label className="expert-picker-search">
              <MagnifyingGlass size={18} aria-hidden="true" />
              <span className="sr-only">Search installed plugins</span>
              <input
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search plugins by name, ID, or description"
              />
              {search ? (
                <button type="button" aria-label="Clear search" onClick={() => setSearch("")}>
                  <X size={16} aria-hidden="true" />
                </button>
              ) : null}
            </label>
            <div className="expert-picker-toolbar">
              <span>{props.references.length} selected</span>
              <span>
                Showing {visiblePlugins.length} of {matchingCount} matching
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
                            {unavailable ? " · Needs attention" : ""}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="expert-picker-empty">
                  <strong>{search.trim() ? "No matches found" : "No plugins installed"}</strong>
                  <p>
                    {search.trim()
                      ? "Try a different name, ID, description, or tag."
                      : "Install a plugin from the Studio plugin directory first."}
                  </p>
                </div>
              )}
              {matchingCount > visiblePlugins.length ? (
                <p className="expert-plugin-result-hint">
                  {matchingCount - visiblePlugins.length} more plugin(s) hidden. Refine your search
                  to find them.
                </p>
              ) : null}
            </div>
            <footer className="expert-picker-actions">
              <span>Plugin parameters remain configurable after you add them.</span>
              <button className="primary-button" type="button" onClick={closePicker}>
                Done
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
            <h2 id="restore-plugin-defaults-title">Restore all plugin defaults?</h2>
            <p id="restore-plugin-defaults-description">
              This will overwrite every custom parameter and secret for “
              {resetCandidate.manifest.name}”. The expert will use the plugin’s Desktop defaults
              instead.
            </p>
            <footer>
              <button
                className="secondary-button"
                type="button"
                autoFocus
                onClick={() => setResetCandidate(null)}
              >
                Cancel
              </button>
              <button className="primary-button" type="button" onClick={restoreDefaults}>
                <ArrowCounterClockwise size={16} aria-hidden="true" /> Restore defaults
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
