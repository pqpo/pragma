import { canUseRuntimeBinary } from "@pragma/core/runtime/process-probe";
import type { RuntimeCanUseResult } from "@pragma/core";
import { BoundedLruCache } from "@pragma/shared";

import { resolveQoderCliExecutablePath } from "./executable.ts";
import type { QoderCliRuntimeAdapterOptions } from "./types.ts";

const CACHE_TTL_MS = 60_000;
const cache = new BoundedLruCache<string, { expiresAt: number; result: RuntimeCanUseResult }>(64);
const refreshes = new Map<string, Promise<RuntimeCanUseResult>>();

export async function canUseQoderCliRuntime(
  options: QoderCliRuntimeAdapterOptions & { readonly forceRefresh?: boolean } = {},
): Promise<RuntimeCanUseResult> {
  const executablePath = resolveQoderCliExecutablePath(options);
  const key = `${executablePath}\0${options.env?.["PATH"] ?? ""}`;
  if (options.forceRefresh) {
    cache.delete(key);
  } else {
    const cached = cache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.result;
  }
  const active = refreshes.get(key);
  if (active !== undefined) return await active;

  const refresh = canUseRuntimeBinary({
    runtimeName: "Qoder CLI",
    defaultExecutablePath: "qodercli",
    executablePath,
    args: ["--version"],
    env: { ...process.env, ...(options.env ?? {}) },
  }).then((result) => {
    const normalized = {
      ...result,
      details: { ...result.details, executablePath },
    };
    if (normalized.usable) {
      cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result: normalized });
    } else {
      cache.delete(key);
    }
    return normalized;
  });
  refreshes.set(key, refresh);
  const clear = (): void => {
    if (refreshes.get(key) === refresh) refreshes.delete(key);
  };
  void refresh.then(clear, clear);
  return await refresh;
}
