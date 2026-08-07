import type { DesktopRuntimeAvailability } from "../../../shared/contracts/index.ts";
import type { RuntimeEnvironmentService } from "./runtime-environment-service.ts";
import { BUILT_IN_RUNTIME_DISPLAY_NAME } from "./runtime-environment-store.ts";

export async function getRuntimeAvailability(
  runtimes: RuntimeEnvironmentService,
): Promise<DesktopRuntimeAvailability[]> {
  const defaultRuntimeId = await runtimes.getDefaultRuntimeId();
  const inspections = await runtimes.list();
  return await Promise.all(
    inspections.flatMap((inspection) => {
      const revision = inspection.head.revision;
      if (revision?.status === "deleted") return [];
      return [
        (async (): Promise<DesktopRuntimeAvailability> => {
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

          let availability;
          try {
            availability = await adapter.canUse();
          } catch (error) {
            availability = { usable: false as const, reason: errorMessage(error) };
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
        })(),
      ];
    }),
  );
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
