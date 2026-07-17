import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { runRuntimeCommand } from "@pragma/core/runtime/process-probe";
import type { RuntimeModel, RuntimeThinkingLevel } from "@pragma/core/runtime/runtime-adapter";

import type { ClaudeCodeRuntimeAdapterOptions } from "./types.ts";
import { resolveClaudeCodeCommand } from "./executable.ts";

interface CatalogCacheEntry {
  readonly expiresAt: number;
  readonly models: readonly RuntimeModel[];
}

interface ClaudeModelDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly default?: boolean | undefined;
  readonly allowedThinkingLevels?: ReadonlySet<string> | undefined;
}

interface ClaudeModelRoutingConfig {
  readonly baseUrl?: string | undefined;
  readonly defaultModel?: string | undefined;
  readonly roleModels: Readonly<Record<ClaudeModelRole, string | undefined>>;
  readonly mappedProvider: boolean;
  readonly fingerprint: string;
}

type ClaudeModelRole = "sonnet" | "opus" | "haiku" | "fable";

const DISCOVERY_TTL_MS = 10 * 60 * 1_000;
const catalogCache = new Map<string, CatalogCacheEntry>();
const EFFORT_PATTERN = /--effort\s*(?:<[^>]+>)?\s*(?:Effort level[^(]*)?\(([^)]+)\)/;
const KNOWN_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LEVEL_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const CLAUDE_MODELS: readonly ClaudeModelDefinition[] = [
  { id: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    default: true,
    allowedThinkingLevels: new Set(["low", "medium", "high", "max"]),
  },
  { id: "claude-fable-5", displayName: "Claude Fable 5" },
  {
    id: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    allowedThinkingLevels: new Set(KNOWN_EFFORT_LEVELS),
  },
  {
    id: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    allowedThinkingLevels: new Set(KNOWN_EFFORT_LEVELS),
  },
  {
    id: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    allowedThinkingLevels: new Set(KNOWN_EFFORT_LEVELS),
  },
  {
    id: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    allowedThinkingLevels: new Set(["low", "medium", "high", "max"]),
  },
  {
    id: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    allowedThinkingLevels: new Set(["low", "medium", "high"]),
  },
  { id: "sonnet", displayName: "Latest Claude Sonnet" },
  { id: "opus", displayName: "Latest Claude Opus" },
  { id: "haiku", displayName: "Latest Claude Haiku" },
];
const CLAUDE_MODEL_ROLES: readonly ClaudeModelRole[] = ["sonnet", "opus", "haiku", "fable"];
const ROLE_MODEL_ENV_KEYS = {
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
} as const satisfies Readonly<Record<ClaudeModelRole, string>>;

export function createClaudeCodeModelDiscovery(
  options: ClaudeCodeRuntimeAdapterOptions,
): () => Promise<readonly RuntimeModel[]> {
  return async () => {
    const command =
      options.spawn === undefined
        ? resolveClaudeCodeCommand(options)
        : {
            executablePath: options.executablePath ?? "claude",
            launcherArgs: [] as readonly string[],
            sourcePath: options.executablePath ?? "claude",
          };
    const executablePath = command.executablePath;
    const env = { ...process.env, ...(options.env ?? {}) };
    const versionResult = await runRuntimeCommand({
      executablePath,
      args: [...command.launcherArgs, "--version"],
      cwd: process.cwd(),
      env,
      timeoutMs: 5_000,
      outputLimit: 64 * 1024,
      spawn: options.spawn,
    }).catch(() => undefined);
    const version = firstNonEmptyLine(versionResult?.stdout ?? "") ?? "unknown";
    const routing = await loadClaudeModelRoutingConfig(options.env);
    const cacheKey = `${executablePath}\u0000${version}\u0000${routing.fingerprint}`;
    const cached = catalogCache.get(cacheKey);

    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.models;
    }

    const effortLevels = await discoverClaudeEffortLevels(
      options,
      command.launcherArgs,
      executablePath,
      env,
    );
    const models = routing.mappedProvider
      ? buildClaudeMappedModels(routing, effortLevels)
      : buildClaudeModels(effortLevels);

    catalogCache.set(cacheKey, {
      expiresAt: Date.now() + DISCOVERY_TTL_MS,
      models,
    });
    return models;
  };
}

