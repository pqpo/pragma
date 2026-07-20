import type { RuntimeModel, RuntimeModelSelection, RuntimeResolver } from "@pragma/core";
import {
  canonicalPragmaResourceRef,
  type PragmaExpertResource,
  type PragmaInvocableResource,
  type PragmaResource,
  type PragmaRuntimeProfileResource,
} from "@pragma/interpreter/ast";

import {
  isMissionExecutorResource,
  missionExecutorRef,
  missionExecutorSnapshot,
  MissionExecutorOptionSchema,
  MissionExecutorSchema,
  MissionModelOptionsSchema,
  type DesktopRuntimeModel,
  type MissionExecutor,
  type MissionExecutorOption,
  type MissionModelOptions,
  type MissionModelOverride,
} from "../shared/desktop-api.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";
import type { DesktopSystemExpertRegistry } from "./system-expert-registry.ts";
import { ModelProviderStoreError } from "./model-provider-store.ts";

export interface MissionExecutorCatalog {
  list(): Promise<readonly MissionExecutorOption[]>;
  resolve(ref: string): Promise<MissionExecutor | undefined>;
  getModelOptions(ref: string): Promise<MissionModelOptions>;
  validateModelOverride(ref: string, override: MissionModelOverride): Promise<void>;
}

export function createMissionExecutorCatalog(options: {
  readonly project: PragmaProjectStore;
  readonly systemExperts: DesktopSystemExpertRegistry;
  readonly runtimes: RuntimeResolver;
}): MissionExecutorCatalog {
  const resolveRuntimeId = async (ref: string): Promise<string | undefined> => {
    const system = options.systemExperts.get(ref);
    if (system !== undefined) {
      return system.executionProfile.mode === "pinned"
        ? system.executionProfile.model.runtimeId
        : await options.runtimes.getDefaultRuntimeId();
    }

    const snapshot = await options.project.get();
    const resource = snapshot.resources
      .filter(isMissionExecutorResource)
      .find((candidate) => missionExecutorRef(candidate) === ref);
    if (resource === undefined || resource.kind === "Flow") return undefined;
    const expert =
      resource.kind === "Expert"
        ? resource
        : snapshot.resources.find(
            (candidate): candidate is PragmaExpertResource =>
              candidate.kind === "Expert" &&
              canonicalPragmaResourceRef(candidate) === resource.spec.coordinator.ref,
          );
    if (expert === undefined) {
      throw new Error(`Mission executor coordinator not found: ${ref}.`);
    }
    return await projectExpertRuntimeId(expert, snapshot.resources, options.runtimes);
  };

  const bindModel = async (ref: string, selection?: RuntimeModelSelection) => {
    const runtimeId = await resolveRuntimeId(ref);
    if (runtimeId === undefined) throw new Error("Flow missions do not support a model override.");
    return await options.runtimes.bind({
      runtimeId,
      ...(selection === undefined ? {} : { modelSelection: selection }),
    });
  };

  return {
    async list() {
      const snapshot = await options.project.get();
      const projectOptions = snapshot.resources
        .filter(isMissionExecutorResource)
        .map(projectExecutorOption);
      return [...options.systemExperts.listExecutors(), ...projectOptions].toSorted((left, right) =>
        left.name.localeCompare(right.name),
      );
    },
    async resolve(ref) {
      const system = options.systemExperts.getExecutor(ref);
      if (system !== undefined) return system;
      const snapshot = await options.project.get();
      const resource = snapshot.resources
        .filter(isMissionExecutorResource)
        .find((candidate) => missionExecutorRef(candidate) === ref);
      return resource === undefined ? undefined : projectExecutor(resource);
    },
    async getModelOptions(ref) {
      const resolved = await bindModel(ref);
      const availability = await resolved.adapter.canUse();
      if (!availability.usable) {
        throw new Error(
          availability.reason ?? `Runtime is unavailable for mission executor: ${ref}.`,
        );
      }
      try {
        const models =
          resolved.adapter.listModels === undefined
            ? []
            : (await resolved.adapter.listModels()).map(cloneRuntimeModel);
        return MissionModelOptionsSchema.parse({ status: "ready", models });
      } catch (error) {
        if (error instanceof ModelProviderStoreError && error.code === "config_invalid") {
          return MissionModelOptionsSchema.parse({ status: "reset_required", models: [] });
        }
        throw error;
      }
    },
    async validateModelOverride(ref, override) {
      await bindModel(ref, toModelSelection(override));
    },
  };
}

async function projectExpertRuntimeId(
  expert: PragmaExpertResource,
  resources: readonly PragmaResource[],
  runtimes: RuntimeResolver,
): Promise<string> {
  if (expert.spec.runtime === undefined) return await runtimes.getDefaultRuntimeId();
  const profile = resources.find(
    (candidate): candidate is PragmaRuntimeProfileResource =>
      candidate.kind === "RuntimeProfile" &&
      canonicalPragmaResourceRef(candidate) === expert.spec.runtime!.ref,
  );
  const config = profile?.spec.config;
  if (typeof config !== "object" || config === null || !("runtimeId" in config)) {
    throw new Error(`Expert Runtime profile is invalid: ${expert.spec.runtime.ref}.`);
  }
  const runtimeId = config.runtimeId;
  if (typeof runtimeId !== "string" || runtimeId.trim() === "") {
    throw new Error(`Expert Runtime ID is invalid: ${expert.spec.runtime.ref}.`);
  }
  return runtimeId;
}

function toModelSelection(override: MissionModelOverride): RuntimeModelSelection {
  return {
    model: { providerId: override.providerId, modelId: override.modelId },
    ...(override.thinkingLevel === undefined ? {} : { thinkingLevel: override.thinkingLevel }),
  };
}

function cloneRuntimeModel(model: RuntimeModel): DesktopRuntimeModel {
  const { thinking, ...rest } = model;
  return {
    ...rest,
    provider: { ...model.provider },
    ...(thinking === undefined
      ? {}
      : {
          thinking: {
            ...thinking,
            supportedLevels: thinking.supportedLevels.map((level) => ({ ...level })),
          },
        }),
  };
}

function projectExecutor(resource: PragmaInvocableResource): MissionExecutor {
  return MissionExecutorSchema.parse(missionExecutorSnapshot(resource));
}

function projectExecutorOption(resource: PragmaInvocableResource): MissionExecutorOption {
  return MissionExecutorOptionSchema.parse({
    ...projectExecutor(resource),
    description: resource.metadata.description,
    origin: "project",
    readOnly: false,
  });
}
