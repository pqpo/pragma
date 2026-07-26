import { createHash, randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

import { type Expert, type PragmaLogger, type PragmaPaths, withFileLock } from "@pragma/core";
import { materializeCodexSkills } from "./skills.ts";

export interface PrepareManagedCodexHomeOptions {
  readonly agent: Expert;
  readonly sessionDir: string;
  readonly pragmaPaths: PragmaPaths;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly logger: Pick<PragmaLogger, "warn">;
}

export interface ManagedCodexHome {
  readonly home: string;
  readonly sqliteHome: string;
  readonly sharedBase: string;
  readonly baseFingerprint: string;
}

const CODEX_PRIVATE_CONFIG_FILES = [
  ".env",
  "config.json",
  "config.toml",
  "instructions.md",
] as const;
const CODEX_SHARED_CACHE_DIRECTORIES = ["plugins", "packages", "cache"] as const;

export async function prepareManagedCodexHome({
  agent,
  sessionDir,
  pragmaPaths,
  env,
  logger,
}: PrepareManagedCodexHomeOptions): Promise<ManagedCodexHome> {
  const home = join(sessionDir, "home");
  const sqliteHome = join(sessionDir, "sqlite");
  const sourceHome = resolveSourceCodexHome(env);
  const shared = await prepareSharedBase(sourceHome, pragmaPaths);

  await mkdir(home, { recursive: true, mode: 0o700 });
  await Promise.all([
    mkdir(join(home, "sessions"), { recursive: true, mode: 0o700 }),
    mkdir(join(home, "logs"), { recursive: true, mode: 0o700 }),
    mkdir(join(home, "tmp"), { recursive: true, mode: 0o700 }),
    mkdir(sqliteHome, { recursive: true, mode: 0o700 }),
  ]);
  await exposeManagedAuth(sourceHome, home, pragmaPaths, logger);
  await copyPrivateConfigFiles(sourceHome, home, logger);
  await exposeSharedCacheDirectories(shared.root, home);
  await materializeCodexSkills({
    agent,
    codexHome: home,
    sharedSkillsRoot: join(pragmaPaths.codexRuntimeCacheRoot(), "skills"),
  });
  await writeFile(
    join(sessionDir, "layout.json"),
    `${JSON.stringify(
      {
        schemaVersion: "pragma.codex-home/v2",
        baseFingerprint: shared.fingerprint,
        sharedBase: shared.root,
      },
      undefined,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  return {
    home,
    sqliteHome,
    sharedBase: shared.root,
    baseFingerprint: shared.fingerprint,
  };
}

function resolveSourceCodexHome(env: NodeJS.ProcessEnv | undefined): string {
  return env?.CODEX_HOME ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
}

async function prepareSharedBase(
  sourceHome: string,
  paths: PragmaPaths,
): Promise<{ readonly root: string; readonly fingerprint: string }> {
  const bases = join(paths.codexRuntimeCacheRoot(), "bases");
  const staging = join(bases, `.snapshot-${randomUUID()}.tmp`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const name of CODEX_SHARED_CACHE_DIRECTORIES) {
      const source = join(sourceHome, name);
      if ((await stat(source).catch(() => undefined))?.isDirectory() !== true) continue;
      await cp(source, join(staging, name), { recursive: true, dereference: true });
    }
    const fingerprint = await fingerprintSharedDirectories(staging);
    const root = join(bases, fingerprint);
    const complete = join(root, ".complete");
    await withFileLock(`${root}.lock`, async () => {
      try {
        await access(complete);
        return;
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      await writeFile(join(staging, ".complete"), `${fingerprint}\n`, { mode: 0o600 });
      await rm(root, { recursive: true, force: true });
      await rename(staging, root);
    });
    return { root, fingerprint };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function fingerprintSharedDirectories(sourceHome: string): Promise<string> {
  const hash = createHash("sha256").update("pragma.codex-shared-base/v1\0");
  for (const name of CODEX_SHARED_CACHE_DIRECTORIES) {
    const root = join(sourceHome, name);
    if ((await stat(root).catch(() => undefined))?.isDirectory() !== true) continue;
    const files = await collectFiles(root);
    for (const file of files) {
      const path = relative(sourceHome, file).split(sep).join("/");
      const bytes = await readFile(file);
      hash.update(`${path.length}:${path}:${bytes.byteLength}:`).update(bytes).update("\0");
    }
  }
  return hash.digest("hex");
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.toSorted();
}

async function exposeManagedAuth(
  sourceHome: string,
  home: string,
  paths: PragmaPaths,
  logger: Pick<PragmaLogger, "warn">,
): Promise<void> {
  const source = join(sourceHome, "auth.json");
  if ((await stat(source).catch(() => undefined))?.isFile() !== true) return;
  const credential = join(paths.credentialsRoot(), "codex", "auth.json");
  await mkdir(dirname(credential), { recursive: true, mode: 0o700 });
  const sourceBytes = await readFile(source);
  const current = await readFile(credential).catch(() => undefined);
  if (current === undefined || !current.equals(sourceBytes)) {
    const temporary = `${credential}.${randomUUID()}.tmp`;
    await writeFile(temporary, sourceBytes, { mode: 0o600 });
    await rename(temporary, credential);
  }
  try {
    await replaceSymlink(credential, join(home, "auth.json"), "file");
  } catch (error) {
    logger.warn(
      "runtime.codex_credential_link_failed",
      "Codex managed home could not link the Pragma credential projection",
      { error },
    );
    await copyFile(credential, join(home, "auth.json"));
  }
}

async function copyPrivateConfigFiles(
  sourceHome: string,
  home: string,
  logger: Pick<PragmaLogger, "warn">,
): Promise<void> {
  for (const file of CODEX_PRIVATE_CONFIG_FILES) {
    try {
      await copyFile(join(sourceHome, file), join(home, file));
    } catch (error) {
      if (!isNotFoundError(error)) {
        logger.warn(
          "runtime.codex_config_snapshot_failed",
          "Codex managed home could not snapshot a private config file",
          { file, error },
        );
      }
    }
  }
  await sanitizeCopiedCodexConfig(join(home, "config.toml"), logger);
}

async function exposeSharedCacheDirectories(sharedBase: string, home: string): Promise<void> {
  for (const name of CODEX_SHARED_CACHE_DIRECTORIES) {
    const source = join(sharedBase, name);
    if ((await stat(source).catch(() => undefined))?.isDirectory() !== true) continue;
    await replaceSymlink(source, join(home, name), "dir");
  }
}

async function sanitizeCopiedCodexConfig(
  configPath: string,
  logger: Pick<PragmaLogger, "warn">,
): Promise<void> {
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (!isNotFoundError(error))
      logger.warn(
        "runtime.codex_config_read_failed",
        "Codex managed home could not read config.toml",
        { error },
      );
    return;
  }
  const sanitized = stripSkillsConfigEntries(content);
  if (sanitized !== content) await writeFile(configPath, sanitized, { mode: 0o600 });
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

function isNotFoundError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
