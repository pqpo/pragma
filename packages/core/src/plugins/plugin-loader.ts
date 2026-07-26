import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ExpertAgentPluginEntry,
  ExpertAgentPluginManifest,
  ExpertAgentPluginRegistration,
} from "./expert-agent-plugin.ts";
import { readExpertAgentPluginManifest } from "./expert-agent-plugin.ts";
import type { PragmaLoggerProvider } from "../logging/logger.ts";
import { createPragmaLogger, defaultPragmaLoggerProvider } from "../logging/logger.ts";
import { PragmaPaths } from "../storage/pragma-paths.ts";
import { withFileLock } from "../storage/file-lock.ts";

const INSTALL_METADATA_FILE = ".pragma-plugin-install.json";
const HOST_INSTALL_METADATA_FILES = new Set([INSTALL_METADATA_FILE, ".pragma-install.json"]);
const INSTALL_FORMAT_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXCLUDED_PACKAGE_SEGMENTS = new Set(["node_modules", ".turbo"]);

export interface ExpertAgentPluginSourceDescriptor {
  readonly source: string;
  readonly expectedRef?: `plugin:${string}@${string}` | undefined;
  readonly packageFingerprint?: string | undefined;
  readonly cachePolicy?: "immutable" | "host-managed" | undefined;
  readonly userConfig?: Readonly<Record<string, unknown>> | undefined;
  readonly hostBindings?: Readonly<Record<string, unknown>> | undefined;
}

export type ExpertAgentPluginSource = string | ExpertAgentPluginSourceDescriptor;

export type ExpertAgentPluginUse =
  | ExpertAgentPluginSource
  | {
      readonly entry: ExpertAgentPluginEntry;
      readonly userConfig?: Readonly<Record<string, unknown>> | undefined;
      readonly hostBindings?: Readonly<Record<string, unknown>> | undefined;
    };

export interface LoadExpertAgentPluginsOptions {
  readonly agentId: string;
  readonly pragmaHome?: string | undefined;
  readonly sources: readonly ExpertAgentPluginSource[];
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly pluginFailurePolicy?: "throw" | "collect" | undefined;
}

export interface ExpertAgentPluginLoadIssue {
  readonly source: string;
  readonly code:
    | "invalid_source"
    | "missing_manifest"
    | "missing_entry"
    | "identity_conflict"
    | "install_error"
    | "load_error";
  readonly message: string;
  readonly pluginId?: string | undefined;
}

export class ExpertAgentPluginLoadError extends Error {
  constructor(readonly issues: readonly ExpertAgentPluginLoadIssue[]) {
    super(
      `Expert plugin loading failed: ${issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`,
    );
    this.name = "ExpertAgentPluginLoadError";
  }
}

export interface LoadExpertAgentPluginsResult {
  readonly pluginEntries: readonly ExpertAgentPluginRegistration[];
  readonly issues: readonly ExpertAgentPluginLoadIssue[];
}

export interface ExpertAgentPluginModule {
  readonly default?: ExpertAgentPluginEntry | undefined;
}

interface InstalledPluginMetadata {
  readonly formatVersion: 1;
  readonly ref: string;
  readonly packageFingerprint: string;
  readonly manifestFingerprint: string;
}

export async function loadExpertAgentPlugins(
  options: LoadExpertAgentPluginsOptions,
): Promise<LoadExpertAgentPluginsResult> {
  const pluginEntries: ExpertAgentPluginRegistration[] = [];
  const issues: ExpertAgentPluginLoadIssue[] = [];
  const loggerProvider = options.loggerProvider ?? defaultPragmaLoggerProvider;
  const logger = createPragmaLogger(loggerProvider, {
    component: "plugin.loader",
  });

  for (const source of options.sources) {
    const descriptor = normalizePluginSource(source);
    try {
      const pluginDir = await prepareExpertAgentPluginSource(descriptor, options);
      pluginEntries.push({
        entry: await importExpertAgentPlugin(pluginDir, descriptor.expectedRef),
        ...(descriptor.userConfig === undefined ? {} : { userConfig: descriptor.userConfig }),
        ...(descriptor.hostBindings === undefined ? {} : { hostBindings: descriptor.hostBindings }),
      });
    } catch (error) {
      const issue: ExpertAgentPluginLoadIssue = {
        source: descriptor.source,
        code: readPluginLoadIssueCode(error),
        message: error instanceof Error ? error.message : String(error),
      };
      issues.push(issue);
      logger.warn("plugin.load_failed", "Failed to load Expert plugin", {
        ...issue,
        error,
      });
    }
  }

  if (issues.length > 0 && (options.pluginFailurePolicy ?? "throw") === "throw") {
    throw new ExpertAgentPluginLoadError(issues);
  }
  return { pluginEntries, issues };
}

