import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadExpertAgentPlugins } from "../../src/plugins/plugin-loader.ts";

describe("ExpertAgent plugin loader", () => {
  it("loads a plugin directory into the Agent workspace", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "expertmesh-plugin-loader-"));
    const pluginDir = resolve(workspace, "loadable-plugin");

    try {
      await writeMinimalPlugin(pluginDir, {
        id: "plugin.loadable",
        requiredConfig: [],
      });

      const result = await loadExpertAgentPlugins({
        workspaceRoot: workspace,
        sources: [pluginDir],
      });

      expect(result.issues).toEqual([]);
      expect(result.pluginEntries.map((plugin) => plugin.entry.id)).toEqual(["plugin.loadable"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps source plugin config with the loaded plugin registration", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "expertmesh-plugin-loader-"));
    const pluginDir = resolve(workspace, "configured-plugin");

    try {
      await writeMinimalPlugin(pluginDir, {
        id: "plugin.configured",
        requiredConfig: [],
      });

      const result = await loadExpertAgentPlugins({
        workspaceRoot: workspace,
        sources: [
          {
            source: pluginDir,
            config: {
              enabled: false,
            },
          },
        ],
      });

      expect(result.issues).toEqual([]);
      expect(result.pluginEntries).toMatchObject([
        {
          entry: {
            id: "plugin.configured",
          },
          config: {
            enabled: false,
          },
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports plugins without plugin.json", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "expertmesh-plugin-loader-"));
    const pluginDir = resolve(workspace, "missing-manifest-plugin");

    try {
      await mkdir(pluginDir, { recursive: true });

      const result = await loadExpertAgentPlugins({
        workspaceRoot: workspace,
        sources: [pluginDir],
      });

      expect(result.pluginEntries).toEqual([]);
      expect(result.issues).toMatchObject([
        {
          code: "missing_manifest",
          source: pluginDir,
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports plugins without a compiled entry file", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "expertmesh-plugin-loader-"));
    const pluginDir = resolve(workspace, "missing-entry-plugin");

    try {
      await writeMinimalPlugin(pluginDir, {
        id: "plugin.missing-entry",
        requiredConfig: [],
        writeEntry: false,
      });

      const result = await loadExpertAgentPlugins({
        workspaceRoot: workspace,
        sources: [pluginDir],
      });

      expect(result.pluginEntries).toEqual([]);
      expect(result.issues).toMatchObject([
        {
          code: "missing_entry",
          source: pluginDir,
        },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

async function writeMinimalPlugin(
  pluginDir: string,
  options: {
    readonly id: string;
    readonly requiredConfig: readonly string[];
    readonly writeEntry?: boolean | undefined;
  },
): Promise<void> {
  await mkdir(pluginDir, { recursive: true });

  await writeFile(
    resolve(pluginDir, "plugin.json"),
    JSON.stringify(
      {
        schemaVersion: "expertmesh.plugin/v1",
        id: options.id,
        name: "Env required",
        description: "Requires env",
        runtime: {
          type: "expert-agent-plugin",
          entry: "./index.js",
        },
        required_config: options.requiredConfig.map((name) => ({
          name,
          secret: true,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );

  if (options.writeEntry !== false) {
    await writeFile(
      resolve(pluginDir, "index.js"),
      [
        "export default {",
        `  id: "${options.id}",`,
        "  name: \"Env required\",",
        "  description: \"Requires env\",",
        "  manifest: {",
        "    schemaVersion: \"expertmesh.plugin/v1\",",
        `    id: "${options.id}",`,
        "    name: \"Env required\",",
        "    description: \"Requires env\",",
        "    runtime: { type: \"expert-agent-plugin\", entry: \"./index.js\" },",
        "    capabilities: [],",
        "    required_config: [],",
        "  },",
        "  setup: () => ({}),",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
  }
}