function buildClaudeMappedModels(
  routing: Pick<ClaudeModelRoutingConfig, "baseUrl" | "defaultModel" | "roleModels">,
  effortLevels: readonly string[],
): readonly RuntimeModel[] {
  let assignedDefault = false;
  const localRouting = isCcSwitchLocalRoutingUrl(routing.baseUrl);

  return CLAUDE_MODEL_ROLES.flatMap((role) => {
    const upstreamModel = routing.roleModels[role];
    if (upstreamModel === undefined && (!localRouting || role === "fable")) {
      return [];
    }

    const isDefault =
      !assignedDefault && upstreamModel !== undefined && upstreamModel === routing.defaultModel;
    assignedDefault ||= isDefault;
    const roleLabel = `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
    const mappingLabel = upstreamModel ?? "CC Switch local route";
    const thinking = buildThinkingConfig(effortLevels);

    return [
      {
        id: role,
        displayName: `${roleLabel} → ${mappingLabel}`,
        provider: {
          kind: "runtime-managed",
          id: "anthropic-compatible",
          displayName: "Anthropic-compatible",
        },
        ...(isDefault ? { default: true } : {}),
        ...(thinking === undefined ? {} : { thinking }),
      } satisfies RuntimeModel,
    ];
  });
}

export function parseClaudeEffortLevels(helpOutput: string): readonly string[] {
  const match = EFFORT_PATTERN.exec(helpOutput);
  if (match?.[1] !== undefined) {
    return [
      ...new Set(
        match[1]
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
  }

  return helpOutput.includes("--effort") ? KNOWN_EFFORT_LEVELS : [];
}

export function buildClaudeModels(effortLevels: readonly string[]): readonly RuntimeModel[] {
  return CLAUDE_MODELS.map((definition) => {
    const thinking = buildThinkingConfig(effortLevels, definition.allowedThinkingLevels);

    return {
      id: definition.id,
      displayName: definition.displayName,
      provider: { kind: "runtime-managed", id: "anthropic", displayName: "Anthropic" },
      ...(definition.default === true ? { default: true } : {}),
      ...(thinking === undefined ? {} : { thinking }),
    } satisfies RuntimeModel;
  });
}

export function assertClaudeCodeModelSelection(
  models: readonly RuntimeModel[],
  modelName: string | undefined,
  thinkingLevel: string | undefined,
): void {
  if (modelName === undefined && thinkingLevel === undefined) {
    return;
  }

  const model =
    modelName === undefined
      ? models.find((candidate) => candidate.default)
      : models.find((candidate) => candidate.id === modelName);

  if (model === undefined) {
    throw new Error(
      modelName === undefined
        ? `Claude Code thinking level "${thinkingLevel}" cannot be validated because the model catalog has no default model.`
        : `Unsupported Claude Code model "${modelName}".`,
    );
  }

  if (
    thinkingLevel !== undefined &&
    !model.thinking?.supportedLevels.some((level) => level.value === thinkingLevel)
  ) {
    throw new Error(
      `Unsupported Claude Code thinking level "${thinkingLevel}" for model "${model.id}".`,
    );
  }
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
}

async function discoverClaudeEffortLevels(
  options: ClaudeCodeRuntimeAdapterOptions,
  launcherArgs: readonly string[],
  executablePath: string,
  env: NodeJS.ProcessEnv,
): Promise<readonly string[]> {
  const helpResult = await runRuntimeCommand({
    executablePath,
    args: [...launcherArgs, "--help"],
    cwd: process.cwd(),
    env,
    timeoutMs: 5_000,
    outputLimit: 512 * 1024,
    spawn: options.spawn,
  }).catch(() => undefined);
  return helpResult?.exitCode === 0 ? parseClaudeEffortLevels(helpResult.stdout) : [];
}

function buildThinkingConfig(
  effortLevels: readonly string[],
  allowedLevels?: ReadonlySet<string>,
): RuntimeModel["thinking"] | undefined {
  const levels = effortLevels
    .filter((value) => allowedLevels === undefined || allowedLevels.has(value))
    .map(
      (value): RuntimeThinkingLevel => ({
        value,
        label: THINKING_LEVEL_LABELS[value] ?? toDisplayLabel(value),
      }),
    );
  if (levels.length === 0) {
    return undefined;
  }

  const defaultLevel = levels.some((level) => level.value === "medium") ? "medium" : undefined;
  return {
    supportedLevels: levels,
    ...(defaultLevel === undefined ? {} : { defaultLevel }),
  };
}

async function loadClaudeModelRoutingConfig(
  runtimeEnv: NodeJS.ProcessEnv | undefined,
): Promise<ClaudeModelRoutingConfig> {
  const configDir =
    readNonEmptyString(runtimeEnv?.["CLAUDE_CONFIG_DIR"]) ??
    readNonEmptyString(process.env["CLAUDE_CONFIG_DIR"]) ??
    join(homedir(), ".claude");
  const settingsEnv = await readClaudeSettingsEnv(join(configDir, "settings.json"));
  const effectiveEnv = {
    ...settingsEnv,
    ...pickClaudeModelEnv(process.env),
    ...pickClaudeModelEnv(runtimeEnv),
  };
  const baseUrl = readNonEmptyString(effectiveEnv["ANTHROPIC_BASE_URL"]);
  const defaultModel = readNonEmptyString(effectiveEnv["ANTHROPIC_MODEL"]);
  const roleModels = Object.fromEntries(
    CLAUDE_MODEL_ROLES.map((role) => [
      role,
      readNonEmptyString(effectiveEnv[ROLE_MODEL_ENV_KEYS[role]]),
    ]),
  ) as Record<ClaudeModelRole, string | undefined>;
  const mappedProvider =
    isNonClaudeModel(defaultModel) ||
    Object.values(roleModels).some(isNonClaudeModel) ||
    isCcSwitchLocalRoutingUrl(baseUrl);
  const fingerprint = JSON.stringify({ baseUrl, defaultModel, roleModels, mappedProvider });

  return { baseUrl, defaultModel, roleModels, mappedProvider, fingerprint };
}

async function readClaudeSettingsEnv(path: string): Promise<NodeJS.ProcessEnv> {
  const content = await readFile(path, "utf8").catch(() => undefined);
  if (content === undefined) {
    return {};
  }

  try {
    const settings = JSON.parse(content) as unknown;
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
      return {};
    }
    const env = (settings as Record<string, unknown>)["env"];
    return env === null || typeof env !== "object" || Array.isArray(env)
      ? {}
      : pickClaudeModelEnv(env as Record<string, unknown>);
  } catch {
    return {};
  }
}

function pickClaudeModelEnv(env: Readonly<Record<string, unknown>> | undefined): NodeJS.ProcessEnv {
  if (env === undefined) {
    return {};
  }

  const keys = ["ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", ...Object.values(ROLE_MODEL_ENV_KEYS)];
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = readNonEmptyString(env[key]);
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function isNonClaudeModel(value: string | undefined): boolean {
  return (
    value !== undefined &&
    !value.startsWith("claude-") &&
    value !== "default" &&
    !CLAUDE_MODEL_ROLES.includes(value as ClaudeModelRole)
  );
}

function isCcSwitchLocalRoutingUrl(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") &&
      url.port === "15721"
    );
  } catch {
    return false;
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function toDisplayLabel(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
