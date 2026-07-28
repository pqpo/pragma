import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

import { type Expert, type PragmaLogger, type PragmaPaths } from "@pragma/core";
import { materializeCodexSkills } from "./skills.ts";

export interface PrepareManagedCodexHomeOptions {
  readonly agent: Expert;
  readonly sessionDir: string;
  readonly pragmaPaths: PragmaPaths;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly logger: Pick<PragmaLogger, "info" | "warn">;
}

export interface ManagedCodexHome {
  readonly home: string;
  readonly sqliteHome: string;
}

const CODEX_PRIVATE_CONFIG_FILES = [
  ".env",
  "config.json",
  "config.toml",
  "instructions.md",
] as const;
const CODEX_MODELS_CACHE_FILE = "models_cache.json";
const CODEX_MODELS_CACHE_BINDING_FILE = ".models_cache_config.sha256";
const CODEX_LEGACY_LAYOUT_SCHEMA = "pragma.codex-home/v2";

export async function prepareManagedCodexHome({
  agent,
  sessionDir,
  pragmaPaths,
  env,
  logger,
}: PrepareManagedCodexHomeOptions): Promise<ManagedCodexHome> {
  const startedAt = performance.now();
  const home = join(sessionDir, "home");
  const sqliteHome = join(sessionDir, "sqlite");
  const sourceHome = resolveSourceCodexHome(env);
  const freshHome = (await lstat(home).catch(() => undefined)) === undefined;

  await mkdir(home, { recursive: true, mode: 0o700 });
  await Promise.all([
    mkdir(join(home, "sessions"), { recursive: true, mode: 0o700 }),
    mkdir(join(home, "logs"), { recursive: true, mode: 0o700 }),
    mkdir(join(home, "tmp"), { recursive: true, mode: 0o700 }),
    mkdir(sqliteHome, { recursive: true, mode: 0o700 }),
  ]);

  const configSnapshot = await copyPrivateConfigFiles(sourceHome, home);
  await Promise.all([
    exposeManagedAuth(sourceHome, home, pragmaPaths, logger),
    exposeSharedPluginCache(sourceHome, home, pragmaPaths),
  ]);
  const modelCatalog = await syncRelativeModelCatalog(sourceHome, home, configSnapshot.configToml);
  const seededModelsCache = await syncModelsCache({
    sourceHome,
    home,
    freshHome,
    configSnapshot,
    modelCatalog,
  });
  await materializeCodexSkills({
    agent,
    codexHome: home,
  });
  await removeLegacyLayout(sessionDir, pragmaPaths);

  logger.info(
    "runtime.codex_minimal_home_ready",
    "Prepared a minimal isolated Codex home without copying host cache trees",
    {
      durationMs: elapsedMs(startedAt),
      copiedConfigBytes: configSnapshot.totalBytes + (modelCatalog?.bytes.byteLength ?? 0),
      copiedConfigFiles: configSnapshot.files.length + (modelCatalog === undefined ? 0 : 1),
      pluginCacheMode: "shared-host-link",
      seededModelsCache,
    },
  );

  return { home, sqliteHome };
}

