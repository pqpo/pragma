import type { RuntimeCanUseResult } from "@pragma/core";
import { runtimeFeature } from "@pragma/core";
import { BoundedLruCache } from "@pragma/shared";

import { probeOpenCode } from "./process.ts";

const AVAILABILITY_TTL_MS = 60_000;
const availabilityCache = new BoundedLruCache<
  string,
  { readonly expiresAt: number; readonly result: RuntimeCanUseResult }
>(64);
const availabilityRefreshes = new Map<string, Promise<RuntimeCanUseResult>>();

export async function canUseOpenCodeRuntime(input: {
  readonly executablePath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly forceRefresh?: boolean | undefined;
}): Promise<RuntimeCanUseResult> {
  const key = `${input.executablePath}\0${input.env["PATH"] ?? ""}`;
  if (input.forceRefresh === true) {
    availabilityCache.delete(key);
  } else {
    const cached = availabilityCache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.result;
  }

  const active = availabilityRefreshes.get(key);
  if (active !== undefined) return await active;

  const refresh = (async (): Promise<RuntimeCanUseResult> => {
    try {
      const { version, major } = await probeOpenCode(input.executablePath, input.env);
      const result = {
        usable: true,
        features: {
          steering:
            major === 1
              ? runtimeFeature.unsupported(
                  "OpenCode 1.x does not expose safe active-turn steering.",
                )
              : runtimeFeature.degraded(
                  "OpenCode 2.x private-server steering; provider-backed validation pending.",
                ),
        },
        details: { executablePath: input.executablePath, version },
      } satisfies RuntimeCanUseResult;
      availabilityCache.set(key, {
        expiresAt: Date.now() + AVAILABILITY_TTL_MS,
        result,
      });
      return result;
    } catch (error) {
      availabilityCache.delete(key);
      return {
        usable: false,
        reason: error instanceof Error ? error.message : String(error),
        details: { executablePath: input.executablePath },
      };
    }
  })();
  availabilityRefreshes.set(key, refresh);
  const clear = (): void => {
    if (availabilityRefreshes.get(key) === refresh) availabilityRefreshes.delete(key);
  };
  void refresh.then(clear, clear);
  return await refresh;
}
