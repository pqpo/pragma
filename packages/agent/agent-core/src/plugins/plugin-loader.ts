import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type {
  ExpertAgentPluginEntry,
  ExpertAgentPluginManifest,
} from "./expert-agent-plugin.ts";
import { readExpertAgentPluginManifest } from "./expert-agent-plugin.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_PLUGIN_INSTALL_DIR = ".expertmesh/agent/plugins";

export type ExpertAgentPluginSource = string;

export interface LoadExpertAgentPluginsOptions {
  readonly workspaceRoot: string;
  readonly sources: readonly ExpertAgentPluginSource[];
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly installDir?: string | undefined;
}

export interface ExpertAgentPluginLoadIssue {
  readonly source: string;
  readonly code:
    | "missing_env"
    | "invalid_source"
    | "missing_manifest"
    | "missing_entry"
    | "load_error";
  readonly message: string;
  readonly pluginId?: string | undefined;
  readonly missingEnv?: readonly string[] | undefined;
}

export interface LoadExpertAgentPluginsResult {
  readonly pluginEntries: readonly ExpertAgentPluginEntry[];
  readonly issues: readonly ExpertAgentPluginLoadIssue[];
}

export interface ExpertAgentPluginModule {
  readonly default?: ExpertAgentPluginEntry | undefined;
}

export async function loadExpertAgentPlugins(
  options: LoadExpertAgentPluginsOptions,
): Promise<LoadExpertAgentPluginsResult> {
  const pluginEntries: ExpertAgentPluginEntry[] = [];
  const issues: ExpertAgentPluginLoadIssue[] = [];

  for (const source of options.sources) {
    try {
      const pluginDir = await prepareExpertAgentPluginSource(source, options);
      const manifest = readExpertAgentPluginManifest(resolve(pluginDir, "plugin.json"));
      const missingEnv = findMissingRequiredEnv(manifest, options.env ?? process.env);

      if (missingEnv.length > 0) {
        issues.push({
          source,
          code: "missing_env",
          message: `Plugin ${manifest.id} requires missing environment variables: ${missingEnv.join(", ")}`,
          pluginId: manifest.id,
          missingEnv,
        });
        continue;
      }

      pluginEntries.push(await importExpertAgentPlugin(pluginDir));
    } catch (error) {
      issues.push({
        source,
        code: readPluginLoadIssueCode(error),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { pluginEntries, issues };
}

export async function prepareExpertAgentPluginSource(
  sourcePath: string,
  options: Pick<LoadExpertAgentPluginsOptions, "workspaceRoot" | "installDir">,
): Promise<string> {
  const absoluteSourcePath = isAbsolute(sourcePath) ? sourcePath : resolve(sourcePath);
  const sourceStats = await stat(absoluteSourcePath).catch(() => undefined);

  if (sourceStats === undefined) {
    throw new InvalidPluginSourceError(`Plugin source does not exist: ${sourcePath}`);
  }

  const installRoot = resolve(
    options.workspaceRoot,
    options.installDir ?? DEFAULT_PLUGIN_INSTALL_DIR,
  );
  await mkdir(installRoot, { recursive: true });

  if (sourceStats.isDirectory()) {
    await assertPluginManifestExists(absoluteSourcePath);
    const manifest = readExpertAgentPluginManifest(resolve(absoluteSourcePath, "plugin.json"));
    const targetDir = resolve(installRoot, manifest.id);
    await rm(targetDir, { recursive: true, force: true });
    await cp(absoluteSourcePath, targetDir, {
      recursive: true,
      filter: (source) => !source.includes("/node_modules/") && !source.includes("/.turbo/"),
    });
    return targetDir;
  }

  if (sourceStats.isFile() && extname(absoluteSourcePath) === ".zip") {
    const tempDir = await mkdtemp(resolve(tmpdir(), "expertmesh-plugin-"));

    try {
      await execFileAsync("unzip", ["-q", absoluteSourcePath, "-d", tempDir], {
        maxBuffer: 1024 * 1024 * 10,
      });
      const unpackedDir = await findUnpackedPluginRoot(tempDir);
      const manifest = readExpertAgentPluginManifest(resolve(unpackedDir, "plugin.json"));
      const targetDir = resolve(installRoot, manifest.id);
      await rm(targetDir, { recursive: true, force: true });
      await cp(unpackedDir, targetDir, { recursive: true });
      return targetDir;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  throw new InvalidPluginSourceError(`Plugin source must be a directory or .zip file: ${sourcePath}`);
}

async function importExpertAgentPlugin(pluginDir: string): Promise<ExpertAgentPluginEntry> {
  const manifest = readExpertAgentPluginManifest(resolve(pluginDir, "plugin.json"));
  const entryPath = resolve(pluginDir, manifest.runtime.entry);

  const entryStats = await stat(entryPath).catch(() => undefined);

  if (entryStats?.isFile() !== true) {
    throw new PluginLoadError(
      "missing_entry",
      `Plugin ${manifest.id} entry file does not exist: ${manifest.runtime.entry}`,
    );
  }

  const module = (await import(pathToFileURL(entryPath).href)) as ExpertAgentPluginModule;
  const plugin = module.default;

  if (plugin === undefined) {
    throw new Error(`Plugin ${manifest.id} must default export definePluginEntry(...).`);
  }

  if (plugin.manifest.id !== manifest.id) {
    throw new Error(`Plugin export id ${plugin.manifest.id} does not match manifest id ${manifest.id}.`);
  }

  return plugin;
}

async function assertPluginManifestExists(pluginDir: string): Promise<void> {
  const manifestPath = resolve(pluginDir, "plugin.json");
  const manifestStats = await stat(manifestPath).catch(() => undefined);

  if (manifestStats?.isFile() !== true) {
    throw new PluginLoadError("missing_manifest", `Plugin manifest does not exist: ${manifestPath}`);
  }
}

function findMissingRequiredEnv(
  manifest: ExpertAgentPluginManifest,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  return manifest.requires_env.flatMap((item) => {
    if (item.required === false) {
      return [];
    }

    const value = env[item.name];
    return value === undefined || value.length === 0 ? [item.name] : [];
  });
}

async function findUnpackedPluginRoot(tempDir: string): Promise<string> {
  const directManifest = resolve(tempDir, "plugin.json");
  const directStats = await stat(directManifest).catch(() => undefined);

  if (directStats?.isFile() === true) {
    return tempDir;
  }

  const name = basename(tempDir);
  const candidates = await import("node:fs/promises").then((fs) => fs.readdir(tempDir));

  for (const candidate of candidates) {
    const path = resolve(tempDir, candidate);
    const manifestStats = await stat(resolve(path, "plugin.json")).catch(() => undefined);

    if (manifestStats?.isFile() === true) {
      return path;
    }
  }

  throw new PluginLoadError("missing_manifest", `Zip ${name} does not contain a plugin.json at its root.`);
}

class InvalidPluginSourceError extends Error {}

class PluginLoadError extends Error {
  constructor(
    readonly code: ExpertAgentPluginLoadIssue["code"],
    message: string,
  ) {
    super(message);
  }
}

function readPluginLoadIssueCode(error: unknown): ExpertAgentPluginLoadIssue["code"] {
  if (error instanceof PluginLoadError) {
    return error.code;
  }

  if (error instanceof InvalidPluginSourceError) {
    return "invalid_source";
  }

  return "load_error";
}