export function isExpertAgentPluginEntryUse(plugin: ExpertAgentPluginUse): plugin is {
  readonly entry: ExpertAgentPluginEntry;
  readonly userConfig?: Readonly<Record<string, unknown>> | undefined;
  readonly hostBindings?: Readonly<Record<string, unknown>> | undefined;
} {
  return typeof plugin === "object" && "entry" in plugin;
}

export async function prepareExpertAgentPluginSource(
  source: ExpertAgentPluginSource,
  options: Pick<LoadExpertAgentPluginsOptions, "agentId" | "pragmaHome" | "env">,
): Promise<string> {
  const descriptor = normalizePluginSource(source);
  assertHostManagedSourceIdentity(descriptor);
  const absoluteSourcePath = isAbsolute(descriptor.source)
    ? descriptor.source
    : resolve(descriptor.source);
  const sourceStats = await stat(absoluteSourcePath).catch(() => undefined);

  if (sourceStats === undefined) {
    throw new InvalidPluginSourceError(`Plugin source does not exist: ${descriptor.source}`);
  }
  if (sourceStats.isFile() && extname(absoluteSourcePath) === ".zip") {
    throw new InvalidPluginSourceError(
      "Core does not expand plugin ZIP files. The host must validate and install a prebuilt ZIP before loading it.",
    );
  }
  if (!sourceStats.isDirectory()) {
    throw new InvalidPluginSourceError(
      `Plugin source must be a directory or .zip file: ${descriptor.source}`,
    );
  }

  await assertPluginManifestExists(absoluteSourcePath);
  await assertPluginPackageJsonExists(absoluteSourcePath);
  const manifest = readExpertAgentPluginManifest(resolve(absoluteSourcePath, "plugin.json"));
  const ref = pluginRef(manifest);
  assertExpectedPluginRef(descriptor.expectedRef, ref);
  const sourceFingerprint = await createExpertAgentPluginPackageFingerprint(absoluteSourcePath);
  assertExpectedPackageFingerprint(descriptor.packageFingerprint, sourceFingerprint, ref);

  const paths = new PragmaPaths({ pragmaHome: options.pragmaHome, env: options.env });
  return await installExpertAgentPluginSource({
    paths,
    agentId: options.agentId,
    manifest,
    sourceDir: absoluteSourcePath,
    packageFingerprint: sourceFingerprint,
    cachePolicy: descriptor.cachePolicy ?? "immutable",
  });
}

