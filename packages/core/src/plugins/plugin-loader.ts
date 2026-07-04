import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type {
  ExpertAgentPluginEntry,
  ExpertAgentPluginRegistration,
} from "./expert-agent-plugin.ts";
import { readExpertAgentPluginManifest } from "./expert-agent-plugin.ts";
import type { ExpertAgentLoggerProvider } from "../logging/logger.ts";
import { createExpertAgentLogger, defaultExpertAgentLoggerProvider } from "../logging/logger.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_PLUGIN_INSTALL_DIR = ".pragma/agent/plugins";

export type ExpertAgentPluginSource =
  | string
  | {
      readonly source: string;
      readonly config?: unknown | undefined;
    };

export type ExpertAgentPluginUse =
  | ExpertAgentPluginSource
  | {
      readonly entry: ExpertAgentPluginEntry;
      readonly config?: unknown | undefined;
    };

export interface LoadExpertAgentPluginsOptions {
  readonly workspaceRoot: string;
  readonly sources: readonly ExpertAgentPluginSource[];
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly installDir?: string | undefined;
  readonly loggerProvider?: ExpertAgentLoggerProvider | undefined;
}

export interface ExpertAgentPluginLoadIssue {
  readonly source: string;
  readonly code:
    | "missing_config"
    | "invalid_source"
    | "missing_manifest"
    | "missing_entry"
    | "install_error"
    | "load_error";
  readonly message: string;
  readonly pluginId?: string | undefined;
  readonly missingConfig?: readonly string[] | undefined;
}

export interface LoadExpertAgentPluginsResult {
  readonly pluginEntries: readonly ExpertAgentPluginRegistration[];
  readonly issues: readonly ExpertAgentPluginLoadIssue[];
}

export interface ExpertAgentPluginModule {
  readonly default?: ExpertAgentPluginEntry | undefined;
}

export async function loadExpertAgentPlugins(
  options: LoadExpertAgentPluginsOptions,
): Promise<LoadExpertAgentPluginsResult> {
  const pluginEntries: ExpertAgentPluginRegistration[] = [];
  const issues: ExpertAgentPluginLoadIssue[] = [];
  const loggerProvider = options.loggerProvider ?? defaultExpertAgentLoggerProvider;
  const logger = createExpertAgentLogger(loggerProvider, {
    component: "plugin",
    name: "plugin-loader",
  });

  for (const source of options.sources) {
    const sourcePath = readPluginSourcePath(source);
    const config = readPluginSourceConfig(source);

    try {
      const pluginDir = await prepareExpertAgentPluginSource(sourcePath, options);

      pluginEntries.push({
        entry: await importExpertAgentPlugin(pluginDir),
        ...(config === undefined ? {} : { config }),
      });
    } catch (error) {
      const issue: ExpertAgentPluginLoadIssue = {
        source: sourcePath,
        code: readPluginLoadIssueCode(error),
        message: error instanceof Error ? error.message : String(error),
      };
      issues.push(issue);
      logger.warn("Failed to load ExpertAgent plugin", {
        ...issue,
        error,
      });
    }
  }

  return { pluginEntries, issues };
}

export function isExpertAgentPluginEntryUse(
  plugin: ExpertAgentPluginUse,
): plugin is { readonly entry: ExpertAgentPluginEntry; readonly config?: unknown | undefined } {
  return typeof plugin === "object" && "entry" in plugin;
}

function readPluginSourcePath(source: ExpertAgentPluginSource): string {
  return typeof source === "string" ? source : source.source;
}

function readPluginSourceConfig(source: ExpertAgentPluginSource): unknown | undefined {
  return typeof source === "string" ? undefined : source.config;
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
    await assertPluginPackageJsonExists(absoluteSourcePath);

    const manifest = readExpertAgentPluginManifest(resolve(absoluteSourcePath, "plugin.json"));
    const targetDir = resolve(installRoot, manifest.id);
    await rm(targetDir, { recursive: true, force: true });
    await cp(absoluteSourcePath, targetDir, {
      recursive: true,
      filter: shouldCopyPluginPackageFile,
    });
    await installExpertAgentPluginPackage(targetDir, { sourceDir: absoluteSourcePath });
    return targetDir;
  }

  if (sourceStats.isFile() && extname(absoluteSourcePath) === ".zip") {
    const tempDir = await mkdtemp(resolve(tmpdir(), "pragma-plugin-"));

    try {
      await execFileAsync("unzip", ["-q", absoluteSourcePath, "-d", tempDir], {
        maxBuffer: 1024 * 1024 * 10,
      });
      const unpackedDir = await findUnpackedPluginRoot(tempDir);
      const manifest = readExpertAgentPluginManifest(resolve(unpackedDir, "plugin.json"));
      const targetDir = resolve(installRoot, manifest.id);
      await rm(targetDir, { recursive: true, force: true });
      await cp(unpackedDir, targetDir, {
        recursive: true,
        filter: shouldCopyPluginPackageFile,
      });
      await installExpertAgentPluginPackage(targetDir, { sourceDir: unpackedDir });
      return targetDir;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  throw new InvalidPluginSourceError(
    `Plugin source must be a directory or .zip file: ${sourcePath}`,
  );
}

function shouldCopyPluginPackageFile(source: string): boolean {
  return !pathContainsSegment(source, "node_modules") && !pathContainsSegment(source, ".turbo");
}

function pathContainsSegment(path: string, segment: string): boolean {
  return path.split("/").includes(segment);
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
    throw new Error(
      `Plugin export id ${plugin.manifest.id} does not match manifest id ${manifest.id}.`,
    );
  }

  return plugin;
}

