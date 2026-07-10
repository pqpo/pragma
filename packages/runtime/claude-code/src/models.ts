import type { RuntimeCreateSessionRequest, RuntimeModel, RuntimeThinkingLevel } from "@pragma/core";
import { runRuntimeCommand } from "@pragma/core";

import type { ClaudeCodeRuntimeAdapterOptions } from "./types.ts";

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

export function createClaudeCodeModelDiscovery(
  options: ClaudeCodeRuntimeAdapterOptions,
): () => Promise<readonly RuntimeModel[]> {
  return async () => {
    const executablePath = options.executablePath ?? "claude";
    const env = { ...process.env, ...(options.env ?? {}) };
    const versionResult = await runRuntimeCommand({
      executablePath,
      args: ["--version"],
      cwd: process.cwd(),
      env,
      timeoutMs: 5_000,
      outputLimit: 64 * 1024,
      spawn: options.spawn,
    }).catch(() => undefined);
    const version = firstNonEmptyLine(versionResult?.stdout ?? "") ?? "unknown";
    const cacheKey = `${executablePath}\u0000${version}`;
    const cached = catalogCache.get(cacheKey);

    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.models;
    }

    const helpResult = await runRuntimeCommand({
      executablePath,
      args: ["--help"],
      cwd: process.cwd(),
      env,
      timeoutMs: 5_000,
      outputLimit: 512 * 1024,
      spawn: options.spawn,
    }).catch(() => undefined);
    const effortLevels =
      helpResult?.exitCode === 0 ? parseClaudeEffortLevels(helpResult.stdout) : [];
    const models = buildClaudeModels(effortLevels);

    catalogCache.set(cacheKey, {
      expiresAt: Date.now() + DISCOVERY_TTL_MS,
      models,
    });
    return models;
  };
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
    const levels = effortLevels
      .filter(
        (value) =>
          definition.allowedThinkingLevels === undefined ||
          definition.allowedThinkingLevels.has(value),
      )
      .map(
        (value): RuntimeThinkingLevel => ({
          value,
          label: THINKING_LEVEL_LABELS[value] ?? toDisplayLabel(value),
        }),
      );
    const defaultLevel = levels.some((level) => level.value === "medium") ? "medium" : undefined;

    return {
      id: definition.id,
      displayName: definition.displayName,
      provider: "anthropic",
      ...(definition.default === true ? { default: true } : {}),
      ...(levels.length === 0
        ? {}
        : {
            thinking: {
              supportedLevels: levels,
              ...(defaultLevel === undefined ? {} : { defaultLevel }),
            },
          }),
    } satisfies RuntimeModel;
  });
}

export function assertClaudeCodeProviderConfig(request: RuntimeCreateSessionRequest): void {
  if ((request.models?.length ?? 0) > 0 || (request.agent.models?.providers.length ?? 0) > 0) {
    throw new Error(
      "Claude Code runtime does not accept custom model providers; configure authentication in the local Claude Code CLI.",
    );
  }
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

function toDisplayLabel(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
