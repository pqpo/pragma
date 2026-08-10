import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runRuntimeCommand, type RuntimeCommandSpawn, type RuntimeModel } from "@pragma/core";

import {
  applyCommonAntigravityEnvironment,
  deleteEnvironmentValue,
} from "./environment-variables.ts";
import { resolveAntigravityExecutablePath } from "./executable.ts";
import type { AntigravityRuntimeAdapterOptions } from "./types.ts";

const MODEL_CATALOG_TTL_MS = 10 * 60_000;
const MODEL_CATALOG_CACHE_LIMIT = 16;
const MODEL_OUTPUT_LIMIT = 64 * 1024;
const KNOWN_EFFORT_LEVELS = new Set(["low", "medium", "high"]);

interface AntigravityModelCatalogCacheEntry {
  cache?: { readonly expiresAt: number; readonly models: readonly RuntimeModel[] } | undefined;
  refresh?: Promise<readonly RuntimeModel[]> | undefined;
}

const modelCatalogs = new Map<string, AntigravityModelCatalogCacheEntry>();
const spawnIds = new WeakMap<RuntimeCommandSpawn, number>();
let nextSpawnId = 1;

export function createAntigravityModelDiscovery(
  options: AntigravityRuntimeAdapterOptions,
): () => Promise<readonly RuntimeModel[]> {
  const key = modelCatalogCacheKey(options);
  const existing = modelCatalogs.get(key);
  const state: AntigravityModelCatalogCacheEntry = existing ?? {};
  if (existing === undefined) {
    modelCatalogs.set(key, state);
    while (modelCatalogs.size > MODEL_CATALOG_CACHE_LIMIT) {
      const oldest = modelCatalogs.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === key) break;
      modelCatalogs.delete(oldest);
    }
  } else {
    modelCatalogs.delete(key);
    modelCatalogs.set(key, state);
  }

  return async () => {
    if (state.cache === undefined) {
      state.refresh ??= refreshCatalog();
      return await state.refresh;
    }
    if (state.cache.expiresAt <= Date.now() && state.refresh === undefined) {
      state.refresh = refreshCatalog();
      void state.refresh.then(
        () => notifyModelCatalogUpdated(options.onModelCatalogUpdated),
        () => undefined,
      );
    }
    return state.cache.models;

    async function refreshCatalog(): Promise<readonly RuntimeModel[]> {
      const discoveryHome = await mkdtemp(join(tmpdir(), "pragma-agy-models-"));
      try {
        const discoveryTmp = join(discoveryHome, "tmp");
        await mkdir(discoveryTmp, { recursive: true, mode: 0o700 });
        const executablePath = resolveAntigravityExecutablePath(options);
        const result = await runRuntimeCommand({
          executablePath,
          args: ["models"],
          cwd: discoveryHome,
          env: createAntigravityModelDiscoveryEnvironment({
            base: { ...process.env, ...(options.env ?? {}) },
            tmpDir: discoveryTmp,
          }),
          timeoutMs: 20_000,
          outputLimit: MODEL_OUTPUT_LIMIT,
          spawn: options.spawn,
        });
        if (result.exitCode !== 0) {
          throw new Error(modelDiscoveryError(result.stderr || result.stdout));
        }
        const models = parseAntigravityModels(result.stdout);
        if (models.length === 0) {
          throw new Error("Antigravity CLI model discovery returned no models.");
        }
        state.cache = { expiresAt: Date.now() + MODEL_CATALOG_TTL_MS, models };
        return models;
      } finally {
        state.refresh = undefined;
        await rm(discoveryHome, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };
}

function createAntigravityModelDiscoveryEnvironment(options: {
  readonly base: Readonly<NodeJS.ProcessEnv>;
  readonly tmpDir: string;
  readonly platform?: NodeJS.Platform | undefined;
}): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const env: NodeJS.ProcessEnv = { ...options.base };

  // Model discovery must see the host's HOME/config paths because agy resolves
  // the signed-in account and onboarding/project selection from that profile.
  // Only discard volatile variables belonging to an already-running
  // Antigravity session; inheriting those could attach discovery to an IDE or
  // Runtime sidecar. Runtime execution still uses its fully private HOME.
  for (const key of [
    "ANTIGRAVITY_AGENTAPI_EXE",
    "ANTIGRAVITY_CONVERSATION_ID",
    "ANTIGRAVITY_CSRF_TOKEN",
    "ANTIGRAVITY_EXECUTABLE_DATA_DIR",
    "ANTIGRAVITY_LS_ADDRESS",
    "ANTIGRAVITY_PROJECT_ID",
    "ANTIGRAVITY_SIDECAR_UI_TOKEN",
    "ANTIGRAVITY_SIDECAR_WEB_PORT",
    "GOOGLE_LOG_DIR",
    "GOOGLE_STATUS_DIR",
    "PRAGMA_AGY_HOOK_URL",
    "PRAGMA_AGY_HOOK_AUTHORIZATION",
    "ELECTRON_RUN_AS_NODE",
  ]) {
    deleteEnvironmentValue(env, key, platform);
  }

  applyCommonAntigravityEnvironment({ env, tmpDir: options.tmpDir, platform });
  return env;
}

export function parseAntigravityModels(output: string): readonly RuntimeModel[] {
  const seen = new Set<string>();
  const models: RuntimeModel[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    const selectedByMarker = /^\s*[✓✔>]\s*/.test(rawLine);
    const selectedBySuffix = modelHasSelectionSuffix(rawLine);
    const line = stripModelStatusSuffix(
      rawLine.replace(/^\s*(?:[-*•]|\d+[.)]|[✓✔>])\s*/, "").trim(),
    );
    if (
      line === "" ||
      /^(?:fetching\b.*|available\s+models?|models?)\s*:?$/i.test(line) ||
      /^error\s*:/i.test(line)
    ) {
      continue;
    }

    const fields = line.split(/\t+|\s{2,}|\s+[-–—]\s+/).map((value) => value.trim());
    const firstField = fields[0];
    if (firstField === undefined) continue;
    const machineId = normalizeMachineModelId(firstField);
    const id = machineId ?? firstField;
    if (seen.has(id)) continue;
    seen.add(id);
    const displayName =
      machineId === undefined
        ? firstField
        : (fields.slice(1).find((value) => !isMetadataField(value) && !value.includes(id)) ??
          humanizeModelId(id));
    models.push({
      // Treat the selector printed by agy as opaque. Current releases print
      // stable user-facing slugs, while older releases and wrappers may print
      // human-facing values such as "Gemini 3.5 Flash (High)". Never invent a
      // provider slug from either shape: an unknown --model fails headless runs.
      id,
      displayName,
      provider: {
        kind: "runtime-managed",
        id: "antigravity",
        displayName: "Antigravity",
      },
      inputModalities: ["text"],
      ...(selectedByMarker || selectedBySuffix || isDefaultModelLine(fields)
        ? { default: true }
        : {}),
      ...readThinkingLevels(line),
    });
  }

  return models;
}

