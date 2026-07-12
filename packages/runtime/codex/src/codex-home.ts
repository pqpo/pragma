import { access, copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { Expert } from "@pragma/core";
import type { ExpertAgentLogger } from "@pragma/core";
import { materializeCodexSkills } from "./skills.ts";

export interface PrepareManagedCodexHomeOptions {
  readonly agent: Expert;
  readonly sessionDir: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly logger: Pick<ExpertAgentLogger, "warn">;
}

const CODEX_COPIED_FILES = ["config.json", "config.toml", "instructions.md"] as const;

export async function prepareManagedCodexHome({
  agent,
  sessionDir,
  env,
  logger,
}: PrepareManagedCodexHomeOptions): Promise<string> {
  const codexHome = join(sessionDir, "home");
  const sharedCodexHome = resolveSharedCodexHome(env);

  await mkdir(codexHome, { recursive: true });
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  await exposeSharedAuth(sharedCodexHome, codexHome, logger);
  await copySharedConfigFiles(sharedCodexHome, codexHome, logger);
  await materializeCodexSkills({ agent, codexHome });

  return codexHome;
}

function resolveSharedCodexHome(env: NodeJS.ProcessEnv | undefined): string {
  return env?.CODEX_HOME ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
}

async function exposeSharedAuth(
  sharedCodexHome: string,
  codexHome: string,
  logger: Pick<ExpertAgentLogger, "warn">,
): Promise<void> {
  const source = join(sharedCodexHome, "auth.json");
  const target = join(codexHome, "auth.json");

  try {
    await access(source);
    await replaceSymlink(source, target, "file");
  } catch (error) {
    if (!isNotFoundError(error)) {
      logger.warn("Codex managed home could not expose shared auth", { error });
    }
  }
}

async function copySharedConfigFiles(
  sharedCodexHome: string,
  codexHome: string,
  logger: Pick<ExpertAgentLogger, "warn">,
): Promise<void> {
  for (const file of CODEX_COPIED_FILES) {
    const source = join(sharedCodexHome, file);
    const target = join(codexHome, file);

    try {
      await copyFile(source, target);
    } catch (error) {
      if (!isNotFoundError(error)) {
        logger.warn("Codex managed home could not copy shared config file", { file, error });
      }
    }
  }

  await sanitizeCopiedCodexConfig(join(codexHome, "config.toml"), logger);
}

async function sanitizeCopiedCodexConfig(
  configPath: string,
  logger: Pick<ExpertAgentLogger, "warn">,
): Promise<void> {
  let content: string;

  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (!isNotFoundError(error)) {
      logger.warn("Codex managed home could not read copied config.toml", { error });
    }
    return;
  }

  const sanitized = stripSkillsConfigEntries(content);

  if (sanitized === content) {
    return;
  }

  await writeFile(configPath, sanitized);
}

function stripSkillsConfigEntries(content: string): string {
  if (!content.includes("[[skills.config]]")) {
    return content;
  }

  const output: string[] = [];
  let inSkillsConfig = false;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.startsWith("#")) {
      if (!inSkillsConfig) {
        output.push(line);
      }
      continue;
    }

    if (trimmed.startsWith("[")) {
      if (trimmed === "[[skills.config]]") {
        inSkillsConfig = true;
        continue;
      }

      inSkillsConfig = false;
    }

    if (!inSkillsConfig) {
      output.push(line);
    }
  }

  return `${output.join("\n").trimEnd()}\n`;
}

async function replaceSymlink(source: string, target: string, type: "dir" | "file"): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await symlink(source, target, type);
}

function isNotFoundError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
