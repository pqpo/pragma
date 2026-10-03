import { basename } from "node:path";

import { MissionExecutorSchema, type Mission } from "@pragma/shared";

import type { LocalHostRunRequest, ResolvedRunExecutor } from "../run.ts";
import type { MissionControllerStore } from "./controller/mission-controller-store.ts";
import { MissionStoreError, type MissionStore } from "./repository/mission-store.ts";

/** Materialize only new reservations. Historical controller facts remain their own authority. */
export function createNodeMissionRepository(options: {
  readonly store: MissionStore;
  readonly controller: MissionControllerStore;
  readonly readDefaultProject?: (() => Promise<Mission["project"] | undefined>) | undefined;
}) {
  return {
    store: options.store,
    async ensureFreshMission(input: {
      readonly missionId: string;
      readonly request: LocalHostRunRequest;
      readonly executor: ResolvedRunExecutor;
    }): Promise<Mission | undefined> {
      try {
        return await options.store.get(input.missionId);
      } catch (error) {
        if (!(error instanceof MissionStoreError) || error.code !== "mission_not_found")
          throw error;
      }
      const snapshot = await options.controller.readSnapshot({ missionId: input.missionId });
      if (
        snapshot.events.some(
          (event) => event.type === "mission.created" || event.type === "run.started",
        )
      ) {
        return undefined;
      }
      const descriptorProject = input.executor.descriptor.project;
      const project =
        descriptorProject === undefined
          ? await options.readDefaultProject?.()
          : { id: descriptorProject.projectId, revision: descriptorProject.revision };
      if (project === undefined) return undefined;
      const workspacePath = input.request.workspace.canonicalPath;
      const flowInput =
        input.request.command === "flow.run"
          ? input.request.input === undefined
            ? {}
            : input.request.input
          : undefined;
      if (
        flowInput !== undefined &&
        (typeof flowInput !== "object" || flowInput === null || Array.isArray(flowInput))
      ) {
        // The v11 product envelope stores object Flow input. Core accepts
        // other values when the Flow has no input schema; preserve them in the
        // existing controller-fact format without changing Mission storage.
        return undefined;
      }
      return await options.store.create({
        id: input.missionId,
        initialMessageId: input.request.requestId,
        workspace: { path: workspacePath, basename: basename(workspacePath) || workspacePath },
        goal: input.request.prompt ?? input.executor.descriptor.name,
        ...(flowInput === undefined
          ? {}
          : { flowInput: flowInput as Readonly<Record<string, unknown>> }),
        project,
        executor: MissionExecutorSchema.parse({
          kind: input.request.executor.kind,
          ref: `${input.request.executor.kind}:${input.request.executor.id}`,
          name: input.executor.descriptor.name,
        }),
      });
    },
  };
}