async function assertPluginManifestExists(pluginDir: string): Promise<void> {
  const manifestPath = resolve(pluginDir, "plugin.json");
  const manifestStats = await stat(manifestPath).catch(() => undefined);

  if (manifestStats?.isFile() !== true) {
    throw new PluginLoadError(
      "missing_manifest",
      `Plugin manifest does not exist: ${manifestPath}`,
    );
  }
}

async function assertPluginPackageJsonExists(pluginDir: string): Promise<void> {
  const packageJsonPath = resolve(pluginDir, "package.json");
  const packageJsonStats = await stat(packageJsonPath).catch(() => undefined);

  if (packageJsonStats?.isFile() !== true) {
    throw new PluginLoadError(
      "invalid_source",
      `Plugin package.json does not exist: ${packageJsonPath}`,
    );
  }
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

  throw new PluginLoadError(
    "missing_manifest",
    `Zip ${name} does not contain a plugin.json at its root.`,
  );
}

async function installExpertAgentPluginPackage(
  pluginDir: string,
  options: { readonly sourceDir: string },
): Promise<void> {
  const packageJsonPath = resolve(pluginDir, "package.json");
  const packageJson = await readPackageJson(packageJsonPath);

  if (packageJson === undefined) {
    return;
  }

  await rm(resolve(pluginDir, "node_modules"), { recursive: true, force: true });
  await rewriteWorkspaceDependencies(packageJsonPath, packageJson, options.sourceDir);
  await runPluginPackageCommand(pluginDir, "install", [
    "install",
    "--ignore-workspace",
    "--no-frozen-lockfile",
  ]);

  if (hasPackageScript(packageJson, "build")) {
    await runPluginPackageCommand(pluginDir, "build", ["run", "build"]);
  }
}

async function rewriteWorkspaceDependencies(
  packageJsonPath: string,
  packageJson: PackageJson,
  sourceDir: string,
): Promise<void> {
  const workspaceRoot = await findNearestFile(sourceDir, "pnpm-workspace.yaml");
  const workspacePackages =
    workspaceRoot === undefined
      ? new Map<string, string>()
      : await readWorkspacePackageDirectories(dirname(workspaceRoot));
  let changed = false;

  for (const field of dependencyFields) {
    const dependencies = readRecord(packageJson[field]);

    if (dependencies === undefined) {
      continue;
    }

    for (const [name, version] of Object.entries(dependencies)) {
      if (!version.startsWith("workspace:")) {
        continue;
      }

      const workspacePackageDir = workspacePackages.get(name);

      if (workspacePackageDir === undefined) {
        throw new PluginLoadError(
          "install_error",
          `Plugin package ${packageJsonPath} uses workspace dependency ${name} but no source workspace package was found.`,
        );
      }

      dependencies[name] = `link:${workspacePackageDir}`;
      changed = true;
    }
  }

  if (changed) {
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  }
}

async function readWorkspacePackageDirectories(workspaceRoot: string): Promise<Map<string, string>> {
  const packages = new Map<string, string>();
  await collectPackageDirectories(workspaceRoot, packages);
  return packages;
}

async function collectPackageDirectories(
  dir: string,
  packages: Map<string, string>,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
    const packageJson = await readPackageJson(resolve(dir, "package.json"));
    const name = typeof packageJson?.name === "string" ? packageJson.name : undefined;

    if (name !== undefined) {
      packages.set(name, dir);
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredWorkspaceDirs.has(entry.name)) {
      continue;
    }

    await collectPackageDirectories(resolve(dir, entry.name), packages);
  }
}

async function findNearestFile(startDir: string, fileName: string): Promise<string | undefined> {
  let currentDir = startDir;

  while (true) {
    const candidate = resolve(currentDir, fileName);
    const candidateStats = await stat(candidate).catch(() => undefined);

    if (candidateStats?.isFile() === true) {
      return candidate;
    }

    const parentDir = dirname(currentDir);

    if (parentDir === currentDir) {
      return undefined;
    }

    currentDir = parentDir;
  }
}

async function runPluginPackageCommand(
  pluginDir: string,
  commandName: string,
  args: readonly string[],
): Promise<void> {
  try {
    await execFileAsync("pnpm", ["--dir", pluginDir, ...args], {
      maxBuffer: 1024 * 1024 * 10,
    });
  } catch (error) {
    const message = formatPluginPackageCommandError(error);

    throw new PluginLoadError(
      "install_error",
      `Plugin package ${commandName} failed in ${pluginDir}: ${message}`,
    );
  }
}

function formatPluginPackageCommandError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const output = error as Error & {
    readonly stdout?: string | Buffer | undefined;
    readonly stderr?: string | Buffer | undefined;
  };
  const stdout = output.stdout === undefined ? "" : output.stdout.toString().trim();
  const stderr = output.stderr === undefined ? "" : output.stderr.toString().trim();

  return [error.message, stdout === "" ? undefined : stdout, stderr === "" ? undefined : stderr]
    .filter((part): part is string => part !== undefined)
    .join("\n");
}

async function readPackageJson(path: string): Promise<PackageJson | undefined> {
  const packageJsonStats = await stat(path).catch(() => undefined);

  if (packageJsonStats?.isFile() !== true) {
    return undefined;
  }

  return JSON.parse(await readFile(path, "utf8")) as PackageJson;
}

function hasPackageScript(packageJson: PackageJson, name: string): boolean {
  const scripts = readRecord(packageJson.scripts);
  return typeof scripts?.[name] === "string";
}

function readRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, string>;
}

type PackageJson = Record<string, unknown>;

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const ignoredWorkspaceDirs = new Set([
  ".git",
  ".turbo",
  ".next",
  ".pragma",
  "coverage",
  "dist",
  "node_modules",
  "workspace",
]);

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
