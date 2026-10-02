import type { RuntimeCanUseResult } from "@pragma/core";
import type {
  DesktopRuntimeAvailability,
  GetDesktopRuntimeAvailabilityOptions,
} from "../../../shared/contracts/index.ts";
import type {
  RuntimeEnvironmentInspection,
  RuntimeEnvironmentService,
} from "./runtime-environment-service.ts";
import { BUILT_IN_RUNTIME_DISPLAY_NAME } from "./runtime-environment-store.ts";

const PROBE_CONCURRENCY_LIMIT = 2;
interface CachedRuntimeAvailability {
  readonly materializationCacheKey: string;
  readonly availability: DesktopRuntimeAvailability;
}

const availabilityCaches = new WeakMap<
  RuntimeEnvironmentService,
  Map<string, CachedRuntimeAvailability>
>();

export async function getRuntimeAvailability(
  runtimes: RuntimeEnvironmentService,
  options?: GetDesktopRuntimeAvailabilityOptions,
): Promise<DesktopRuntimeAvailability[]> {
  if (options?.forceRefresh) invalidateTargetRuntimeAvailability(runtimes);
  let cachedAvailabilityMap = availabilityCaches.get(runtimes);
  if (cachedAvailabilityMap === undefined) {
    cachedAvailabilityMap = new Map();
    availabilityCaches.set(runtimes, cachedAvailabilityMap);
  }
  const materializationCacheKey = await runtimes.getMaterializationCacheKey();
  const defaultRuntimeId = await runtimes.getDefaultRuntimeId();
  const allInspections = await runtimes.list();
  const forceRefresh = options?.forceRefresh ?? false;
  const targetRuntimeId = options?.runtimeId;

  const activeInspections = allInspections.filter((inspection) => {
    const revision = inspection.head.revision;
    return revision?.status !== "deleted";
  });

  const inspectionsToProbe = activeInspections.filter((inspection) => {
    const runtimeId = inspection.head.entry.runtimeId;
    if (forceRefresh) {
      return targetRuntimeId === undefined || runtimeId === targetRuntimeId;
    }
    return (
      cachedAvailabilityMap.get(runtimeId)?.materializationCacheKey !== materializationCacheKey
    );
  });

  if (inspectionsToProbe.length > 0) {
    const probedResults = await mapWithConcurrency(
      inspectionsToProbe,
      PROBE_CONCURRENCY_LIMIT,
      async (inspection: RuntimeEnvironmentInspection): Promise<DesktopRuntimeAvailability> => {
        const revision = inspection.head.revision;
        const definition = revision?.definition;
        const adapter = inspection.adapter;
        if (adapter === undefined) {
          return {
            id: inspection.head.entry.runtimeId,
            isDefault: inspection.head.entry.runtimeId === defaultRuntimeId,
            displayName:
              inspection.head.entry.runtimeId === "pi"
                ? BUILT_IN_RUNTIME_DISPLAY_NAME
                : (definition?.displayName ?? inspection.head.entry.runtimeId),
            kind: definition?.adapter.id ?? "unknown",
            status: "unavailable",
            reason: inspection.error ?? "Runtime Environment revision is unavailable.",
            ...(revision === undefined ? {} : { revision: revision.revision }),
            ...(definition === undefined
              ? {}
              : { origin: definition.origin, adapter: definition.adapter }),
          };
        }

        let availability: RuntimeCanUseResult;
        try {
          const canUseFn = adapter.canUse as (opts?: {
            forceRefresh?: boolean;
          }) => Promise<RuntimeCanUseResult>;
          availability = await canUseFn(
            options?.forceRefresh === undefined ? {} : { forceRefresh: options.forceRefresh },
          );
        } catch (error) {
          availability = { usable: false, reason: errorMessage(error) };
        }
        const executablePath = stringDetail(availability.details, "executablePath");
        const version = stringDetail(availability.details, "version");
        let models: DesktopRuntimeAvailability["models"];
        let modelDiscoveryError: string | undefined;
        if (availability.usable && adapter.listModels !== undefined) {
          try {
            const discoveredModels =
              options?.forceRefresh === true
                ? await adapter.listModels({ forceRefresh: true })
                : await adapter.listModels();
            models = discoveredModels.map(({ inputModalities, thinking, ...model }) => ({
              ...model,
              provider: { ...model.provider },
              ...(inputModalities === undefined ? {} : { inputModalities: [...inputModalities] }),
              ...(thinking === undefined
                ? {}
                : {
                    thinking: {
                      ...thinking,
                      supportedLevels: thinking.supportedLevels.map((level) => ({ ...level })),
                    },
                  }),
            }));
          } catch (error) {
            modelDiscoveryError = errorMessage(error);
          }
        }
        return {
          id: adapter.descriptor.id,
          revision: revision!.revision,
          origin: definition!.origin,
          adapter: definition!.adapter,
          isDefault: adapter.descriptor.id === defaultRuntimeId,
          kind: adapter.descriptor.kind,
          displayName:
            adapter.descriptor.id === "pi"
              ? BUILT_IN_RUNTIME_DISPLAY_NAME
              : adapter.descriptor.displayName,
          status: availability.usable ? "available" : "unavailable",
          ...(executablePath === undefined ? {} : { executablePath }),
          ...(version === undefined ? {} : { version }),
          ...(availability.usable || availability.reason === undefined
            ? {}
            : { reason: availability.reason }),
          ...(models === undefined ? {} : { models }),
          ...(modelDiscoveryError === undefined ? {} : { modelDiscoveryError }),
        };
      },
    );

    for (const item of probedResults) {
      cachedAvailabilityMap.set(item.id, { materializationCacheKey, availability: item });
    }
  }

  return activeInspections.map((inspection) => {
    const runtimeId = inspection.head.entry.runtimeId;
    const cached = cachedAvailabilityMap.get(runtimeId);
    if (cached?.materializationCacheKey === materializationCacheKey) return cached.availability;
    const revision = inspection.head.revision;
    const definition = revision?.definition;
    return {
      id: runtimeId,
      isDefault: runtimeId === defaultRuntimeId,
      displayName:
        runtimeId === "pi" ? BUILT_IN_RUNTIME_DISPLAY_NAME : (definition?.displayName ?? runtimeId),
      kind: definition?.adapter.id ?? "unknown",
      status: "unavailable",
      reason: inspection.error ?? "Runtime Environment availability is being checked.",
      ...(revision === undefined ? {} : { revision: revision.revision }),
      ...(definition === undefined
        ? {}
        : { origin: definition.origin, adapter: definition.adapter }),
    };
  });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function stringDetail(
  details: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  return typeof value === "string" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Runtime inspection failed.";
}

const targetProbes = new WeakMap<
  RuntimeEnvironmentService,
  Map<
    string,
    {
      expiresAt: number;
      value: Promise<DesktopRuntimeAvailability>;
    }
  >
>();

/** Execution readiness never enumerates or discovers unrelated Runtime models. */
export async function getTargetRuntimeAvailability(
  runtimes: RuntimeEnvironmentService,
  runtimeIds: readonly string[],
): Promise<DesktopRuntimeAvailability[]> {
  let cache = targetProbes.get(runtimes);
  if (cache === undefined) {
    cache = new Map();
    targetProbes.set(runtimes, cache);
  }
  const environmentKey = await runtimes.getMaterializationCacheKey();
  return await Promise.all(
    [...new Set(runtimeIds)].map(async (runtimeId) => {
      const resolved = await runtimes.bind({ runtimeId });
      const key = JSON.stringify([resolved.binding, environmentKey]);
      const cached = cache.get(key);
      if (cached !== undefined && cached.expiresAt > Date.now()) return await cached.value;
      const value = Promise.resolve()
        .then(async (): Promise<DesktopRuntimeAvailability> => {
          const availability = await resolved.adapter.canUse();
          const entry = cache.get(key);
          if (entry?.value === value) {
            if (availability.usable) entry.expiresAt = Date.now() + 30_000;
            else cache.delete(key);
          }
          return {
            id: runtimeId,
            revision: resolved.binding.revision,
            isDefault: runtimeId === (await runtimes.getDefaultRuntimeId()),
            displayName: resolved.adapter.descriptor.displayName,
            kind: resolved.adapter.descriptor.kind,
            status: availability.usable ? "available" : "unavailable",
            ...(availability.reason === undefined ? {} : { reason: availability.reason }),
          };
        })
        .catch((error: unknown) => {
          if (cache.get(key)?.value === value) cache.delete(key);
          throw error;
        });
      cache.set(key, { expiresAt: Infinity, value });
      while (cache.size > 64) cache.delete(cache.keys().next().value!);
      return await value;
    }),
  );
}

export function invalidateTargetRuntimeAvailability(runtimes: RuntimeEnvironmentService): void {
  targetProbes.delete(runtimes);
  runtimes.invalidateModelValidation?.();
}
