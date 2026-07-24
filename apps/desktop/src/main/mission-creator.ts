import { basename } from "node:path";

import { canonicalPragmaResourceRef, type PragmaFlowResource } from "@pragma/interpreter/ast";
import { z } from "zod";

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
    readonly id?: string | undefined;
    readonly workspace: string;
    readonly missionInput:
      | { readonly kind: "prompt"; readonly value: string }
      | { readonly kind: "flow"; readonly value: Readonly<Record<string, unknown>> }
      | { readonly kind: "auto"; readonly value: string };
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
      const missionInput =
        input.missionInput.kind === "auto"
          ? executor.kind === "flow"
            ? {
                kind: "flow" as const,
                value: { goal: input.missionInput.value, workspace: input.workspace },
              }
            : { kind: "prompt" as const, value: input.missionInput.value }
          : input.missionInput;
      if (executor.kind === "flow" && input.modelOverride !== undefined) {
        throw new Error("Flow missions do not support a model override.");
      }
      if (executor.kind === "flow" && missionInput.kind !== "flow") {
        throw new Error("Flow missions require structured Flow input.");
      }
      if (executor.kind !== "flow" && missionInput.kind !== "prompt") {
        throw new Error("Expert and team missions require a prompt.");
      }
      if (input.modelOverride !== undefined) {
        await options.executors.validateModelOverride(executor.ref, input.modelOverride, project);
      }

      const validatedFlowInput =
        executor.kind === "flow" && missionInput.kind === "flow"
          ? validateFlowInput(project.resources, executor.ref, missionInput.value)
          : undefined;
      const flowInput = validatedFlowInput?.value;
      const goal =
        missionInput.kind === "prompt"
          ? missionInput.value
          : summarizeFlowInput(executor.name, flowInput!, validatedFlowInput!.structured);
      return await options.missions.create({
        ...(input.id === undefined ? {} : { id: input.id }),
        workspace: { path: input.workspace, basename: basename(input.workspace) },
        goal,
        ...(validatedFlowInput?.structured === true
          ? { title: titleFromFlowInput(executor.name, flowInput!) }
          : {}),
        ...(flowInput === undefined ? {} : { flowInput }),
        project: { id: project.projectId, revision: project.revision },
        executor,
        ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
        toolPermissionMode:
          input.toolPermissionMode ?? (await options.getDefaultToolPermissionMode()),
      });
    },
  };
}

function validateFlowInput(
  resources: readonly unknown[],
  executorRef: string,
  input: Readonly<Record<string, unknown>>,
): {
  readonly value: Readonly<Record<string, unknown>>;
  readonly structured: boolean;
} {
  const flow = resources.find(
    (resource): resource is PragmaFlowResource =>
      typeof resource === "object" &&
      resource !== null &&
      "kind" in resource &&
      resource.kind === "Flow" &&
      canonicalPragmaResourceRef(resource as PragmaFlowResource) === executorRef,
  );
  if (flow === undefined) throw new Error(`Flow resource not found: ${executorRef}`);
  const schema = flow.spec.input?.schema;
  if (schema === undefined) return { value: structuredClone(input), structured: false };
  return {
    value: z
      .fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
      .parse(input) as Readonly<Record<string, unknown>>,
    structured: true,
  };
}

function summarizeFlowInput(
  flowName: string,
  input: Readonly<Record<string, unknown>>,
  structured: boolean,
): string {
  if (structured) return `${flowName}\n${JSON.stringify(input, null, 2)}`;
  const goal = input["goal"];
  if (typeof goal === "string" && goal.trim() !== "") return goal.trim();
  const firstScalar = Object.values(input).find(
    (value) =>
      (typeof value === "string" && value.trim() !== "") ||
      typeof value === "number" ||
      typeof value === "boolean",
  );
  if (firstScalar !== undefined) return `${flowName}: ${String(firstScalar)}`;
  const serialized = JSON.stringify(input, null, 2);
  return serialized === "{}" ? flowName : `${flowName}\n${serialized}`;
}

function titleFromFlowInput(flowName: string, input: Readonly<Record<string, unknown>>): string {
  const firstScalar = Object.values(input).find(
    (value) =>
      (typeof value === "string" && value.trim() !== "") ||
      typeof value === "number" ||
      typeof value === "boolean",
  );
  return firstScalar === undefined ? flowName : `${flowName}: ${String(firstScalar)}`;
}