export function assertAntigravityModelSelection(
  models: readonly RuntimeModel[],
  modelName: string | undefined,
  thinkingLevel: string | undefined,
): void {
  if (modelName === undefined) {
    if (thinkingLevel !== undefined && !KNOWN_EFFORT_LEVELS.has(thinkingLevel)) {
      throw new Error(`Antigravity reasoning effort is unavailable: ${thinkingLevel}.`);
    }
    return;
  }
  const model = models.find((candidate) => candidate.id === modelName);
  if (model === undefined) {
    throw new Error(`Antigravity model is unavailable: ${modelName}.`);
  }
  if (thinkingLevel === undefined) return;
  const advertisedLevels = model.thinking?.supportedLevels;
  if (
    !(advertisedLevels ?? []).some((level) => level.value === thinkingLevel) &&
    (advertisedLevels !== undefined || !KNOWN_EFFORT_LEVELS.has(thinkingLevel))
  ) {
    throw new Error(
      `Antigravity reasoning effort is unavailable for ${modelName}: ${thinkingLevel}.`,
    );
  }
}

function modelHasSelectionSuffix(value: string): boolean {
  if (/\b(?:low|medium|high)\s*\((?:default|selected|current)\)\s*$/i.test(value)) {
    return false;
  }
  return /\s+(?:(?:default|selected|current)|\[(?:default|selected|current)\]|\((?:default|selected|current)\))\s*$/i.test(
    value,
  );
}

