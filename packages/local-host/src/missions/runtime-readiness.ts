import type { RuntimeCanUseResult, RuntimeResolver } from "@pragma/core";

export interface LocalHostTargetRuntimeReadiness {
  readonly runtimeId: string;
  readonly resolved: Awaited<ReturnType<RuntimeResolver["bind"]>>;
  readonly availability: RuntimeCanUseResult;
}

/** Target-only probes shared by Mission compilation and Host diagnostics. */
export function createLocalHostRuntimeReadiness(options: {
  readonly runtimes: RuntimeResolver;
  readonly getEnvironmentKey?: (() => string | Promise<string>) | undefined;
  readonly onInvalidate?: (() => void) | undefined;
}) {
  const probes = new Map<
    string,
    { expiresAt: number; value: Promise<LocalHostTargetRuntimeReadiness> }
  >();
  return {
    async get(runtimeIds: readonly string[]): Promise<LocalHostTargetRuntimeReadiness[]> {
      const environmentKey = await options.getEnvironmentKey?.();
      return await Promise.all(
        [...new Set(runtimeIds)].map(async (runtimeId) => {
          const resolved = await options.runtimes.bind({ runtimeId });
          const key = JSON.stringify([resolved.binding, environmentKey]);
          const cached = probes.get(key);
          if (cached !== undefined && cached.expiresAt > Date.now()) return await cached.value;
          const value = Promise.resolve()
            .then(async () => {
              const availability = await resolved.adapter.canUse();
              const entry = probes.get(key);
              if (entry?.value === value) {
                if (availability.usable) entry.expiresAt = Date.now() + 30_000;
                else probes.delete(key);
              }
              return { runtimeId, resolved, availability };
            })
            .catch((error: unknown) => {
              if (probes.get(key)?.value === value) probes.delete(key);
              throw error;
            });
          probes.set(key, { expiresAt: Infinity, value });
          while (probes.size > 64) probes.delete(probes.keys().next().value!);
          return await value;
        }),
      );
    },
    invalidate(): void {
      probes.clear();
      options.onInvalidate?.();
    },
  };
}

export type LocalHostRuntimeReadiness = ReturnType<typeof createLocalHostRuntimeReadiness>;
