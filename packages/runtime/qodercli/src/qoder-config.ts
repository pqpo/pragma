import { access, cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PragmaLogger } from "@pragma/core";

export interface PrepareManagedQoderConfigOptions {
  readonly sessionDir: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly logger: Pick<PragmaLogger, "warn">;
}

const PRIVATE_STATE_DIRECTORIES = ["projects", "logs", "tmp"] as const;

export async function prepareManagedQoderConfig({
  sessionDir,
  env,
  logger,
}: PrepareManagedQoderConfigOptions): Promise<string> {
  const configDir = join(sessionDir, "config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await Promise.all(
    PRIVATE_STATE_DIRECTORIES.map(async (directory) => {
      await mkdir(join(configDir, directory), { recursive: true, mode: 0o700 });
    }),
  );

  const targetAuth = join(configDir, ".auth");
  try {
    await access(targetAuth);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    const sourceAuth = join(resolveSharedQoderConfigDir(env), ".auth");
    try {
      await cp(sourceAuth, targetAuth, {
        recursive: true,
        dereference: true,
        errorOnExist: true,
        force: false,
      });
    } catch (copyError) {
      if (!isNotFoundError(copyError)) {
        logger.warn(
          "runtime.qodercli_auth_snapshot_failed",
          "Qoder CLI managed config could not snapshot the local login state",
          { error: copyError },
        );
      }
    }
  }

  return configDir;
}

function resolveSharedQoderConfigDir(env: NodeJS.ProcessEnv | undefined): string {
  const explicit = readNonEmpty(env?.["QODER_CONFIG_DIR"]);
  if (explicit !== undefined) return explicit;
  const qoderHome =
    readNonEmpty(env?.["QODER_CLI_HOME"]) ??
    readNonEmpty(process.env["QODER_CLI_HOME"]) ??
    homedir();
  return join(qoderHome, ".qoder");
}

function readNonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function isNotFoundError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
