import {
  runRuntimeCommand,
  type RuntimeCanUseResult,
  type RuntimeCommandSpawn,
} from "@pragma/core";
import { BoundedLruCache } from "@pragma/shared";

import { resolveAntigravityExecutablePath } from "./executable.ts";
import type { AntigravityRuntimeAdapterOptions } from "./types.ts";

export const MINIMUM_ANTIGRAVITY_CLI_VERSION = "1.1.11";

const CACHE_TTL_MS = 60_000;
const cache = new BoundedLruCache<string, { expiresAt: number; result: RuntimeCanUseResult }>(64);
const refreshes = new Map<string, Promise<RuntimeCanUseResult>>();
const spawnIds = new WeakMap<RuntimeCommandSpawn, number>();
let nextSpawnId = 1;

export async function canUseAntigravityRuntime(
  options: AntigravityRuntimeAdapterOptions & { readonly forceRefresh?: boolean } = {},
): Promise<RuntimeCanUseResult> {
  const executablePath = resolveAntigravityExecutablePath(options);
  const key = [
    executablePath,
    options.env?.["PATH"] ?? "",
    options.spawn === undefined ? "native" : `custom:${spawnId(options.spawn)}`,
  ].join("\0");
  if (options.forceRefresh) {
    cache.delete(key);
  } else {
    const cached = cache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.result;
  }
  const active = refreshes.get(key);
  if (active !== undefined) return await active;

  const refresh = probeAntigravityVersion(executablePath, options).then((result) => {
    if (result.usable) {
      cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result });
    } else {
      cache.delete(key);
    }
    return result;
  });
  refreshes.set(key, refresh);
  const clear = (): void => {
    if (refreshes.get(key) === refresh) refreshes.delete(key);
  };
  void refresh.then(clear, clear);
  return await refresh;
}

async function probeAntigravityVersion(
  executablePath: string,
  options: AntigravityRuntimeAdapterOptions,
): Promise<RuntimeCanUseResult> {
  try {
    const result = await runRuntimeCommand({
      executablePath,
      args: ["--version"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(options.env ?? {}),
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      },
      timeoutMs: 5_000,
      spawn: options.spawn,
    });
    const versionText = firstNonEmptyLine(result.stdout) ?? firstNonEmptyLine(result.stderr);
    const version = parseSemanticVersion(versionText);
    const details = {
      executablePath,
      ...(versionText === undefined ? {} : { version: versionText }),
      ...(version === undefined ? {} : { parsedVersion: version.join(".") }),
    };

    if (result.exitCode !== 0) {
      return {
        usable: false,
        reason: `Antigravity CLI probe failed with exit code ${result.exitCode ?? "null"}.`,
        details: { ...details, stderr: result.stderr },
      };
    }
    if (version === undefined) {
      return {
        usable: false,
        reason: `Antigravity CLI returned an unrecognized version. Install agy ${MINIMUM_ANTIGRAVITY_CLI_VERSION} or newer.`,
        details,
      };
    }
    if (compareVersions(version, [1, 1, 11]) < 0) {
      return {
        usable: false,
        reason: `Antigravity CLI ${version.join(".")} is unsupported. Upgrade to ${MINIMUM_ANTIGRAVITY_CLI_VERSION} or newer.`,
        details,
      };
    }
    return { usable: true, details };
  } catch (error) {
    return {
      usable: false,
      reason: `Antigravity CLI is not available at "${executablePath}": ${errorMessage(error)}`,
      details: { executablePath },
    };
  }
}

export function parseAntigravityVersion(value: string | undefined): string | undefined {
  const version = parseSemanticVersion(value);
  return version?.join(".");
}

function parseSemanticVersion(value: string | undefined): [number, number, number] | undefined {
  const match = value?.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\b|[-+])/);
  if (match == null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: readonly number[], right: readonly number[]): -1 | 0 | 1 {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference < 0) return -1;
    if (difference > 0) return 1;
  }
  return 0;
}

function spawnId(spawn: RuntimeCommandSpawn): number {
  let id = spawnIds.get(spawn);
  if (id === undefined) {
    id = nextSpawnId++;
    spawnIds.set(spawn, id);
  }
  return id;
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
