import { PuzzlePiece } from "@phosphor-icons/react";

import type { DesktopPlugin, ExpertPluginReference } from "../../../../shared/desktop-api.ts";
import { PluginConfigFields } from "./PluginConfigFields.tsx";

export function ExpertPluginPicker(props: {
  readonly plugins: readonly DesktopPlugin[];
  readonly references: readonly ExpertPluginReference[];
  readonly secretMutations: Readonly<Record<string, string | null>>;
  readonly onReferencesChange: (references: readonly ExpertPluginReference[]) => void;
  readonly onSecretMutationsChange: (values: Readonly<Record<string, string | null>>) => void;
}) {
  const toggle = (plugin: DesktopPlugin, enabled: boolean) => {
    const affected = props.references.filter(
      (reference) =>
        reference.ref === plugin.ref ||
        (enabled && reference.ref.startsWith(`plugin:${plugin.manifest.id}@`)),
    );
    const bindings = affected.flatMap((reference) => Object.values(reference.secretBindings ?? {}));
    if (bindings.length > 0) {
      props.onSecretMutationsChange({
        ...props.secretMutations,
        ...Object.fromEntries(bindings.map((binding) => [binding, null] as const)),
      });
    }
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

  return (
    <section className="expert-plugin-picker">
      <header>
        <div>
          <h3>Plugins</h3>
          <p>Activate installed extensions and override their Desktop defaults for this expert.</p>
        </div>
        <span>{props.references.length} active</span>
      </header>
      <div className="expert-plugin-list">
        {props.plugins.map((plugin) => {
          const reference = props.references.find((candidate) => candidate.ref === plugin.ref);
          const active = reference !== undefined;
          return (
            <article key={plugin.ref} className={active ? "is-active" : ""}>
              <header>
                <span className="studio-asset-icon">
                  <PuzzlePiece size={19} />
                </span>
                <div>
                  <strong>{plugin.manifest.name}</strong>
                  <small>{plugin.manifest.description}</small>
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={active}
                    disabled={plugin.status !== "ready"}
                    onChange={(event) => toggle(plugin, event.target.checked)}
                  />
                  {active ? "Active" : "Activate"}
                </label>
              </header>
              {active ? (
                <details>
                  <summary>Configure expert overrides</summary>
                  <PluginConfigFields
                    manifest={plugin.manifest}
                    values={reference.config ?? {}}
                    inherited={plugin.defaultConfig}
                    configuredSecrets={new Set(Object.keys(reference.secretBindings ?? {}))}
                    allowInherit
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
              ) : null}
            </article>
          );
        })}
        {props.plugins.length === 0 ? (
          <p className="capability-empty">
            Install a plugin from the Studio plugin directory first.
          </p>
        ) : null}
      </div>
    </section>
  );
}
