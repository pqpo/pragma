import type { RuntimeModel, RuntimeThinkingLevel } from "@pragma/core";
import {
  ProcessTransport,
  query,
  type ModelInfo,
  type Query,
} from "@qoder-ai/qoder-agent-sdk";

import { resolveQoderCliExecutablePath } from "./executable.ts";
import { resolveQoderAuth } from "./sdk-options.ts";
import type { QoderCliRuntimeAdapterOptions } from "./types.ts";

const THINKING_LABELS: Readonly<Record<string, string>> = {
  none: "Disabled",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function createQoderCliModelDiscovery(
  options: QoderCliRuntimeAdapterOptions,
): () => Promise<readonly RuntimeModel[]> {
  let cache:
    | { readonly expiresAt: number; readonly models: readonly RuntimeModel[] }
    | undefined;
  let refresh: Promise<readonly RuntimeModel[]> | undefined;

  return async () => {
    if (cache === undefined) return await refreshCatalog();
    if (cache.expiresAt <= Date.now() && refresh === undefined) {
      refresh = refreshCatalog();
      void refresh.then(
        () => notifyModelCatalogUpdated(options.onModelCatalogUpdated),
        () => undefined,
      );
    }
    return cache.models;

    async function refreshCatalog(): Promise<readonly RuntimeModel[]> {
      let q: Query | undefined;
      try {
        q = query({
          prompt: "",
          options: {
            auth: resolveQoderAuth(options),
            transport: ProcessTransport.default,
            pathToQoderCLIExecutable: resolveQoderCliExecutablePath(options),
            env: { ...process.env, ...(options.env ?? {}) },
            settingSources: [],
            tools: [],
          },
        });
        const models = (await q.getAvailableModels({ fetchStrategy: "live" }))
          .filter((model) => model.isEnabled !== false)
          .map(mapQoderModel);
        if (models.length === 0) {
          throw new Error("Qoder CLI model discovery returned no enabled models.");
        }
        cache = { expiresAt: Date.now() + 10 * 60_000, models };
        return models;
      } finally {
        refresh = undefined;
        await q?.close().catch(() => undefined);
      }
    }
  };
}

function notifyModelCatalogUpdated(listener: (() => void) | undefined): void {
  try {
    listener?.();
  } catch {
    // Host cache invalidation is best-effort and must not fail a successful refresh.
  }
}

export function mapQoderModel(model: ModelInfo): RuntimeModel {
  const levels: RuntimeThinkingLevel[] = [];
  if (model.supportsDisabled === true) {
    levels.push({ value: "none", label: THINKING_LABELS["none"] ?? "Disabled" });
  }
  for (const effort of model.efforts ?? Object.keys(model.thinking_config?.enabled?.efforts ?? {})) {
    levels.push({
      value: effort,
      label: THINKING_LABELS[effort] ?? effort,
      description: model.thinking_config?.enabled?.efforts?.[effort]?.description,
    });
  }

  return {
    id: model.value,
    displayName: model.displayName,
    provider: { kind: "runtime-managed", id: "qoder", displayName: "Qoder" },
    ...(model.isDefault === true ? { default: true } : {}),
    ...(levels.length === 0
      ? {}
      : {
          thinking: {
            supportedLevels: levels,
            defaultLevel:
              model.defaultEffort ??
              Object.entries(model.thinking_config?.enabled?.efforts ?? {}).find(
                ([, entry]) => entry.is_default === true,
              )?.[0],
          },
        }),
  };
}

export function resolveQoderContextWindow(
  model: ModelInfo | undefined,
  override: number | undefined,
): number {
  const candidate =
    override ??
    model?.defaultContextWindow ??
    model?.availableContextWindows?.[0] ??
    model?.maxInputTokens ??
    Object.values(model?.context_config ?? {}).find((entry) => entry.is_default === true)
      ?.token_count ??
    Object.values(model?.context_config ?? {})[0]?.token_count;

  if (candidate === undefined || !Number.isFinite(candidate) || candidate <= 0) {
    throw new Error(
      `Qoder model ${model?.value ?? "(default)"} does not report a context window. ` +
        "Configure contextWindowTokens explicitly.",
    );
  }
  return Math.round(candidate);
}
