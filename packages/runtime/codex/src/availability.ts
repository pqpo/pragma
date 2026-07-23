import { canUseRuntimeBinary } from "@pragma/core/runtime/process-probe";
import type { RuntimeCanUseResult } from "@pragma/core/runtime/runtime-adapter";
import { BoundedLruCache } from "@pragma/shared";
import { resolveCodexExecutablePath } from "./executable.ts";
import type { CodexRuntimeSpawn } from "./types.ts";

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
const spawnIds = new WeakMap<NonNullable<CodexRuntimeSpawn>, number>();
const environmentIds = new WeakMap<NodeJS.ProcessEnv, number>();
let nextIdentity = 1;

export interface CodexRuntimeAvailabilityOptions {
  readonly executablePath?: string | undefined;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs?: number | undefined;
  readonly spawn?: CodexRuntimeSpawn | undefined;
}

export async function canUseCodexRuntime(
  options: CodexRuntimeAvailabilityOptions = {},
): Promise<RuntimeCanUseResult> {
  // A custom spawn is normally a test double or host-specific launcher. Preserve the
  // historical bare-command contract unless its caller explicitly selects a path.
  const executablePath =
    options.executablePath ??
    (options.spawn === undefined ? resolveCodexExecutablePath(options) : "codex");
  const cacheKey = availabilityCacheKey(executablePath, options);
  const cached = availabilityCache.get(cacheKey);

  if (cached !== undefined) {
    if (cached.expiresAt <= Date.now()) {
      void refreshAvailability(cacheKey, executablePath, options).catch(() => undefined);
    }
    return cached.result;
  }

  return await refreshAvailability(cacheKey, executablePath, options);
}

function refreshAvailability(
  cacheKey: string,
  executablePath: string,
  options: CodexRuntimeAvailabilityOptions,
): Promise<RuntimeCanUseResult> {
  const activeRefresh = availabilityRefreshes.get(cacheKey);
  if (activeRefresh !== undefined) return activeRefresh;

  const refresh = canUseRuntimeBinary({
    runtimeName: "Codex CLI",
    defaultExecutablePath: "codex",
    executablePath,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    spawn: options.spawn,
  }).then((result) => {
    availabilityCache.set(cacheKey, {
      expiresAt: Date.now() + AVAILABILITY_TTL_MS,
      result,
    });
    return result;
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
  executablePath: string,
  options: CodexRuntimeAvailabilityOptions,
): string {
  return [
    executablePath,
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
