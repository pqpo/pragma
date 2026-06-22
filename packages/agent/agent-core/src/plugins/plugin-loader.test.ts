import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadExpertAgentPlugins } from "./plugin-loader.ts";

describe("ExpertAgent plugin loader", () => {
  it("loads a plugin directory into the Agent workspace", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "expertmesh-plugin-loader-"));
    const pluginDir = resolve(workspace, "loadable-plugin");

    try {
      await writeMinimalPlugin(pluginDir, {
        id: "plugin.loadable",
        requiredEnv: [],
      });

      const result = await loadExpertAgentPlugins({
        workspaceRoot: workspace,
        sources: [pluginDir],
      });

      expect(result.issues).toEqual([]);
      expect(result.pluginEntries.map((plugin) => plugin.id)).toEqual(["plugin.loadable"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("skips plugins with missing required environment variables", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "expertmesh-plugin-loader-"));
    const pluginDir = resolve(workspace, "env-plugin");

    try {
      await writeMinimalPlugin(pluginDir, {
        id: "plugin.env-required",
        requiredEnv: ["EXPERTMESH_PLUGIN_ENV_REQUIRED_TOKEN"],
      });

      const result = await loadExpertAgentPlugins({
        workspaceRoot: workspace,
        sources: [pluginDir],
        env: {},
      });

      expect(result.pluginEntries).toEqual([]);
      expect(result.issues).toMatchObject([
        {
          code: "missing_env",
          pluginId: "plugin.env-required",
          missingEnv: ["EXPERTMESH_PLUGIN_ENV_REQUIRED_TOKEN"],
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
    readonly requiredEnv: readonly string[];
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
        requires_env: options.requiredEnv.map((name) => ({
          name,
          secret: true,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );

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
      "    requires_env: [],",
      "  },",
      "  setup: () => ({}),",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
}
