import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import JSON5 from "json5";

import type { OpenCodeMajor } from "./process.ts";

const TRUSTED_MODEL_KEYS = [
  "provider",
  "providers",
  "model",
  "small_model",
  "enabled_providers",
  "disabled_providers",
] as const;
const PROJECT_SELECTOR_KEYS = ["model", "small_model"] as const;
const PROJECT_PROVIDER_LIST_KEYS = ["enabled_providers", "disabled_providers"] as const;

/** Import host model configuration and project selectors into a private native config. */
export async function prepareOpenCodeConfiguration(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly workspace: string;
  readonly sessionDir: string;
  readonly major: OpenCodeMajor;
}): Promise<{
  env: NodeJS.ProcessEnv;
  deniedPermissions: readonly { action: string; resource: string; effect: "deny" }[];
}> {
  const privateConfigHome = join(input.sessionDir, "config");
  await mkdir(join(privateConfigHome, "opencode"), { recursive: true, mode: 0o700 });
  const config: Record<string, unknown> = {};
  const hostConfigHome = input.env["XDG_CONFIG_HOME"] ?? join(requiredHome(input.env), ".config");
  const trustedCandidates = [
    join(hostConfigHome, "opencode", "opencode.json"),
    join(hostConfigHome, "opencode", "opencode.jsonc"),
    ...(input.env["OPENCODE_CONFIG"] === undefined ? [] : [input.env["OPENCODE_CONFIG"]]),
    ...(input.env["OPENCODE_CONFIG_DIR"] === undefined
      ? []
      : [
          join(input.env["OPENCODE_CONFIG_DIR"], "opencode.json"),
          join(input.env["OPENCODE_CONFIG_DIR"], "opencode.jsonc"),
        ]),
  ];
  for (const path of trustedCandidates) {
    const content = await readConfig(path);
    if (content !== undefined) importTrustedHostConfig(config, JSON5.parse(content), path);
  }
  const ancestors = workspaceAncestors(input.workspace);
  for (const directory of ancestors) {
    if (await exists(join(directory, ".opencode"))) {
      throw new Error(
        `OpenCode workspace customization is not governed by Pragma: ${join(directory, ".opencode")}`,
      );
    }
    for (const path of [join(directory, "opencode.json"), join(directory, "opencode.jsonc")]) {
      const content = await readConfig(path);
      if (content !== undefined) importUntrustedProjectConfig(config, JSON5.parse(content), path);
    }
  }
  const inline = input.env["OPENCODE_CONFIG_CONTENT"];
  if (inline !== undefined)
    importTrustedHostConfig(config, JSON5.parse(inline), "OPENCODE_CONFIG_CONTENT");

  const deniedPermissions = Array.isArray(config["permissions"])
    ? (config["permissions"] as { action: string; resource: string; effect: "deny" }[])
    : [];
  return {
    deniedPermissions,
    env: {
      ...input.env,
      XDG_CONFIG_HOME: privateConfigHome,
      OPENCODE_CONFIG_DIR: join(privateConfigHome, "opencode"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      OPENCODE_CONFIG: undefined,
      OPENCODE_PERMISSION: undefined,
    },
  };
}

function importTrustedHostConfig(
  target: Record<string, unknown>,
  raw: unknown,
  source: string,
): void {
  const config = configObject(raw, source);
  for (const key of TRUSTED_MODEL_KEYS) {
    if (config[key] !== undefined) target[key] = config[key];
  }
  importDenials(target, config);
}

function importUntrustedProjectConfig(
  target: Record<string, unknown>,
  raw: unknown,
  source: string,
): void {
  const config = configObject(raw, source);
  for (const key of PROJECT_SELECTOR_KEYS) {
    const value = config[key];
    if (value === undefined) continue;
    if (!isPlainSelector(value)) throw new Error(`Unsafe OpenCode project ${key}: ${source}`);
    target[key] = value;
  }
  for (const key of PROJECT_PROVIDER_LIST_KEYS) {
    const value = config[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every(isPlainSelector)) {
      throw new Error(`Unsafe OpenCode project ${key}: ${source}`);
    }
    target[key] = value;
  }
  importDenials(target, config);
}

function isPlainSelector(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[{}\r\n]/.test(value);
}

function configObject(raw: unknown, source: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`OpenCode configuration must be an object: ${source}`);
  }
  return raw as Record<string, unknown>;
}

function importDenials(target: Record<string, unknown>, config: Record<string, unknown>): void {
  // Preserve explicit denials as data. Positive grants never cross this boundary.
  if (config["permission"] === "deny") target["permission"] = { "*": "deny" };
  const permission = asObject(config["permission"]);
  if (permission !== undefined) {
    const denied: Record<string, unknown> = {};
    for (const [action, value] of Object.entries(permission)) {
      if (value === "deny") denied[action] = "deny";
      else {
        const patterns = asObject(value);
        if (patterns !== undefined) {
          const entries = Object.entries(patterns).filter(([, effect]) => effect === "deny");
          if (entries.length > 0) denied[action] = Object.fromEntries(entries);
        }
      }
    }
    const accumulated = { ...asObject(target["permission"]) };
    for (const [action, value] of Object.entries(denied)) {
      accumulated[action] =
        value === "deny" || accumulated[action] === "deny"
          ? "deny"
          : { ...asObject(accumulated[action]), ...asObject(value) };
    }
    target["permission"] = accumulated;
  }
  const permissions = config["permissions"];
  if (Array.isArray(permissions)) {
    const previous = Array.isArray(target["permissions"]) ? target["permissions"] : [];
    target["permissions"] = [
      ...previous,
      ...permissions.filter((rule) => {
        const entry = asObject(rule);
        return (
          entry?.["effect"] === "deny" &&
          typeof entry["action"] === "string" &&
          typeof entry["resource"] === "string"
        );
      }),
    ];
  }
  const policies = asObject(config["experimental"])?.["policies"];
  if (Array.isArray(policies)) {
    const previous = asObject(target["experimental"]);
    const retained = Array.isArray(previous?.["policies"]) ? previous["policies"] : [];
    target["experimental"] = {
      policies: [
        ...retained,
        ...policies.filter((rule) => {
          const entry = asObject(rule);
          return (
            entry?.["effect"] === "deny" &&
            typeof entry["action"] === "string" &&
            typeof entry["resource"] === "string"
          );
        }),
      ],
    };
  }
}

async function readConfig(path: string): Promise<string | undefined> {
  return await readFile(path, "utf8").catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
}

function workspaceAncestors(workspace: string): string[] {
  const paths: string[] = [];
  let current = resolve(workspace);
  while (true) {
    paths.unshift(current);
    const parent = dirname(current);
    if (parent === current) return paths;
    current = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function requiredHome(env: NodeJS.ProcessEnv): string {
  const home = env["HOME"] ?? env["USERPROFILE"];
  if (home === undefined) throw new Error("OpenCode HOME is unavailable.");
  return home;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