export async function createExpertAgentPluginPackageFingerprint(
  pluginDir: string,
): Promise<string> {
  const files = await collectPluginPackageFiles(resolve(pluginDir));
  const hash = createHash("sha256");
  hash.update("pragma.plugin.package/v1\0");
  for (const file of files) {
    const relativePath = relative(resolve(pluginDir), file).split(sep).join("/");
    const contents = await readFile(file);
    hash.update(String(Buffer.byteLength(relativePath)));
    hash.update(":");
    hash.update(relativePath);
    hash.update(":");
    hash.update(String(contents.byteLength));
    hash.update(":");
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function installExpertAgentPluginSource(options: {
  readonly paths: PragmaPaths;
  readonly agentId: string;
  readonly manifest: ExpertAgentPluginManifest;
  readonly sourceDir: string;
  readonly packageFingerprint: string;
  readonly cachePolicy: "immutable" | "host-managed";
}): Promise<string> {
  const targetDir = options.paths.pluginPackageCache(options.packageFingerprint);
  const stagingRoot = join(options.paths.pluginPackagesCacheRoot(), ".staging");
  const expectedMetadata = createInstalledMetadata(options.manifest, options.packageFingerprint);
  await mkdir(stagingRoot, { recursive: true });
  await mkdir(dirname(targetDir), { recursive: true });

  const existingState = await inspectInstalledPlugin(targetDir);
  if (existingState === "legacy-or-invalid") {
    await rm(targetDir, { recursive: true, force: true });
  } else if (existingState !== undefined) {
    assertInstalledPluginMatches(existingState, expectedMetadata);
    await writeAgentPluginBinding(options, targetDir);
    return targetDir;
  }

  let stagingDir: string | undefined;
  try {
    stagingDir = await mkdtemp(join(stagingRoot, ".plugin-"));
    await cp(options.sourceDir, stagingDir, {
      recursive: true,
      filter: (sourcePath) => shouldCopyPluginPackageFile(options.sourceDir, sourcePath),
    });
    const copiedFingerprint = await createExpertAgentPluginPackageFingerprint(stagingDir);
    assertExpectedPackageFingerprint(
      options.packageFingerprint,
      copiedFingerprint,
      pluginRef(options.manifest),
    );
    await writeFile(
      resolve(stagingDir, INSTALL_METADATA_FILE),
      `${JSON.stringify(expectedMetadata, undefined, 2)}\n`,
      "utf8",
    );
    try {
      await rename(stagingDir, targetDir);
      stagingDir = undefined;
      await writeAgentPluginBinding(options, targetDir);
      return targetDir;
    } catch (error) {
      if (!isRenameCollision(error)) throw error;
      const winner = await inspectInstalledPlugin(targetDir);
      if (winner === undefined || winner === "legacy-or-invalid") throw error;
      assertInstalledPluginMatches(winner, expectedMetadata);
      await writeAgentPluginBinding(options, targetDir);
      return targetDir;
    }
  } finally {
    if (stagingDir !== undefined) {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }
}

async function writeAgentPluginBinding(
  options: {
    readonly paths: PragmaPaths;
    readonly agentId: string;
    readonly manifest: ExpertAgentPluginManifest;
    readonly packageFingerprint: string;
    readonly cachePolicy: "immutable" | "host-managed";
  },
  packageRoot: string,
): Promise<void> {
  const path = options.paths.agentPluginBinding(options.agentId, pluginRef(options.manifest));
  await withFileLock(`${path}.lock`, async () => {
    const existing = await readFile(path, "utf8")
      .then((value) => JSON.parse(value) as { readonly packageFingerprint?: unknown })
      .catch((error: unknown) => {
        if (readErrorCode(error) === "ENOENT") return undefined;
        throw error;
      });
    if (
      options.cachePolicy === "immutable" &&
      existing !== undefined &&
      existing.packageFingerprint !== options.packageFingerprint
    ) {
      throw new PluginLoadError(
        "identity_conflict",
        `Plugin ${pluginRef(options.manifest)} is immutable and is already bound to different bytes.`,
      );
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(
        {
          schemaVersion: "pragma.agent-plugin-binding/v1",
          ref: pluginRef(options.manifest),
          packageFingerprint: options.packageFingerprint,
          packageRoot,
        },
        undefined,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, path);
  });
}

async function inspectInstalledPlugin(
  targetDir: string,
): Promise<InstalledPluginMetadata | "legacy-or-invalid" | undefined> {
  if ((await stat(targetDir).catch(() => undefined))?.isDirectory() !== true) return undefined;
  try {
    const value = JSON.parse(
      await readFile(resolve(targetDir, INSTALL_METADATA_FILE), "utf8"),
    ) as Partial<InstalledPluginMetadata>;
    if (
      value.formatVersion !== INSTALL_FORMAT_VERSION ||
      typeof value.ref !== "string" ||
      typeof value.packageFingerprint !== "string" ||
      !SHA256_PATTERN.test(value.packageFingerprint) ||
      typeof value.manifestFingerprint !== "string" ||
      !SHA256_PATTERN.test(value.manifestFingerprint)
    ) {
      return "legacy-or-invalid";
    }
    const actualFingerprint = await createExpertAgentPluginPackageFingerprint(targetDir);
    if (actualFingerprint !== value.packageFingerprint) return "legacy-or-invalid";
    return value as InstalledPluginMetadata;
  } catch {
    return "legacy-or-invalid";
  }
}

async function importExpertAgentPlugin(
  pluginDir: string,
  expectedRef?: string,
): Promise<ExpertAgentPluginEntry> {
  const manifest = readExpertAgentPluginManifest(resolve(pluginDir, "plugin.json"));
  const ref = pluginRef(manifest);
  assertExpectedPluginRef(expectedRef, ref);
  const entryPath = resolve(pluginDir, manifest.runtime.entry);
  if ((await stat(entryPath).catch(() => undefined))?.isFile() !== true) {
    throw new PluginLoadError(
      "missing_entry",
      `Plugin ${manifest.id} entry file does not exist: ${manifest.runtime.entry}`,
    );
  }
  const module = (await import(pathToFileURL(entryPath).href)) as ExpertAgentPluginModule;
  const plugin = module.default;
  if (plugin === undefined) {
    throw new PluginLoadError(
      "load_error",
      `Plugin ${manifest.id} must default export definePluginEntry(...).`,
    );
  }
  if (stableStringify(plugin.manifest) !== stableStringify(manifest)) {
    throw new PluginLoadError(
      "identity_conflict",
      `Plugin export manifest does not match installed manifest for ${ref}.`,
    );
  }
  return plugin;
}

async function collectPluginPackageFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (
        HOST_INSTALL_METADATA_FILES.has(entry.name) ||
        EXCLUDED_PACKAGE_SEGMENTS.has(entry.name)
      ) {
        continue;
      }
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new InvalidPluginSourceError(
          `Plugin packages cannot contain symbolic links: ${path}`,
        );
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      } else {
        throw new InvalidPluginSourceError(`Plugin packages can contain only files: ${path}`);
      }
    }
  };
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function shouldCopyPluginPackageFile(root: string, sourcePath: string): boolean {
  const segments = relative(root, sourcePath)
    .split(/[\\/]+/u)
    .filter(Boolean);
  return !segments.some((segment) => EXCLUDED_PACKAGE_SEGMENTS.has(segment));
}

function normalizePluginSource(source: ExpertAgentPluginSource): ExpertAgentPluginSourceDescriptor {
  return typeof source === "string" ? { source } : source;
}

function assertHostManagedSourceIdentity(descriptor: ExpertAgentPluginSourceDescriptor): void {
  if (descriptor.cachePolicy !== "host-managed") return;
  if (
    descriptor.expectedRef === undefined ||
    descriptor.packageFingerprint === undefined ||
    !SHA256_PATTERN.test(descriptor.packageFingerprint)
  ) {
    throw new InvalidPluginSourceError(
      "Host-managed plugins require an exact ref and package fingerprint.",
    );
  }
}

function pluginRef(manifest: ExpertAgentPluginManifest): `plugin:${string}@${string}` {
  return `plugin:${manifest.id}@${manifest.version}`;
}

function createInstalledMetadata(
  manifest: ExpertAgentPluginManifest,
  packageFingerprint: string,
): InstalledPluginMetadata {
  return {
    formatVersion: INSTALL_FORMAT_VERSION,
    ref: pluginRef(manifest),
    packageFingerprint,
    manifestFingerprint: sha256(stableStringify(manifest)),
  };
}

function assertInstalledPluginMatches(
  actual: InstalledPluginMetadata,
  expected: InstalledPluginMetadata,
): void {
  if (
    actual.ref !== expected.ref ||
    actual.packageFingerprint !== expected.packageFingerprint ||
    actual.manifestFingerprint !== expected.manifestFingerprint
  ) {
    throw new PluginLoadError(
      "identity_conflict",
      `Plugin ${expected.ref} is immutable and the cached package contains different bytes.`,
    );
  }
}

function assertExpectedPluginRef(expected: string | undefined, actual: string): void {
  if (expected !== undefined && expected !== actual) {
    throw new PluginLoadError(
      "identity_conflict",
      `Resolved plugin ${actual} does not match requested ${expected}.`,
    );
  }
}

function assertExpectedPackageFingerprint(
  expected: string | undefined,
  actual: string,
  ref: string,
): void {
  if (expected !== undefined && (!SHA256_PATTERN.test(expected) || expected !== actual)) {
    throw new PluginLoadError(
      "identity_conflict",
      `Plugin ${ref} package fingerprint does not match the resolved package bytes.`,
    );
  }
}

async function assertPluginManifestExists(pluginDir: string): Promise<void> {
  const manifestPath = resolve(pluginDir, "plugin.json");
  if ((await stat(manifestPath).catch(() => undefined))?.isFile() !== true) {
    throw new PluginLoadError(
      "missing_manifest",
      `Plugin manifest does not exist: ${manifestPath}`,
    );
  }
}

async function assertPluginPackageJsonExists(pluginDir: string): Promise<void> {
  const packageJsonPath = resolve(pluginDir, "package.json");
  if ((await stat(packageJsonPath).catch(() => undefined))?.isFile() !== true) {
    throw new PluginLoadError(
      "invalid_source",
      `Plugin package.json does not exist: ${packageJsonPath}`,
    );
  }
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
  if (error instanceof PluginLoadError) return error.code;
  if (error instanceof InvalidPluginSourceError) return "invalid_source";
  return "load_error";
}

function isRenameCollision(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error.code))
  );
}

function readErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
