import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  parseRuntimeModelCatalogModels,
  readRuntimeModelCatalogCache,
  retryRuntimeModelDiscovery,
  writeRuntimeModelCatalogCache,
} from "@pragma/core";
import { runRuntimeCommand } from "@pragma/core/runtime/process-probe";
import type {
  RuntimeModel,
  RuntimeModelDiscoveryOptions,
  RuntimeThinkingLevel,
} from "@pragma/core/runtime/runtime-adapter";
import { BoundedLruCache } from "@pragma/shared";

import type { ClaudeCodeRuntimeAdapterOptions } from "./types.ts";
import { resolveClaudeCodeCommand } from "./executable.ts";

interface CatalogCacheEntry {
  readonly expiresAt: number;
  readonly retryAt?: number | undefined;
  readonly models: readonly RuntimeModel[];
}

interface CatalogRefreshResult {
  readonly models: readonly RuntimeModel[];
  readonly fresh: boolean;
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
const DISCOVERY_RETRY_DELAY_MS = 30 * 1_000;
const CATALOG_CACHE_CAPACITY = 64;
const catalogCache = new BoundedLruCache<string, CatalogCacheEntry>(CATALOG_CACHE_CAPACITY);
const catalogRefreshes = new Map<string, Promise<CatalogRefreshResult>>();
const customSpawnIds = new WeakMap<NonNullable<ClaudeCodeRuntimeAdapterOptions["spawn"]>, number>();
let nextCustomSpawnId = 1;
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
): (request?: RuntimeModelDiscoveryOptions) => Promise<readonly RuntimeModel[]> {
  return async (request = {}) => {
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
    const routing = await loadClaudeModelRoutingConfig(options.env);
    const cacheKey = discoveryCacheKey(
      executablePath,
      command.launcherArgs,
      routing.fingerprint,
      options.spawn,
      options.modelCatalogCacheRoot,
    );
    const cached = catalogCache.get(cacheKey);
    const persisted =
      cached === undefined || request.forceRefresh === true
        ? await readRuntimeModelCatalogCache(
            {
              runtimeId: "claude-code",
              cacheKey,
              cacheRoot: options.modelCatalogCacheRoot,
            },
            parseRuntimeModelCatalogModels,
          )
        : undefined;
    const fallback = cached?.models ?? persisted;

    if (request.forceRefresh === true) {
      const result = await refreshClaudeCodeModelCatalog({
        cacheKey,
        executablePath,
        launcherArgs: command.launcherArgs,
        env,
        options,
        routing,
        fallback,
      });
      if (result.fresh) notifyModelCatalogUpdated(options.onModelCatalogUpdated);
      return result.models;
    }

    if (cached !== undefined) {
      const now = Date.now();
      if (cached.expiresAt <= now && (cached.retryAt ?? 0) <= now) {
        const refresh = refreshClaudeCodeModelCatalog({
          cacheKey,
          executablePath,
          launcherArgs: command.launcherArgs,
          env,
          options,
          routing,
        });
        void refresh.then(
          (result) => {
            if (result.fresh) notifyModelCatalogUpdated(options.onModelCatalogUpdated);
          },
          () => undefined,
        );
      }
      return cached.models;
    }

    if (persisted !== undefined) {
      catalogCache.set(cacheKey, {
        expiresAt: Date.now(),
        models: persisted,
      });
      const refresh = refreshClaudeCodeModelCatalog({
        cacheKey,
        executablePath,
        launcherArgs: command.launcherArgs,
        env,
        options,
        routing,
        fallback: persisted,
      });
      void refresh.then(
        (result) => {
          if (result.fresh) notifyModelCatalogUpdated(options.onModelCatalogUpdated);
        },
        () => undefined,
      );
      return persisted;
    }

    return (
      await refreshClaudeCodeModelCatalog({
        cacheKey,
        executablePath,
        launcherArgs: command.launcherArgs,
        env,
        options,
        routing,
      })
    ).models;
  };
}

