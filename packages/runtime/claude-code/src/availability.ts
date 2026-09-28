import { statSync } from "node:fs";
import { canUseRuntimeBinary } from "@pragma/core/runtime/process-probe";
import type { RuntimeCanUseResult } from "@pragma/core/runtime/runtime-adapter";
import { BoundedLruCache } from "@pragma/shared";
import { resolveClaudeAcpWorkerPath } from "./acp-executable.ts";
import { resolveClaudeCodeCommand } from "./executable.ts";
import type { ClaudeCodeRuntimeSpawn } from "./types.ts";

interface AvailabilityCacheEntry {
  readonly expiresAt: number;
  readonly result: RuntimeCanUseResult;
}

const AVAILABILITY_TTL_MS = 60 * 1_000;
const AVAILABILITY_CACHE_CAPACITY = 64;
const availabilityCache = new BoundedLruCache<string, AvailabilityCacheEntry>(
  AVAILABILITY_CACHE_CAPACITY,
);
const availabilityRefreshes = new Map<string, Promise<RuntimeCanUseResult>>();
const spawnIds = new WeakMap<NonNullable<ClaudeCodeRuntimeSpawn>, number>();
const environmentIds = new WeakMap<NodeJS.ProcessEnv, number>();
let nextIdentity = 1;

export interface ClaudeCodeRuntimeAvailabilityOptions {
  readonly acpWorkerPath?: string | undefined;
  readonly executablePath?: string | undefined;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
  readonly spawn?: ClaudeCodeRuntimeSpawn | undefined;
  readonly forceRefresh?: boolean | undefined;
}

export async function canUseClaudeCodeRuntime(
  options: ClaudeCodeRuntimeAvailabilityOptions = {},
): Promise<RuntimeCanUseResult> {
  try {
    const worker = resolveClaudeAcpWorkerPath(options.acpWorkerPath);
    if (!statSync(worker).isFile()) throw new Error("Claude ACP worker path must point to a file");
  } catch (error) {
    return {
      usable: false,
      reason: error instanceof Error ? error.message : String(error),
      details: { code: "claude_acp_worker_missing" },
    };
  }
  if (options.spawn !== undefined)
    return {
      usable: true,
      details: { probe: "skipped", reason: "Custom Claude Code spawn was provided." },
    };
  const command = resolveClaudeCodeCommand(options);
  const cacheKey = availabilityCacheKey(command, options);
  if (options.forceRefresh) {
    availabilityCache.delete(cacheKey);
  } else {
    const cached = availabilityCache.get(cacheKey);
    if (cached !== undefined) {
      if (cached.expiresAt <= Date.now()) {
        void refreshAvailability(cacheKey, command, options).catch(() => undefined);
      }
      return cached.result;
    }
  }

  return await refreshAvailability(cacheKey, command, options);
}

function refreshAvailability(
  cacheKey: string,
  command: {
    readonly executablePath: string;
    readonly launcherArgs: readonly string[];
    readonly sourcePath: string;
  },
  options: ClaudeCodeRuntimeAvailabilityOptions,
): Promise<RuntimeCanUseResult> {
  const activeRefresh = availabilityRefreshes.get(cacheKey);
  if (activeRefresh !== undefined) return activeRefresh;

  const refresh = canUseRuntimeBinary({
    runtimeName: "Claude Code CLI",
    defaultExecutablePath: "claude",
    executablePath: command.executablePath,
    args: [...command.launcherArgs, "--version"],
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    spawn: options.spawn,
  }).then((result) => {
    const normalized = {
      ...result,
      details: {
        ...result.details,
        executablePath: command.sourcePath,
        ...(command.executablePath === command.sourcePath
          ? {}
          : { launcherExecutablePath: command.executablePath }),
      },
    };
    if (normalized.usable) {
      availabilityCache.set(cacheKey, {
        expiresAt: Date.now() + AVAILABILITY_TTL_MS,
        result: normalized,
      });
    } else {
      availabilityCache.delete(cacheKey);
    }
    return normalized;
  });
  availabilityRefreshes.set(cacheKey, refresh);
  void refresh.then(clearRefresh, clearRefresh);
  return refresh;

  function clearRefresh(): void {
    if (availabilityRefreshes.get(cacheKey) === refresh) {
      availabilityRefreshes.delete(cacheKey);
    }
  }
}

function availabilityCacheKey(
  command: {
    readonly executablePath: string;
    readonly launcherArgs: readonly string[];
    readonly sourcePath: string;
  },
  options: ClaudeCodeRuntimeAvailabilityOptions,
): string {
  return [
    command.executablePath,
    command.sourcePath,
    JSON.stringify(command.launcherArgs),
    options.cwd ?? "",
    String(options.timeoutMs ?? ""),
    identity(options.spawn, spawnIds),
    identity(options.env, environmentIds),
  ].join("\u0000");
}

function identity<T extends object>(value: T | undefined, identities: WeakMap<T, number>): string {
  if (value === undefined) return "";
  let id = identities.get(value);
  if (id === undefined) {
    id = nextIdentity;
    nextIdentity += 1;
    identities.set(value, id);
  }
  return String(id);
}
