import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { DEFAULT_STORAGE_POLICY, type PragmaLogger } from "@pragma/core";

export interface PrepareManagedQoderConfigOptions {
  readonly sessionDir: string;
  readonly externalCommandsCacheDir: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly logger: Pick<PragmaLogger, "warn">;
}

export interface ManagedQoderConfig {
  readonly configDir: string;
  readonly externalCommandsCacheDir?: string | undefined;
}

const PRIVATE_STATE_DIRECTORIES = ["projects", "logs", "tmp"] as const;
const SHARED_CONFIG_SNAPSHOTS = [
  {
    name: ".auth",
    event: "runtime.qodercli_auth_snapshot_failed",
    description: "local login state",
  },
  {
    name: ".models",
    event: "runtime.qodercli_model_catalog_snapshot_failed",
    description: "local model catalog",
  },
] as const;

export async function prepareManagedQoderConfig({
  sessionDir,
  externalCommandsCacheDir,
  env,
  logger,
}: PrepareManagedQoderConfigOptions): Promise<ManagedQoderConfig> {
  const configDir = join(sessionDir, "config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await Promise.all(
    PRIVATE_STATE_DIRECTORIES.map(async (directory) => {
      await mkdir(join(configDir, directory), { recursive: true, mode: 0o700 });
    }),
  );

  const sharedConfigDir = resolveSharedQoderConfigDir(env);
  await Promise.all(
    SHARED_CONFIG_SNAPSHOTS.map(async (snapshot) => {
      const target = join(configDir, snapshot.name);
      try {
        await access(target);
        return;
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }

      try {
        await cp(join(sharedConfigDir, snapshot.name), target, {
          recursive: true,
          dereference: true,
          errorOnExist: true,
          force: false,
        });
      } catch (copyError) {
        if (!isNotFoundError(copyError)) {
          logger.warn(
            snapshot.event,
            `Qoder CLI managed config could not snapshot the ${snapshot.description}`,
            { error: copyError },
          );
        }
      }
    }),
  );

  const managedExternalCommandsCacheDir = await prepareSharedExternalCommands({
    configDir,
    cacheDir: externalCommandsCacheDir,
    logger,
  });
  if (managedExternalCommandsCacheDir !== undefined) {
    await cleanupManagedQoderExternalCommands(managedExternalCommandsCacheDir).catch((error) => {
      logger.warn(
        "runtime.qodercli_external_commands_cleanup_failed",
        "Qoder CLI shared external-command artifacts could not be cleaned.",
        { error },
      );
    });
  }
  return {
    configDir,
    ...(managedExternalCommandsCacheDir === undefined
      ? {}
      : { externalCommandsCacheDir: managedExternalCommandsCacheDir }),
  };
}

export async function cleanupManagedQoderExternalCommands(
  cacheDir: string,
  options: {
    readonly now?: number | undefined;
    readonly temporaryTtlMs?: number | undefined;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  const temporaryTtlMs = options.temporaryTtlMs ?? DEFAULT_STORAGE_POLICY.temporaryTtlMs;
  const commands = await readdir(cacheDir, { withFileTypes: true }).catch((error: unknown) => {
    if (isNotFoundError(error)) return [];
    throw error;
  });
  await Promise.all(
    commands.map(async (command) => {
      if (!command.isDirectory() || !/^[a-z][a-z0-9-]*$/.test(command.name)) return;
      const commandDir = join(cacheDir, command.name);
      if (await hasLiveCommandLock(cacheDir, command.name)) return;
      await removeCompletedDownloads(join(commandDir, "current"));
      const entries = await readdir(commandDir, { withFileTypes: true }).catch((error: unknown) => {
        if (isNotFoundError(error)) return [];
        throw error;
      });
      await Promise.all(
        entries
          .filter((entry) => entry.name.startsWith(".tmp-"))
          .map(async (entry) => {
            const path = join(commandDir, entry.name);
            const metadata = await stat(path).catch(() => undefined);
            if (metadata === undefined || now - metadata.mtimeMs < temporaryTtlMs) return;
            await rm(path, { recursive: true, force: true });
          }),
      );
    }),
  );
}

async function prepareSharedExternalCommands(input: {
  readonly configDir: string;
  readonly cacheDir: string;
  readonly logger: Pick<PragmaLogger, "warn">;
}): Promise<string | undefined> {
  const target = join(input.configDir, "external-commands");
  const existing = await lstat(target).catch((error: unknown) => {
    if (isNotFoundError(error)) return undefined;
    throw error;
  });
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) return undefined;
    const linkedPath = resolve(dirname(target), await readlink(target));
    if (linkedPath !== resolve(input.cacheDir)) return undefined;
    await mkdir(input.cacheDir, { recursive: true, mode: 0o700 });
    return input.cacheDir;
  }

  await mkdir(input.cacheDir, { recursive: true, mode: 0o700 });
  try {
    await symlink(
      resolve(input.cacheDir),
      target,
      process.platform === "win32" ? "junction" : "dir",
    );
    return input.cacheDir;
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    const raced = await lstat(target);
    if (!raced.isSymbolicLink()) return undefined;
    const linkedPath = resolve(dirname(target), await readlink(target));
    if (linkedPath === resolve(input.cacheDir)) return input.cacheDir;
    input.logger.warn(
      "runtime.qodercli_external_commands_link_conflict",
      "Qoder CLI session external commands already point to a different location; preserving it.",
    );
    return undefined;
  }
}

async function removeCompletedDownloads(currentDir: string): Promise<void> {
  const current = await lstat(currentDir).catch((error: unknown) => {
    if (isNotFoundError(error)) return undefined;
    throw error;
  });
  if (current === undefined || !current.isDirectory()) return;
  const entries = await readdir(currentDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.name.startsWith("download-"))
      .map(async (entry) => {
        await rm(join(currentDir, entry.name), { recursive: true, force: true });
      }),
  );
}

async function hasLiveCommandLock(cacheDir: string, commandName: string): Promise<boolean> {
  const lockPath = join(cacheDir, "locks", `${commandName}.lock`);
  const content = await readFile(lockPath, "utf8").catch((error: unknown) => {
    if (isNotFoundError(error)) return undefined;
    throw error;
  });
  if (content === undefined) return false;
  let pid: unknown;
  try {
    const parsed = JSON.parse(content) as { readonly pid?: unknown };
    pid = parsed.pid;
  } catch {
    const parsed = Number(content.trim());
    pid = Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return typeof pid === "number" && isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

export function resolveSharedQoderConfigDir(env: NodeJS.ProcessEnv | undefined): string {
  const explicit = readNonEmpty(env?.["QODER_CONFIG_DIR"]);
  if (explicit !== undefined) return explicit;
  return join(homedir(), ".qoder");
}

function readNonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function isNotFoundError(error: unknown): boolean {
  return isNodeError(error, "ENOENT");
}

function isAlreadyExistsError(error: unknown): boolean {
  return isNodeError(error, "EEXIST");
}

function isNodeError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
