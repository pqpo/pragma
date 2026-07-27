import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DesktopPlugin } from "../../../../shared/contracts/index.ts";
import { PluginDetailFragment, PluginDirectoryFragment } from "./PluginDirectoryFragment.tsx";

const plugin: DesktopPlugin = {
  ref: "plugin:memory@1.2.3",
  origin: "built_in",
  manifest: {
    schemaVersion: "pragma.plugin/v2",
    id: "memory",
    name: "Memory",
    description: "Registers task memory tools.",
    version: "1.2.3",
    tags: [],
    runtime: {
      type: "expert-agent-plugin",
      entry: "./index.js",
      trust: "trusted-host",
    },
    capabilities: [],
    configuration: { type: "object", properties: {} },
    permissions: { filesystem: [], shell: [], network: [], environment: [] },
  },
  contentHash: "a".repeat(64),
  status: "ready",
  defaultConfig: {},
  configuredSecrets: [],
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

describe("PluginDirectoryFragment", () => {
  it("shows the version without repeating the plugin ID in its metadata column", () => {
    const html = renderToStaticMarkup(
      <PluginDirectoryFragment
        plugins={[plugin]}
        onOpen={() => undefined}
        onChanged={() => undefined}
      />,
    );

    expect(html).toContain("Version");
    expect(html).toContain("1.2.3");
    expect(html).not.toContain("Version / ID");
    expect(html).not.toContain("<small>memory</small>");
    expect(html).not.toContain(">Open<");
  });

  it("groups permissions and capabilities into one structured declarations module", () => {
    const detailedPlugin: DesktopPlugin = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        permissions: {
          filesystem: ["workspace:read", "workspace:write"],
          shell: ["git"],
          network: ["configured git remotes"],
          environment: ["git session variables"],
        },
        capabilities: [
          {
            type: "context",
            name: "code-repositories.md",
            description: "Exposes configured repository metadata.",
          },
          {
            type: "hook",
            name: "beforeSessionCreate",
            description: "Prepares session-level Git authentication.",
          },
        ],
      },
    };

    const html = renderToStaticMarkup(
      <PluginDetailFragment
        plugin={detailedPlugin}
        onBack={() => undefined}
        onChanged={() => undefined}
        onDeleted={() => undefined}
      />,
    );

    expect(html.match(/plugin-declarations/g)).toHaveLength(2);
    expect(html).toContain("Plugin declarations");
    expect(html).toContain("Declared permissions");
    expect(html).toContain("Contributed capabilities");
    expect(html).toContain("5 items");
    expect(html).toContain("code-repositories.md");
    expect(html).toContain("beforeSessionCreate");
    expect(html).not.toContain("Delete plugin");
  });

  it("offers deletion for an imported plugin", () => {
    const html = renderToStaticMarkup(
      <PluginDetailFragment
        plugin={{ ...plugin, origin: "user" }}
        onBack={() => undefined}
        onChanged={() => undefined}
        onDeleted={() => undefined}
      />,
    );

    expect(html).toContain("Delete plugin");
  });
});
