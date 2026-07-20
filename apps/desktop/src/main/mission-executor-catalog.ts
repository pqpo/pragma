import type { PragmaInvocableResource } from "@pragma/interpreter/ast";

import {
  isMissionExecutorResource,
  missionExecutorRef,
  missionExecutorSnapshot,
  MissionExecutorOptionSchema,
  MissionExecutorSchema,
  type MissionExecutor,
  type MissionExecutorOption,
} from "../shared/desktop-api.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";
import type { DesktopSystemExpertRegistry } from "./system-expert-registry.ts";

export interface MissionExecutorCatalog {
  list(): Promise<readonly MissionExecutorOption[]>;
  resolve(ref: string): Promise<MissionExecutor | undefined>;
}

export function createMissionExecutorCatalog(options: {
  readonly project: PragmaProjectStore;
  readonly systemExperts: DesktopSystemExpertRegistry;
}): MissionExecutorCatalog {
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
