import { createLocalHostRuntimeReadiness, type LocalHostRuntimeReadiness } from "../../index.ts";
import type { RuntimeAdapter, RuntimeCanUseResult } from "@pragma/core";
import type {
  DesktopRuntimeAvailability,
  GetDesktopRuntimeAvailabilityOptions,
} from "../../deployment-contracts/index.ts";
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
  const environmentCacheKey = await runtimes.getMaterializationCacheKey();
  const defaultRuntimeId = await runtimes.getDefaultRuntimeId();
  const allInspections = await runtimes.list();
  const materializationCacheKey = JSON.stringify([
    environmentCacheKey,
    allInspections.map((value) => [
      value.head.entry.runtimeId,
      value.head.revision?.revision,
      value.head.revision?.fingerprint,
    ]),
  ]);
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
        const modelCatalog = availability.usable
          ? await discoverRuntimeModels(adapter, options?.forceRefresh)
          : {};
        return {
          id: adapter.descriptor.id,
          revision: revision!.revision,
          origin: definition!.origin,
          adapter: definition!.adapter,
          isDefault: adapter.descriptor.id === defaultRuntimeId,
          kind: adapter.descriptor.kind,
          ...(adapter.descriptor.permissionModes === undefined
            ? {}
            : { permissionModes: adapter.descriptor.permissionModes }),
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
          ...modelCatalog,
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

const targetReadiness = new WeakMap<RuntimeEnvironmentService, LocalHostRuntimeReadiness>();

function runtimeReadiness(runtimes: RuntimeEnvironmentService): LocalHostRuntimeReadiness {
  let readiness = targetReadiness.get(runtimes);
  if (readiness === undefined) {
    readiness = createLocalHostRuntimeReadiness({
      runtimes,
      getEnvironmentKey: () => runtimes.getMaterializationCacheKey(),
      onInvalidate: () => runtimes.invalidateModelValidation?.(),
    });
    targetReadiness.set(runtimes, readiness);
  }
  return readiness;
}

type RuntimeModelCatalog = Pick<DesktopRuntimeAvailability, "models" | "modelDiscoveryError">;

async function discoverRuntimeModels(
  adapter: RuntimeAdapter,
  forceRefresh?: boolean,
): Promise<RuntimeModelCatalog> {
  if (adapter.listModels === undefined) return {};
  try {
    const models = await adapter.listModels(forceRefresh ? { forceRefresh: true } : undefined);
    return {
      models: models.map(({ inputModalities, thinking, ...model }) => ({
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
      })),
    };
  } catch (error) {
    return { modelDiscoveryError: errorMessage(error) };
  }
}

const targetModelCatalogs = new WeakMap<
  RuntimeEnvironmentService,
  Map<string, { adapter: RuntimeAdapter; expiresAt: number; value: Promise<RuntimeModelCatalog> }>
>();

/** Only probes requested Runtimes; model discovery is opt-in for dependency validation. */
export async function getTargetRuntimeAvailability(
  runtimes: RuntimeEnvironmentService,
  runtimeIds: readonly string[],
  options?: { readonly includeModels?: boolean },
): Promise<DesktopRuntimeAvailability[]> {
  const results = await runtimeReadiness(runtimes).get(runtimeIds);
  const defaultRuntimeId = await runtimes.getDefaultRuntimeId();
  const environmentKey = options?.includeModels
    ? await runtimes.getMaterializationCacheKey()
    : undefined;
  let catalogs = targetModelCatalogs.get(runtimes);
  if (catalogs === undefined) {
    catalogs = new Map();
    targetModelCatalogs.set(runtimes, catalogs);
  }
  const cache = catalogs;
  return await mapWithConcurrency(
    results,
    PROBE_CONCURRENCY_LIMIT,
    async ({ runtimeId, resolved, availability }): Promise<DesktopRuntimeAvailability> => {
      let modelCatalog: RuntimeModelCatalog = {};
      if (options?.includeModels && availability.usable) {
        const key = JSON.stringify([resolved.binding, environmentKey]);
        let cached = cache.get(key);
        if (
          cached === undefined ||
          cached.adapter !== resolved.adapter ||
          cached.expiresAt <= Date.now()
        ) {
          const value = discoverRuntimeModels(resolved.adapter).then((catalog) => {
            const entry = cache.get(key);
            if (entry?.value === value) {
              if (catalog.models === undefined) cache.delete(key);
              else entry.expiresAt = Date.now() + 30_000;
            }
            return catalog;
          });
          cached = { adapter: resolved.adapter, expiresAt: Infinity, value };
          cache.set(key, cached);
          while (cache.size > 64) cache.delete(cache.keys().next().value!);
        }
        modelCatalog = await cached.value;
      }
      return {
        id: runtimeId,
        revision: resolved.binding.revision,
        isDefault: runtimeId === defaultRuntimeId,
        displayName: resolved.adapter.descriptor.displayName,
        kind: resolved.adapter.descriptor.kind,
        ...(resolved.adapter.descriptor.permissionModes === undefined
          ? {}
          : { permissionModes: resolved.adapter.descriptor.permissionModes }),
        status: availability.usable ? "available" : "unavailable",
        ...(availability.reason === undefined ? {} : { reason: availability.reason }),
        ...modelCatalog,
      };
    },
  );
}

export function invalidateTargetRuntimeAvailability(runtimes: RuntimeEnvironmentService): void {
  availabilityCaches.delete(runtimes);
  targetModelCatalogs.delete(runtimes);
  runtimeReadiness(runtimes).invalidate();
}
