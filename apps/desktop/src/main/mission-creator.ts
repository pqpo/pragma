import { basename } from "node:path";

import type {
  DesktopToolPermissionMode,
  Mission,
  MissionModelOverride,
} from "../shared/desktop-api.ts";
import type { MissionExecutorCatalog } from "./mission-executor-catalog.ts";
import type { MissionStore } from "./mission-store.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";
import { validateWorkspace } from "./workspace-scope.ts";

export interface MissionCreator {
  create(input: {
    readonly workspace: string;
    readonly goal: string;
    readonly executorRef: string;
    readonly toolPermissionMode?: DesktopToolPermissionMode | undefined;
    readonly modelOverride?: MissionModelOverride | undefined;
  }): Promise<Mission>;
}

export function createMissionCreator(options: {
  readonly missions: MissionStore;
  readonly project: PragmaProjectStore;
  readonly executors: MissionExecutorCatalog;
  readonly getDefaultToolPermissionMode: () =>
    | DesktopToolPermissionMode
    | Promise<DesktopToolPermissionMode>;
}): MissionCreator {
  return {
    async create(input) {
      const validation = await validateWorkspace(input.workspace);
      if (!validation.ok) {
        throw new Error("The selected workspace must be an accessible, writable directory.");
      }

      const project = await options.project.ensurePublished();
      const executor = await options.executors.resolve(input.executorRef, project);
      if (executor === undefined) {
        throw new Error(`Mission executor not found: ${input.executorRef}`);
      }
      if (executor.kind === "flow" && input.modelOverride !== undefined) {
        throw new Error("Flow missions do not support a model override.");
      }
      if (input.modelOverride !== undefined) {
        await options.executors.validateModelOverride(executor.ref, input.modelOverride, project);
      }

      return await options.missions.create({
        workspace: { path: input.workspace, basename: basename(input.workspace) },
        goal: input.goal,
        project: { id: project.projectId, revision: project.revision },
        executor,
        ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
        toolPermissionMode:
          input.toolPermissionMode ?? (await options.getDefaultToolPermissionMode()),
      });
    },
  };
}
