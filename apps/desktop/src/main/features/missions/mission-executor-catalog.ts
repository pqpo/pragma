import type { RuntimeModel, RuntimeModelSelection, RuntimeResolver } from "@pragma/core";
import type { RuntimeEnvironmentBinding } from "@pragma/shared";
import {
  canonicalPragmaResourceRef,
  type PragmaExpertResource,
  type PragmaExpertTeamResource,
  type PragmaInvocableResource,
  type PragmaResource,
  type PragmaRuntimeProfileResource,
} from "@pragma/interpreter/ast";

import {
  isMissionExecutorResource,
  expertTeamCoordinatorAvatarId,
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
  type ExpertMentionCandidate,
  type PragmaProjectSnapshot,
} from "../../../shared/contracts/index.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import { ModelProviderStoreError } from "../model-providers/model-provider-store.ts";

export interface MissionExecutorCatalog {
  list(): Promise<readonly MissionExecutorOption[]>;
  resolve(ref: string, project: PragmaProjectSnapshot): Promise<MissionExecutor | undefined>;
  getModelOptions(
    ref: string,
    runtimeBinding?: RuntimeEnvironmentBinding | undefined,
    projectResources?: readonly PragmaResource[] | undefined,
  ): Promise<MissionModelOptions>;
  validateModelOverride(
    ref: string,
    override: MissionModelOverride,
    project: PragmaProjectSnapshot,
    runtimeBinding?: RuntimeEnvironmentBinding | undefined,
  ): Promise<void>;
}

export function createMissionExecutorCatalog(options: {
  readonly project: PragmaProjectStore;
  readonly systemExperts: DesktopSystemExpertRegistry;
  readonly runtimes: RuntimeResolver;
}): MissionExecutorCatalog {
  const resolveRuntimeDefaults = async (
    ref: string,
    projectResources?: readonly PragmaResource[],
  ): Promise<
    | {
        readonly runtimeId: string;
        readonly modelSelection?: RuntimeModelSelection | undefined;
      }
    | undefined
  > => {
    const system = options.systemExperts.get(ref);
    if (system !== undefined) {
      if (system.executionProfile.mode === "system-default") {
        return { runtimeId: await options.runtimes.getDefaultRuntimeId() };
      }
      return {
        runtimeId: system.executionProfile.model.runtimeId,
        modelSelection: {
          model: {
            providerId: system.executionProfile.model.providerId,
            modelId: system.executionProfile.model.modelId,
          },
          ...(system.executionProfile.model.thinkingLevel === undefined
            ? {}
            : { thinkingLevel: system.executionProfile.model.thinkingLevel }),
        },
      };
    }

    const resources = projectResources ?? (await options.project.get()).resources;
    const resource = resources
      .filter(isMissionExecutorResource)
      .find((candidate) => missionExecutorRef(candidate) === ref);
    if (resource === undefined || resource.kind === "Flow") return undefined;
    const expert =
      resource.kind === "Expert"
        ? resource
        : resources.find(
            (candidate): candidate is PragmaExpertResource =>
              candidate.kind === "Expert" &&
              canonicalPragmaResourceRef(candidate) === resource.spec.coordinator.ref,
          );
    if (expert === undefined) {
      throw new Error(`Mission executor coordinator not found: ${ref}.`);
    }
    return await projectExpertRuntimeDefaults(expert, resources, options.runtimes);
  };

  const bindRuntimeDefaults = async (
    defaults: {
      readonly runtimeId: string;
      readonly modelSelection?: RuntimeModelSelection | undefined;
    },
    selection?: RuntimeModelSelection,
    runtimeBinding?: RuntimeEnvironmentBinding,
  ) => {
    const configuredSelection =
      runtimeBinding === undefined || runtimeBinding.runtimeId === defaults.runtimeId
        ? defaults.modelSelection
        : undefined;
    const modelSelection = selection ?? configuredSelection;
    return runtimeBinding === undefined
      ? await options.runtimes.bind({
          runtimeId: defaults.runtimeId,
          ...(modelSelection === undefined ? {} : { modelSelection }),
        })
      : await options.runtimes.resolve({
          binding: runtimeBinding,
          ...(modelSelection === undefined ? {} : { modelSelection }),
        });
  };

  const modelOverrideUnavailableError = async (
    ref: string,
    projectResources?: readonly PragmaResource[],
  ): Promise<Error> => {
    const resources = projectResources ?? (await options.project.get()).resources;
    const resource = resources
      .filter(isMissionExecutorResource)
      .find((candidate) => missionExecutorRef(candidate) === ref);
    return resource?.kind === "Flow"
      ? new Error("Flow missions do not support a model override.")
      : new Error(`Mission executor not found: ${ref}.`);
  };

  return {
    async list() {
      const snapshot = await options.project.get();
      const projectOptions = snapshot.resources
        .filter(isMissionExecutorResource)
        .map((resource) => projectExecutorOption(resource, snapshot.resources));
      return [...options.systemExperts.listExecutors(), ...projectOptions].toSorted((left, right) =>
        left.name.localeCompare(right.name),
      );
    },
    async resolve(ref, project) {
      const system = options.systemExperts.getExecutor(ref);
      if (system !== undefined) return system;
      const resource = project.resources
        .filter(isMissionExecutorResource)
        .find((candidate) => missionExecutorRef(candidate) === ref);
      return resource === undefined ? undefined : projectExecutor(resource);
    },
    async getModelOptions(ref, runtimeBinding, projectResources) {
      const defaults = await resolveRuntimeDefaults(ref, projectResources);
      if (defaults === undefined) throw await modelOverrideUnavailableError(ref, projectResources);
      const resolved = await bindRuntimeDefaults(defaults, undefined, runtimeBinding);
      const availability = await resolved.adapter.canUse();
      if (!availability.usable) {
        throw new Error(
          availability.reason ?? `Runtime is unavailable for mission executor: ${ref}.`,
        );
      }
      const runtime = {
        id: resolved.binding.runtimeId,
        displayName: resolved.adapter.descriptor.displayName,
      };
      try {
        const models =
          resolved.adapter.listModels === undefined
            ? []
            : (await resolved.adapter.listModels()).map(cloneRuntimeModel);
        const configuredSelection =
          runtimeBinding === undefined || runtimeBinding.runtimeId === defaults.runtimeId
            ? defaults.modelSelection
            : undefined;
        const defaultSelection = resolveDefaultModelSelection(models, configuredSelection);
        return MissionModelOptionsSchema.parse({
          status: "ready",
          runtime,
          models,
          ...(defaultSelection === undefined ? {} : { defaultSelection }),
        });
      } catch (error) {
        if (error instanceof ModelProviderStoreError && error.code === "config_invalid") {
          return MissionModelOptionsSchema.parse({ status: "reset_required", runtime, models: [] });
        }
        throw error;
      }
    },
    async validateModelOverride(ref, override, project, runtimeBinding) {
      const defaults = await resolveRuntimeDefaults(ref, project.resources);
      if (defaults === undefined) throw await modelOverrideUnavailableError(ref, project.resources);
      await bindRuntimeDefaults(defaults, toModelSelection(override), runtimeBinding);
    },
  };
}