function resolveSourceCodexHome(env: NodeJS.ProcessEnv | undefined): string {
  return resolve(env?.CODEX_HOME ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex"));
}

interface ConfigSnapshot {
  readonly files: readonly string[];
  readonly values: ReadonlyMap<string, Uint8Array>;
  readonly configToml?: string | undefined;
  readonly totalBytes: number;
}

async function copyPrivateConfigFiles(sourceHome: string, home: string): Promise<ConfigSnapshot> {
  const files: string[] = [];
  const values = new Map<string, Uint8Array>();
  let totalBytes = 0;

  for (const file of CODEX_PRIVATE_CONFIG_FILES) {
    const source = join(sourceHome, file);
    const target = join(home, file);
    const bytes = await readOptionalRegularFile(source);
    if (bytes === undefined) {
      await removeManagedFile(target);
      continue;
    }
    await atomicWriteFile(target, bytes);
    files.push(file);
    values.set(file, bytes);
    totalBytes += bytes.byteLength;
  }

  const sourceConfigBytes = values.get("config.toml");
  let configToml: string | undefined;
  if (sourceConfigBytes !== undefined) {
    await sanitizeCopiedCodexConfig(join(home, "config.toml"));
    const effectiveConfig = await readFile(join(home, "config.toml"));
    values.set("config.toml", effectiveConfig);
    configToml = effectiveConfig.toString("utf8");
  }
  return {
    files,
    values,
    configToml,
    totalBytes,
  };
}

interface CopiedModelCatalog {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

async function syncRelativeModelCatalog(
  sourceHome: string,
  home: string,
  configToml: string | undefined,
): Promise<CopiedModelCatalog | undefined> {
  if (configToml === undefined) return undefined;
  const configuredPath = readRootTomlString(configToml, "model_catalog_json");
  if (
    configuredPath === undefined ||
    isAbsolute(configuredPath) ||
    configuredPath.startsWith("~/") ||
    configuredPath.startsWith("~\\")
  ) {
    return undefined;
  }

  const relativePath = normalize(configuredPath);
  if (
    relativePath === "" ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error(`Codex model_catalog_json must stay inside CODEX_HOME: ${configuredPath}`);
  }
  const source = resolve(sourceHome, relativePath);
  if (!isPathInside(sourceHome, source)) {
    throw new Error(`Codex model_catalog_json must stay inside CODEX_HOME: ${configuredPath}`);
  }
  const bytes = await readRequiredRegularFile(source, "Codex model catalog");
  await atomicWriteFile(join(home, relativePath), bytes);
  return { relativePath, bytes };
}

function readRootTomlString(content: string, key: string): string | undefined {
  let insideTable = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      insideTable = true;
      continue;
    }
    if (insideTable) continue;
    const match = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(.*)$`).exec(trimmed);
    if (match === null) continue;
    const literal = match[1]?.trim() ?? "";
    if (literal.startsWith('"')) {
      const stringMatch = /^"(?:\\.|[^"\\])*"/.exec(literal);
      if (stringMatch === null || !hasOnlyTomlComment(literal.slice(stringMatch[0].length))) {
        throw new Error(`Codex ${key} must be a single-line TOML string.`);
      }
      try {
        return JSON.parse(stringMatch[0]) as string;
      } catch (error) {
        throw new Error(`Codex ${key} contains an invalid TOML string.`, { cause: error });
      }
    }
    if (literal.startsWith("'")) {
      const end = literal.indexOf("'", 1);
      if (end < 0 || !hasOnlyTomlComment(literal.slice(end + 1))) {
        throw new Error(`Codex ${key} must be a single-line TOML string.`);
      }
      return literal.slice(1, end);
    }
    throw new Error(`Codex ${key} must be a quoted TOML string.`);
  }
  return undefined;
}

function hasOnlyTomlComment(value: string): boolean {
  const remaining = value.trim();
  return remaining === "" || remaining.startsWith("#");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function syncModelsCache({
  sourceHome,
  home,
  freshHome,
  configSnapshot,
  modelCatalog,
}: {
  readonly sourceHome: string;
  readonly home: string;
  readonly freshHome: boolean;
  readonly configSnapshot: ConfigSnapshot;
  readonly modelCatalog: CopiedModelCatalog | undefined;
}): Promise<boolean> {
  const binding = fingerprintModelConfiguration(configSnapshot, modelCatalog);
  const bindingPath = join(home, CODEX_MODELS_CACHE_BINDING_FILE);
  const cachePath = join(home, CODEX_MODELS_CACHE_FILE);
  const previousBinding = await readFile(bindingPath, "utf8").catch(() => undefined);

  if (previousBinding?.trim() === binding) {
    const cacheInfo = await lstat(cachePath).catch(() => undefined);
    if (cacheInfo !== undefined && !cacheInfo.isFile()) await rm(cachePath, { recursive: true });
    return false;
  }

  await rm(cachePath, { recursive: true, force: true });
  let seeded = false;
  if (freshHome && previousBinding === undefined) {
    const sharedCache = await readOptionalRegularFile(join(sourceHome, CODEX_MODELS_CACHE_FILE));
    if (sharedCache !== undefined) {
      await atomicWriteFile(cachePath, sharedCache);
      seeded = true;
    }
  }
  await atomicWriteFile(bindingPath, Buffer.from(`${binding}\n`));
  return seeded;
}

function fingerprintModelConfiguration(
  configSnapshot: ConfigSnapshot,
  modelCatalog: CopiedModelCatalog | undefined,
): string {
  const hash = createHash("sha256").update("pragma.codex-model-cache-binding/v1\0");
  for (const file of ["config.json", "config.toml"] as const) {
    const bytes = configSnapshot.values.get(file);
    hash.update(`${file}\0`);
    if (bytes === undefined) hash.update("missing\0");
    else hash.update(`${bytes.byteLength}\0`).update(bytes).update("\0");
  }
  if (modelCatalog === undefined) hash.update("model_catalog_json\0none\0");
  else
    hash
      .update(
        `model_catalog_json\0${modelCatalog.relativePath}\0${modelCatalog.bytes.byteLength}\0`,
      )
      .update(modelCatalog.bytes)
      .update("\0");
  return hash.digest("hex");
}

async function exposeSharedPluginCache(
  sourceHome: string,
  home: string,
  pragmaPaths: PragmaPaths,
): Promise<void> {
  const plugins = join(home, "plugins");
  await replaceLegacyPluginsRoot(plugins, pragmaPaths);
  await mkdir(plugins, { recursive: true, mode: 0o700 });

  const source = join(sourceHome, "plugins", "cache");
  const target = join(plugins, "cache");
  const sourceInfo = await stat(source).catch((error: unknown) => {
    if (isNotFoundError(error)) return undefined;
    throw error;
  });
  if (sourceInfo === undefined) {
    await replaceWithPrivateDirectory(target);
  } else {
    if (!sourceInfo.isDirectory()) {
      throw new Error(`Codex plugin cache is not a directory: ${source}`);
    }
    await replaceSymlink(source, target, "dir");
  }

  await Promise.all([
    removeLegacyBaseLink(join(home, "packages"), pragmaPaths),
    removeLegacyBaseLink(join(home, "cache"), pragmaPaths),
  ]);
}

async function replaceLegacyPluginsRoot(plugins: string, pragmaPaths: PragmaPaths): Promise<void> {
  const current = await lstat(plugins).catch(() => undefined);
  if (current === undefined || !current.isSymbolicLink()) return;
  if (!(await linkTargetsLegacyBase(plugins, pragmaPaths))) {
    throw new Error(
      `Codex managed plugins path points outside the legacy Pragma cache: ${plugins}`,
    );
  }
  await rm(plugins);
}

async function removeLegacyBaseLink(path: string, pragmaPaths: PragmaPaths): Promise<void> {
  const current = await lstat(path).catch(() => undefined);
  if (current?.isSymbolicLink() !== true) return;
  if (await linkTargetsLegacyBase(path, pragmaPaths)) await rm(path);
}

async function linkTargetsLegacyBase(path: string, pragmaPaths: PragmaPaths): Promise<boolean> {
  const linked = resolve(dirname(path), await readlink(path));
  return isPathInside(join(pragmaPaths.codexRuntimeCacheRoot(), "bases"), linked);
}

async function replaceWithPrivateDirectory(path: string): Promise<void> {
  const current = await lstat(path).catch(() => undefined);
  if (current?.isDirectory() === true && !current.isSymbolicLink()) return;
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function exposeManagedAuth(
  sourceHome: string,
  home: string,
  paths: PragmaPaths,
  logger: Pick<PragmaLogger, "warn">,
): Promise<void> {
  const source = join(sourceHome, "auth.json");
  const sourceBytes = await readOptionalRegularFile(source);
  if (sourceBytes === undefined) {
    await removeManagedFile(join(home, "auth.json"));
    return;
  }
  const credential = join(paths.credentialsRoot(), "codex", "auth.json");
  await mkdir(dirname(credential), { recursive: true, mode: 0o700 });
  const current = await readFile(credential).catch(() => undefined);
  if (current === undefined || !current.equals(sourceBytes)) {
    await atomicWriteFile(credential, sourceBytes);
  }
  try {
    await replaceSymlink(credential, join(home, "auth.json"), "file");
  } catch (error) {
    logger.warn(
      "runtime.codex_credential_link_failed",
      "Codex managed home could not link the Pragma credential projection",
      { error },
    );
    await atomicWriteFile(join(home, "auth.json"), sourceBytes);
  }
}

async function removeLegacyLayout(sessionDir: string, paths: PragmaPaths): Promise<void> {
  const layout = join(sessionDir, "layout.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(layout, "utf8"));
  } catch (error) {
    if (isNotFoundError(error) || error instanceof SyntaxError) return;
    throw error;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    value.schemaVersion === CODEX_LEGACY_LAYOUT_SCHEMA &&
    "sharedBase" in value &&
    typeof value.sharedBase === "string" &&
    isPathInside(join(paths.codexRuntimeCacheRoot(), "bases"), value.sharedBase)
  ) {
    await rm(layout, { force: true });
  }
}

async function sanitizeCopiedCodexConfig(configPath: string): Promise<void> {
  const content = await readFile(configPath, "utf8");
  const sanitized = stripSkillsConfigEntries(content);
  if (sanitized !== content) await atomicWriteFile(configPath, Buffer.from(sanitized));
}

function stripSkillsConfigEntries(content: string): string {
  if (!content.includes("[[skills.config]]")) return content;
  const output: string[] = [];
  let inSkillsConfig = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      if (!inSkillsConfig) output.push(line);
      continue;
    }
    if (trimmed.startsWith("[")) {
      if (trimmed === "[[skills.config]]") {
        inSkillsConfig = true;
        continue;
      }
      inSkillsConfig = false;
    }
    if (!inSkillsConfig) output.push(line);
  }
  return `${output.join("\n").trimEnd()}\n`;
}

async function replaceSymlink(source: string, target: string, type: "dir" | "file"): Promise<void> {
  const current = await lstat(target).catch(() => undefined);
  if (current?.isSymbolicLink() === true) {
    const linked = resolve(dirname(target), await readlink(target));
    if (linked === resolve(source)) return;
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await rm(target, { recursive: true, force: true });
  await symlink(source, target, type === "dir" && process.platform === "win32" ? "junction" : type);
}

async function readOptionalRegularFile(path: string): Promise<Buffer | undefined> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
  if (!info.isFile()) throw new Error(`Codex managed file source is not a regular file: ${path}`);
  return await readFile(path);
}

async function readRequiredRegularFile(path: string, label: string): Promise<Buffer> {
  const bytes = await readOptionalRegularFile(path);
  if (bytes === undefined) throw new Error(`${label} was not found: ${path}`);
  return bytes;
}

async function removeManagedFile(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

async function atomicWriteFile(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    try {
      await rename(temporary, path);
    } catch (error) {
      if (!isWindowsReplaceError(error)) throw error;
      await rm(path, { recursive: true, force: true });
      await rename(temporary, path);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

function isWindowsReplaceError(error: unknown): boolean {
  if (process.platform !== "win32" || error === null || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  return code === "EEXIST" || code === "EPERM";
}

function isPathInside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function isNotFoundError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
