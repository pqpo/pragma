import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { loadExpertAgentPlugins } from "../../src/plugins/plugin-loader.ts";

const execFileAsync = promisify(execFile);

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

  it("installs and loads copied plugin directory packages", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "expertmesh-plugin-loader-"));
    const repoRoot = resolve(workspace, "repo");
    const pluginDir = resolve(repoRoot, "plugins", "dependency-plugin");

    try {
      await writeWorkspaceDependencyPackage(repoRoot, "plugin-test-dep");
      await writeMinimalPlugin(pluginDir, {
        id: "plugin.dependency",
        requiredConfig: [],
        entryLines: [
          'import { dependencyValue } from "plugin-test-dep";',
          "export default {",
          '  id: "plugin.dependency",',
          '  name: "Dependency",',
          '  description: "Uses a development dependency",',
          "  manifest: {",
          '    schemaVersion: "expertmesh.plugin/v1",',
          '    id: "plugin.dependency",',
          '    name: "Dependency",',
          '    description: "Uses a development dependency",',
          '    runtime: { type: "expert-agent-plugin", entry: "./index.js" },',
          "    capabilities: [],",
          "    required_config: [],",
          "  },",
          "  setup: () => ({",
          "    models: {",
          "      defaultModelName: dependencyValue,",
          "      providers: [],",
          "    },",
          "  }),",
          "};",
        ],
      });
      await writePackageJson(pluginDir, {
        name: "plugin.dependency",
        version: "0.0.0",
        type: "module",
        dependencies: {
          "plugin-test-dep": "workspace:*",
        },
      });

      const result = await loadExpertAgentPlugins({
        workspaceRoot: workspace,
        sources: [pluginDir],
      });

      expect(result.issues).toEqual([]);
      expect(result.pluginEntries[0]?.entry.setup({} as never).models?.defaultModelName).toBe(
        "from-installed-dependency",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("installs and loads zipped plugin packages", async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), "expertmesh-plugin-loader-"));
    const packageRoot = resolve(workspace, "package-root");
    const dependencyDir = resolve(workspace, "plugin-test-dep");
    const archivePath = resolve(workspace, "archive-plugin.zip");

    try {
      await writeFileDependencyPackage(dependencyDir, "plugin-test-dep");
      await writeMinimalPlugin(packageRoot, {
        id: "plugin.archive",
        requiredConfig: [],
        entryLines: [
          'import { dependencyValue } from "plugin-test-dep";',
          "export default {",
          '  id: "plugin.archive",',
          '  name: "Archive",',
          '  description: "Uses an installed dependency",',
          "  manifest: {",
          '    schemaVersion: "expertmesh.plugin/v1",',
          '    id: "plugin.archive",',
          '    name: "Archive",',
          '    description: "Uses an installed dependency",',
          '    runtime: { type: "expert-agent-plugin", entry: "./index.js" },',
          "    capabilities: [],",
          "    required_config: [],",
          "  },",
          "  setup: () => ({",
          "    models: {",
          "      defaultModelName: dependencyValue,",
          "      providers: [],",
          "    },",
          "  }),",
          "};",
        ],
      });
      await writePackageJson(packageRoot, {
        name: "plugin.archive",
        version: "0.0.0",
        type: "module",
        dependencies: {
          "plugin-test-dep": `file:${dependencyDir}`,
        },
      });
      await execFileAsync("zip", ["-qr", archivePath, "."], { cwd: packageRoot });

      const result = await loadExpertAgentPlugins({
        workspaceRoot: workspace,
        sources: [archivePath],
      });

      expect(result.issues).toEqual([]);
      expect(result.pluginEntries[0]?.entry.setup({} as never).models?.defaultModelName).toBe(
        "from-installed-dependency",
      );
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
    readonly entryLines?: readonly string[] | undefined;
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
      (options.entryLines ?? [
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
      ]).join("\n"),
      "utf8",
    );
  }
}

async function writeWorkspaceDependencyPackage(workspace: string, name: string): Promise<void> {
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  await writeFileDependencyPackage(resolve(workspace, "packages", name), name);
}

async function writeFileDependencyPackage(dependencyDir: string, name: string): Promise<void> {
  await mkdir(dependencyDir, { recursive: true });
  await writePackageJson(dependencyDir, {
    name,
    version: "0.0.0",
    type: "module",
    exports: "./index.js",
  });
  await writeFile(
    resolve(dependencyDir, "index.js"),
    'export const dependencyValue = "from-installed-dependency";\n',
    "utf8",
  );
}

async function writePackageJson(dir: string, packageJson: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}
