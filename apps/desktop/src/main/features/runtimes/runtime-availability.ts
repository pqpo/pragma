import type { RuntimeCanUseResult } from "@pragma/core";
import type {
  DesktopRuntimeAvailability,
  GetDesktopRuntimeAvailabilityOptions,
} from "../../../shared/contracts/index.ts";
import type { RuntimeEnvironmentInspection, RuntimeEnvironmentService } from "./runtime-environment-service.ts";
import { BUILT_IN_RUNTIME_DISPLAY_NAME } from "./runtime-environment-store.ts";

const PROBE_CONCURRENCY_LIMIT = 2;
const cachedAvailabilityMap = new Map<string, DesktopRuntimeAvailability>();

export async function getRuntimeAvailability(
  runtimes: RuntimeEnvironmentService,
  options?: GetDesktopRuntimeAvailabilityOptions,
): Promise<DesktopRuntimeAvailability[]> {
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
    return !cachedAvailabilityMap.has(runtimeId);
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
          const canUseFn = adapter.canUse as (
            opts?: { forceRefresh?: boolean },
          ) => Promise<RuntimeCanUseResult>;
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
            models = (await adapter.listModels()).map(
              ({ inputModalities, thinking, ...model }) => ({
                ...model,
                provider: { ...model.provider },
                ...(inputModalities === undefined
                  ? {}
                  : { inputModalities: [...inputModalities] }),
                ...(thinking === undefined
                  ? {}
                  : {
                      thinking: {
                        ...thinking,
                        supportedLevels: thinking.supportedLevels.map((level) => ({ ...level })),
                      },
                    }),
              }),
            );
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
      cachedAvailabilityMap.set(item.id, item);
    }
  }

  return activeInspections.map((inspection) => {
    const runtimeId = inspection.head.entry.runtimeId;
    const cached = cachedAvailabilityMap.get(runtimeId);
    if (cached !== undefined) return cached;
    const revision = inspection.head.revision;
    const definition = revision?.definition;
    return {
      id: runtimeId,
      isDefault: runtimeId === defaultRuntimeId,
      displayName:
        runtimeId === "pi"
          ? BUILT_IN_RUNTIME_DISPLAY_NAME
          : (definition?.displayName ?? runtimeId),
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