function refreshClaudeCodeModelCatalog(input: {
  readonly cacheKey: string;
  readonly executablePath: string;
  readonly launcherArgs: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly options: ClaudeCodeRuntimeAdapterOptions;
  readonly routing: ClaudeModelRoutingConfig;
  readonly fallback?: readonly RuntimeModel[] | undefined;
}): Promise<CatalogRefreshResult> {
  const activeRefresh = catalogRefreshes.get(input.cacheKey);
  if (activeRefresh !== undefined) return activeRefresh;

  const refresh = (async () => {
    try {
      const discoveredEffortLevels = await discoverClaudeEffortLevels(
        input.options,
        input.launcherArgs,
        input.executablePath,
        input.env,
      );
      if (
        discoveredEffortLevels === undefined &&
        (catalogCache.get(input.cacheKey)?.models ?? input.fallback) !== undefined
      ) {
        throw new Error("Claude Code effort-level discovery failed.");
      }
      const effortLevels = discoveredEffortLevels ?? [];
      const models = input.routing.mappedProvider
        ? buildClaudeMappedModels(input.routing, effortLevels)
        : buildClaudeModels(effortLevels);
      if (models.length === 0) {
        throw new Error("Claude Code model discovery returned no models.");
      }

      catalogCache.set(input.cacheKey, {
        expiresAt: Date.now() + DISCOVERY_TTL_MS,
        models,
      });
      await writeRuntimeModelCatalogCache(
        {
          runtimeId: "claude-code",
          cacheKey: input.cacheKey,
          cacheRoot: input.options.modelCatalogCacheRoot,
        },
        models,
      );
      return { models, fresh: true };
    } catch (error) {
      const fallback = catalogCache.get(input.cacheKey)?.models ?? input.fallback;
      if (fallback !== undefined) {
        catalogCache.set(input.cacheKey, {
          expiresAt: Date.now(),
          retryAt: Date.now() + DISCOVERY_RETRY_DELAY_MS,
          models: fallback,
        });
        return { models: fallback, fresh: false };
      }
      throw error;
    }
  })().catch((error: unknown) => {
    const cached = catalogCache.get(input.cacheKey);
    if (cached !== undefined) {
      catalogCache.set(input.cacheKey, {
        ...cached,
        retryAt: Date.now() + DISCOVERY_RETRY_DELAY_MS,
      });
    }
    throw error;
  });
  catalogRefreshes.set(input.cacheKey, refresh);
  void refresh.then(clearRefresh, clearRefresh);
  return refresh;

  function clearRefresh(): void {
    if (catalogRefreshes.get(input.cacheKey) === refresh) {
      catalogRefreshes.delete(input.cacheKey);
    }
  }
}

function notifyModelCatalogUpdated(listener: (() => void) | undefined): void {
  try {
    listener?.();
  } catch {
    // A host notification is best-effort and must not turn a successful refresh into a failure.
  }
}

function discoveryCacheKey(
  executablePath: string,
  launcherArgs: readonly string[],
  routingFingerprint: string,
  spawn: ClaudeCodeRuntimeAdapterOptions["spawn"],
  cacheRoot: string | undefined,
): string {
  const spawnId = customSpawnId(spawn);
  return [
    executablePath,
    JSON.stringify(launcherArgs),
    routingFingerprint,
    cacheRoot ?? "default",
    spawnId === undefined ? "" : `spawn:${spawnId}`,
  ].join("\u0000");
}

function customSpawnId(spawn: ClaudeCodeRuntimeAdapterOptions["spawn"]): number | undefined {
  if (spawn === undefined) return undefined;
  let spawnId = customSpawnIds.get(spawn);
  if (spawnId === undefined) {
    spawnId = nextCustomSpawnId;
    nextCustomSpawnId += 1;
    customSpawnIds.set(spawn, spawnId);
  }
  return spawnId;
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
        // A mapped endpoint may target a text-only model. Treat it as text-only
        // until its provider exposes authoritative modality metadata.
        inputModalities: ["text"],
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
      inputModalities: ["text", "image"],
      ...(definition.default === true ? { default: true } : {}),
      ...(thinking === undefined ? {} : { thinking }),
    } satisfies RuntimeModel;
  });
}

export function assertClaudeCodeModelSelection(
  models: readonly RuntimeModel[],
  modelName: string | undefined,
  thinkingLevel: string | undefined,
  providerId?: string | undefined,
): void {
  if (modelName === undefined && thinkingLevel === undefined && providerId === undefined) {
    return;
  }

  const model =
    modelName === undefined
      ? models.find(
          (candidate) =>
            candidate.default === true &&
            (providerId === undefined || candidate.provider.id === providerId),
        )
      : models.find(
          (candidate) =>
            candidate.id === modelName &&
            (providerId === undefined || candidate.provider.id === providerId),
        );

  if (model === undefined) {
    throw new Error(
      modelName === undefined
        ? `Claude Code thinking level "${thinkingLevel}" cannot be validated because the model catalog has no default model.`
        : `Unsupported Claude Code model "${
            providerId === undefined ? modelName : `${providerId}/${modelName}`
          }".`,
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

async function discoverClaudeEffortLevels(
  options: ClaudeCodeRuntimeAdapterOptions,
  launcherArgs: readonly string[],
  executablePath: string,
  env: NodeJS.ProcessEnv,
): Promise<readonly string[] | undefined> {
  const helpResult = await retryRuntimeModelDiscovery(async () => {
    const result = await runRuntimeCommand({
      executablePath,
      args: [...launcherArgs, "--help"],
      cwd: process.cwd(),
      env,
      timeoutMs: 5_000,
      outputLimit: 512 * 1024,
      spawn: options.spawn,
    });
    if (result.exitCode !== 0) {
      throw new Error("Claude Code help probe failed.");
    }
    return result;
  }).catch(() => undefined);
  return helpResult?.exitCode === 0 ? parseClaudeEffortLevels(helpResult.stdout) : undefined;
}

function buildThinkingConfig(
  effortLevels: readonly string[],
  allowedLevels?: ReadonlySet<string>,
): RuntimeModel["thinking"] | undefined {
  const levels = effortLevels
    .filter((value) => allowedLevels === undefined || allowedLevels.has(value))
    .map((value): RuntimeThinkingLevel => ({
      value,
      label: THINKING_LEVEL_LABELS[value] ?? toDisplayLabel(value),
    }));
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
