import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DesktopPlugin } from "../../../../shared/contracts/index.ts";
import {
  ExpertPluginPicker,
  matchingPlugins,
  restorePluginReferenceDefaults,
} from "./ExpertPluginPicker.tsx";
import { PluginConfigFields } from "./PluginConfigFields.tsx";

function plugin(index: number): DesktopPlugin {
  const id = `plugin-${index}`;
  return {
    ref: `plugin:${id}@1.0.0`,
    origin: "user",
    manifest: {
      schemaVersion: "pragma.plugin/v2",
      id,
      name: `Plugin ${String(index).padStart(3, "0")}`,
      description: `Description for plugin ${index}`,
      version: "1.0.0",
      tags: index === 99 ? ["needle"] : [],
      runtime: {
        type: "expert-agent-plugin",
        entry: "./index.js",
        trust: "trusted-host",
      },
      capabilities: [],
      configuration: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            description: "Execution mode",
            default: "safe",
          },
        },
      },
      permissions: { filesystem: [], shell: [], network: [], environment: [] },
    },
    contentHash: "a".repeat(64),
    status: "ready",
    defaultConfig: { mode: "desktop" },
    configuredSecrets: [],
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
}

describe("ExpertPluginPicker", () => {
  it("keeps a large installed collection off the expert form", () => {
    const plugins = Array.from({ length: 100 }, (_, index) => plugin(index));
    const html = renderToStaticMarkup(
      <ExpertPluginPicker
        plugins={plugins}
        references={[{ ref: plugins[99]!.ref }]}
        secretMutations={{}}
        onReferencesChange={() => undefined}
        onSecretMutationsChange={() => undefined}
      />,
    );

    expect(html).toContain("100 installed");
    expect(html).toContain("Plugin 099");
    expect(html).not.toContain("Plugin 000");
    expect(html).not.toContain('role="dialog"');
  });

  it("limits default results and searches names, descriptions, ids, and tags", () => {
    const plugins = Array.from({ length: 100 }, (_, index) => plugin(index));

    expect(matchingPlugins(plugins, "", new Set())).toHaveLength(8);
    expect(matchingPlugins(plugins, "needle", new Set()).map((item) => item.manifest.id)).toEqual([
      "plugin-99",
    ]);
    expect(
      matchingPlugins(plugins, "description for plugin 42", new Set()).map(
        (item) => item.manifest.id,
      ),
    ).toEqual(["plugin-42"]);
  });

  it("restores every parameter and secret override in one operation", () => {
    expect(
      restorePluginReferenceDefaults(
        {
          ref: "plugin:memory@1.0.0",
          config: { mode: "custom", nested: { limit: 7 } },
          secretBindings: {
            token: "binding:plugin-token",
            password: "binding:plugin-password",
          },
        },
        { "binding:existing": "keep" },
      ),
    ).toEqual({
      reference: { ref: "plugin:memory@1.0.0" },
      secretMutations: {
        "binding:existing": "keep",
        "binding:plugin-token": null,
        "binding:plugin-password": null,
      },
    });
  });
});

describe("PluginConfigFields", () => {
  it("allows direct editing without per-field inherit controls", () => {
    const item = plugin(1);
    const html = renderToStaticMarkup(
      <PluginConfigFields
        manifest={item.manifest}
        values={{}}
        inherited={item.defaultConfig}
        configuredSecrets={new Set()}
        onValuesChange={() => undefined}
        onSecretChange={() => undefined}
      />,
    );

    expect(html).toContain('value="desktop"');
    expect(html).not.toContain("Inherit default");
    expect(html).not.toContain("disabled");
  });
});