function modelCatalogCacheKey(options: AntigravityRuntimeAdapterOptions): string {
  return createHash("sha256")
    .update("pragma.antigravity-model-catalog/v1\0")
    .update(resolveAntigravityExecutablePath(options))
    .update("\0")
    .update(options.spawn === undefined ? "native" : `custom:${spawnId(options.spawn)}`)
    .update("\0")
    .update(
      JSON.stringify(
        Object.entries(options.env ?? {}).toSorted(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("hex");
}

function spawnId(spawn: RuntimeCommandSpawn): number {
  let id = spawnIds.get(spawn);
  if (id === undefined) {
    id = nextSpawnId++;
    spawnIds.set(spawn, id);
  }
  return id;
}

function normalizeMachineModelId(value: string): string | undefined {
  const candidate = value.trim().replace(/^[('"[]+|[)'",;:\]]+$/g, "");
  return /^[a-z0-9][a-z0-9._-]{2,}$/i.test(candidate) &&
    /[a-z]/i.test(candidate) &&
    /[-_.]/.test(candidate) &&
    !/^(?:https?|error|fetching|available|models?)[-_.]/i.test(candidate)
    ? candidate
    : undefined;
}

function isMetadataField(value: string): boolean {
  return /^(?:(?:effort|thinking|reasoning)\s*[:=]?\s*)?(?:default|selected|current|low|medium|high)(?:\s*(?:\(default\)|\[default\]))?(?:\s*[,/|]\s*(?:low|medium|high)(?:\s*(?:\(default\)|\[default\]))?)*$/i.test(
    value,
  );
}

function humanizeModelId(id: string): string {
  return id
    .split(/[-_.]+/)
    .map((part) =>
      part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase()}${part.slice(1)}`,
    )
    .join(" ");
}

function isDefaultModelLine(fields: readonly string[]): boolean {
  return fields.slice(1).some((field) => /^(?:default|selected|current)$/i.test(field));
}

function stripModelStatusSuffix(value: string): string {
  return value
    .replace(
      /\s+(?:(?:default|selected|current)|\[(?:default|selected|current)\]|\((?:default|selected|current)\))$/i,
      "",
    )
    .trim();
}

function readThinkingLevels(line: string): Pick<RuntimeModel, "thinking"> | Record<string, never> {
  const values = ["low", "medium", "high"].filter((level) =>
    new RegExp(`(?:effort|thinking|reasoning)?[^\\n]{0,24}\\b${level}\\b`, "i").test(line),
  );
  if (
    values.length === 0 ||
    (values.length === 1 && !/\b(?:effort|thinking|reasoning)\b/i.test(line))
  ) {
    return {};
  }
  const defaultLevel = readDefaultThinkingLevel(line);
  return {
    thinking: {
      supportedLevels: values.map((value) => ({
        value,
        label: `${value[0]?.toUpperCase()}${value.slice(1)}`,
      })),
      ...(defaultLevel === undefined ? {} : { defaultLevel }),
    },
  };
}

function readDefaultThinkingLevel(line: string): string | undefined {
  return (
    line.match(/\b(low|medium|high)\s*(?:\(default\)|\[default\])/i)?.[1]?.toLowerCase() ??
    line
      .match(/\bdefault(?:\s+(?:effort|thinking|reasoning))?\s*[:=]?\s*(low|medium|high)\b/i)?.[1]
      ?.toLowerCase()
  );
}

function modelDiscoveryError(output: string): string {
  if (/sign in|not logged|authentication/i.test(output)) {
    return "Antigravity CLI is not signed in. Run agy interactively once, or provide an explicit supported authentication environment.";
  }
  return `Antigravity CLI model discovery failed: ${output.trim() || "unknown error"}`;
}

function notifyModelCatalogUpdated(listener: (() => void) | undefined): void {
  try {
    listener?.();
  } catch {
    // Host cache invalidation is best-effort.
  }
}