async function projectExpertRuntimeDefaults(
  expert: PragmaExpertResource,
  resources: readonly PragmaResource[],
  runtimes: RuntimeResolver,
): Promise<{
  readonly runtimeId: string;
  readonly modelSelection?: RuntimeModelSelection | undefined;
}> {
  if (expert.spec.runtime === undefined) {
    return { runtimeId: await runtimes.getDefaultRuntimeId() };
  }
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
  const runtimeConfig: Readonly<Record<string, unknown>> = config;
  const providerId = runtimeConfig["providerId"];
  const modelId = runtimeConfig["model"];
  const thinkingLevel = runtimeConfig["thinkingLevel"];
  return {
    runtimeId,
    ...(typeof providerId === "string" &&
    providerId.trim() !== "" &&
    typeof modelId === "string" &&
    modelId.trim() !== ""
      ? {
          modelSelection: {
            model: { providerId, modelId },
            ...(typeof thinkingLevel === "string" && thinkingLevel.trim() !== ""
              ? { thinkingLevel }
              : {}),
          },
        }
      : {}),
  };
}

function resolveDefaultModelSelection(
  models: readonly DesktopRuntimeModel[],
  configured: RuntimeModelSelection | undefined,
): MissionModelOverride | undefined {
  const model =
    configured === undefined
      ? (models.find((candidate) => candidate.default === true) ?? models[0])
      : models.find(
          (candidate) =>
            candidate.provider.id === configured.model.providerId &&
            candidate.id === configured.model.modelId,
        );
  if (configured === undefined && model === undefined) return undefined;
  const providerId = configured?.model.providerId ?? model?.provider.id;
  const modelId = configured?.model.modelId ?? model?.id;
  if (providerId === undefined || modelId === undefined) return undefined;
  const thinkingLevel = configured?.thinkingLevel ?? model?.thinking?.defaultLevel;
  return {
    providerId,
    modelId,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
}

function toModelSelection(override: MissionModelOverride): RuntimeModelSelection {
  return {
    model: { providerId: override.providerId, modelId: override.modelId },
    ...(override.thinkingLevel === undefined ? {} : { thinkingLevel: override.thinkingLevel }),
  };
}

function cloneRuntimeModel(model: RuntimeModel): DesktopRuntimeModel {
  const { inputModalities, thinking, ...rest } = model;
  return {
    ...rest,
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
  };
}

function projectExecutor(resource: PragmaInvocableResource): MissionExecutor {
  return MissionExecutorSchema.parse(missionExecutorSnapshot(resource));
}

function projectExecutorOption(
  resource: PragmaInvocableResource,
  resources: readonly PragmaResource[],
): MissionExecutorOption {
  return MissionExecutorOptionSchema.parse({
    ...projectExecutor(resource),
    description: resource.metadata.description,
    ...(resource.kind === "Expert"
      ? { avatarId: resource.metadata.avatarId }
      : resource.kind === "ExpertTeam"
        ? {
            avatarId: expertTeamCoordinatorAvatarId(resource, resources),
            members: expertTeamMentionCandidates(resource, resources),
          }
        : {}),
    origin: "project",
    readOnly: false,
    customized: false,
    ...(resource.kind === "Flow" && resource.spec.input?.schema !== undefined
      ? { inputSchema: resource.spec.input.schema }
      : {}),
  });
}

export function expertTeamMentionCandidates(
  team: PragmaExpertTeamResource,
  resources: readonly PragmaResource[],
): readonly ExpertMentionCandidate[] {
  const experts = new Map(
    resources
      .filter((resource): resource is PragmaExpertResource => resource.kind === "Expert")
      .map((resource) => [canonicalPragmaResourceRef(resource), resource]),
  );
  return team.spec.members.map((member) => {
    const expert = experts.get(member.ref);
    if (expert === undefined) {
      throw new Error(`ExpertTeam member not found: ${member.ref}.`);
    }
    return {
      ref: member.ref,
      name: expert.metadata.name,
      description: expert.metadata.description,
      avatarId: expert.metadata.avatarId,
    };
  });
}
