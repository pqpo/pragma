import type { RuntimeModelSelection, RuntimeResolver } from "@pragma/core";

import type { ExpertModelConfig, MissionModelOverride } from "../../../shared/contracts/index.ts";

export interface SystemExpertRuntimeDefaults {
  readonly runtimeId: string;
  readonly modelSelection?: RuntimeModelSelection | undefined;
}

export async function resolveSystemExpertRuntimeDefaults(
  runtimes: RuntimeResolver,
  configuredModel: ExpertModelConfig | undefined,
  override: MissionModelOverride | undefined,
): Promise<SystemExpertRuntimeDefaults> {
  const runtimeId = configuredModel?.runtimeId ?? (await runtimes.getDefaultRuntimeId());
  if (override !== undefined) {
    return {
      runtimeId,
      modelSelection: {
        model: { providerId: override.providerId, modelId: override.modelId },
        ...(override.thinkingLevel === undefined ? {} : { thinkingLevel: override.thinkingLevel }),
      },
    };
  }
  if (configuredModel !== undefined) {
    return {
      runtimeId,
      modelSelection: {
        model: {
          providerId: configuredModel.providerId,
          modelId: configuredModel.modelId,
        },
        ...(configuredModel.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: configuredModel.thinkingLevel }),
      },
    };
  }
  const resolved = await runtimes.bind({ runtimeId });
  if (resolved.adapter.descriptor.kind !== "cloud-pi-agent") return { runtimeId };
  const model = (await resolved.adapter.listModels?.())?.[0];
  if (model === undefined) {
    throw new Error(
      "The built-in runtime has no configured model. Configure a Model Provider or choose an explicit model for this mission.",
    );
  }
  return {
    runtimeId,
    modelSelection: { model: { providerId: model.provider.id, modelId: model.id } },
  };
}

export function withRuntimeDefaults(
  runtimes: RuntimeResolver,
  defaults: SystemExpertRuntimeDefaults,
): RuntimeResolver {
  return {
    getDefaultRuntimeId: async () => defaults.runtimeId,
    bind: async (request = {}) =>
      await runtimes.bind({
        runtimeId: request.runtimeId ?? defaults.runtimeId,
        ...(request.modelSelection === undefined &&
        (request.runtimeId === undefined || request.runtimeId === defaults.runtimeId) &&
        defaults.modelSelection !== undefined
          ? { modelSelection: defaults.modelSelection }
          : request.modelSelection === undefined
            ? {}
            : { modelSelection: request.modelSelection }),
      }),
    resolve: async (request) => await runtimes.resolve(request),
  };
}
