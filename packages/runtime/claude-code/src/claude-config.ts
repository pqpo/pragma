import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExpertAgentLogger } from "@pragma/core";

export interface ManagedClaudeCodeConfig {
  readonly configDir: string;
  readonly settingsPath?: string | undefined;
}

export interface PrepareManagedClaudeCodeConfigOptions {
  readonly sessionDir: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly logger: Pick<ExpertAgentLogger, "warn">;
}

const CLAUDE_COPIED_SETTINGS_FILES = [
  "settings.json",
  "settings.local.json",
  "managed-settings.json",
] as const;
const CLAUDE_LINKED_STATE_DIRS = ["projects", "session-env", "sessions"] as const;

export async function prepareManagedClaudeCodeConfig({
  sessionDir,
  env,
  logger,
}: PrepareManagedClaudeCodeConfigOptions): Promise<ManagedClaudeCodeConfig> {
  const configDir = join(sessionDir, "config");
  const sharedConfigDir = resolveSharedClaudeConfigDir(env);

  await mkdir(configDir, { recursive: true });
  await createPrivateStateDirs(configDir);
  const settingsPath = await copySharedSettingsFiles(sharedConfigDir, configDir, logger);

  return {
    configDir,
    ...(settingsPath === undefined ? {} : { settingsPath }),
  };
}

function resolveSharedClaudeConfigDir(env: NodeJS.ProcessEnv | undefined): string {
  const configDir = readNonEmptyEnvValue(env?.CLAUDE_CONFIG_DIR);
  if (configDir !== undefined) {
    return configDir;
  }

  if (env !== undefined) {
    return join(homedir(), ".claude");
  }

  return readNonEmptyEnvValue(process.env["CLAUDE_CONFIG_DIR"]) ?? join(homedir(), ".claude");
}

async function createPrivateStateDirs(configDir: string): Promise<void> {
  for (const dir of CLAUDE_LINKED_STATE_DIRS) {
    await mkdir(join(configDir, dir), { recursive: true });
  }
}

async function copySharedSettingsFiles(
  sharedConfigDir: string,
  configDir: string,
  logger: Pick<ExpertAgentLogger, "warn">,
): Promise<string | undefined> {
  let primarySettingsPath: string | undefined;

  for (const file of CLAUDE_COPIED_SETTINGS_FILES) {
    const source = join(sharedConfigDir, file);
    const target = join(configDir, file);

    try {
      await copyFile(source, target);
      if (file === "settings.json") {
        primarySettingsPath = target;
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        logger.warn("Claude Code managed config could not copy shared settings file", {
          file,
          error,
        });
      }
    }
  }

  return primarySettingsPath;
}

function readNonEmptyEnvValue(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function isNotFoundError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
