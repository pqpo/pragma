import { runRuntimeCommand } from "@pragma/core/runtime/process-probe";
import type {
  RuntimeDriverSessionRequest,
  RuntimeModel,
  RuntimeThinkingLevel,
} from "@pragma/core/runtime/runtime-adapter";

import { resolveCodexExecutablePath } from "./executable.ts";
import type { CodexRuntimeAdapterOptions } from "./types.ts";

interface CodexDebugModelsResponse {
  readonly models?: readonly CodexDebugModel[] | undefined;
}

interface CodexDebugModel {
  readonly slug?: string | undefined;
  readonly display_name?: string | undefined;
  readonly default_reasoning_level?: string | undefined;
  readonly supported_reasoning_levels?:
    | readonly {
        readonly effort?: string | undefined;
        readonly description?: string | undefined;
      }[]
    | undefined;
  readonly priority?: number | undefined;
  readonly visibility?: string | undefined;
}

interface CatalogCacheEntry {
  readonly expiresAt: number;
  readonly models: readonly RuntimeModel[];
}

const DISCOVERY_TTL_MS = 10 * 60 * 1_000;
const DISCOVERY_OUTPUT_LIMIT = 16 * 1024 * 1024;
const catalogCache = new Map<string, CatalogCacheEntry>();

const THINKING_LEVEL_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

export function createCodexModelDiscovery(
  options: CodexRuntimeAdapterOptions,
): () => Promise<readonly RuntimeModel[]> {
  return async () => {
    const executablePath =
      options.executablePath ??
      (options.spawn === undefined ? resolveCodexExecutablePath(options) : "codex");
    const env = { ...process.env, ...(options.env ?? {}) };
    const versionResult = await runRuntimeCommand({
      executablePath,
      args: ["--version"],
      cwd: process.cwd(),
      env,
      timeoutMs: 5_000,
      outputLimit: 64 * 1024,
      spawn: options.spawn,
    });

    if (versionResult.exitCode !== 0) {
      throw new Error(createDiscoveryError("version probe failed", versionResult.stderr));
    }

    const version = firstNonEmptyLine(versionResult.stdout) ?? "unknown";
    const cacheKey = `${executablePath}\u0000${version}`;
    const cached = catalogCache.get(cacheKey);

    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.models;
    }

    const result = await runRuntimeCommand({
      executablePath,
      args: ["debug", "models", "--bundled"],
      cwd: process.cwd(),
      env,
      timeoutMs: 15_000,
      outputLimit: DISCOVERY_OUTPUT_LIMIT,
      spawn: options.spawn,
    });

    if (result.exitCode !== 0) {
      throw new Error(createDiscoveryError("model discovery failed", result.stderr));
    }

    const models = parseCodexModels(result.stdout);
    if (models.length === 0) {
      throw new Error("Codex model discovery returned no supported models.");
    }

    catalogCache.set(cacheKey, {
      expiresAt: Date.now() + DISCOVERY_TTL_MS,
      models,
    });
    return models;
  };
}

export function parseCodexModels(output: string): readonly RuntimeModel[] {
  let response: CodexDebugModelsResponse;

  try {
    response = JSON.parse(output) as CodexDebugModelsResponse;
  } catch {
    return [];
  }

  const visibleModels = (response.models ?? []).filter(
    (model): model is CodexDebugModel & { readonly slug: string } =>
      typeof model.slug === "string" && model.slug.trim() !== "" && model.visibility !== "hide",
  );
  const defaultModel = visibleModels.reduce<CodexDebugModel | undefined>((current, model) => {
    if (current === undefined) {
      return model;
    }
    return (model.priority ?? Number.MAX_SAFE_INTEGER) <
      (current.priority ?? Number.MAX_SAFE_INTEGER)
      ? model
      : current;
  }, undefined);

  return visibleModels.map((model) => {
    const levels = (model.supported_reasoning_levels ?? []).flatMap((level) => {
      const value = level.effort?.trim();
      if (value === undefined || value === "") {
        return [];
      }
      return [
        {
          value,
          label: THINKING_LEVEL_LABELS[value] ?? toDisplayLabel(value),
          ...(level.description === undefined ? {} : { description: level.description }),
        } satisfies RuntimeThinkingLevel,
      ];
    });
    const defaultLevel = levels.some((level) => level.value === model.default_reasoning_level)
      ? model.default_reasoning_level
      : undefined;

    return {
      id: model.slug,
      displayName: model.display_name?.trim() || model.slug,
      provider: "openai",
      ...(model === defaultModel ? { default: true } : {}),
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

export function assertCodexProviderConfig(request: RuntimeDriverSessionRequest): void {
  if ((request.models?.length ?? 0) > 0 || (request.agent.models?.providers.length ?? 0) > 0) {
    throw new Error(
      "Codex runtime does not accept custom model providers; configure authentication in the local Codex CLI.",
    );
  }
}

export function assertCodexModelSelection(
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
        ? `Codex thinking level "${thinkingLevel}" cannot be validated because the discovered catalog has no default model.`
        : `Unsupported Codex model "${modelName}".`,
    );
  }

  if (
    thinkingLevel !== undefined &&
    !model.thinking?.supportedLevels.some((level) => level.value === thinkingLevel)
  ) {
    throw new Error(`Unsupported Codex thinking level "${thinkingLevel}" for model "${model.id}".`);
  }
}

function createDiscoveryError(summary: string, stderr: string): string {
  const detail = firstNonEmptyLine(stderr);
  return `Codex ${summary}${detail === undefined ? "." : `: ${detail}`}`;
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
