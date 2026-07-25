import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { MissionExecutor, PragmaProjectSnapshot } from "../shared/desktop-api.ts";
import { createDesktopDefaultAgentTaskPort } from "./default-agent-task-adapter.ts";
import { createMissionCreator } from "./mission-creator.ts";
import type { MissionExecutorCatalog } from "./mission-executor-catalog.ts";
import type { MissionRunner } from "./mission-runner.ts";
import { createMissionStore } from "./mission-store.ts";
import { createPragmaProjectStore } from "./pragma-project-store.ts";

const temporaryPaths: string[] = [];
const executor: MissionExecutor = {
  kind: "expert",
  ref: "expert:2qgbztga4kz2qz51",
  name: "Pragma",
};

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("MissionCreator", () => {
  it("publishes an initial project and uses one snapshot for executor validation", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const resolvedSnapshots: PragmaProjectSnapshot[] = [];
    const validatedSnapshots: PragmaProjectSnapshot[] = [];
    const executors = catalog({
      resolve: async (_ref, snapshot) => {
        resolvedSnapshots.push(snapshot);
        await project.publish({
          expectedRevision: snapshot.revision,
          resources: snapshot.resources,
          artifacts: new Map([["concurrent-change.txt", "new head"]]),
        });
        return executor;
      },
      validateModelOverride: async (_ref, _override, snapshot) => {
        validatedSnapshots.push(snapshot);
      },
    });
    const creator = createMissionCreator({
      missions,
      project,
      executors,
      getDefaultToolPermissionMode: () => "full-access",
    });
    const modelOverride = { providerId: "provider", modelId: "model" };

    const mission = await creator.create({
      workspace,
      missionInput: { kind: "prompt", value: "Restore the experts" },
      executorRef: executor.ref,
      modelOverride,
    });

    expect(mission).toMatchObject({
      project: { id: "studio", revision: 1 },
      executor,
      modelOverride,
      toolPermissionMode: "full-access",
    });
    expect((await project.get()).revision).toBe(2);
    expect(resolvedSnapshots).toHaveLength(1);
    expect(validatedSnapshots[0]).toBe(resolvedSnapshots[0]);
    await expect(project.openRevision(mission.project.revision)).resolves.toBeDefined();
  });

  it("lets the default Agent submit a task against the initial project revision", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const creator = createMissionCreator({
      missions,
      project,
      executors: catalog(),
      getDefaultToolPermissionMode: () => "request-approval",
    });
    const runner = {
      run: async (id: string) => await missions.get(id),
    } as unknown as MissionRunner;
    const tasks = createDesktopDefaultAgentTaskPort({
      missions,
      runner,
      creator,
      stateRoot: join(root, "state"),
    });

    const task = await tasks.submit({
      goal: "Restore the team",
      executorRef: executor.ref,
      workspaceId: workspace,
      operationId: "tool-call-1",
    });

    expect(task.details).toMatchObject({
      project: { id: "studio", revision: 1 },
      executor,
    });
    expect((await project.get()).revision).toBe(1);
  });

  it("validates and persists exact structured Flow input", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const flow = {
      apiVersion: "pragma/v3" as const,
      kind: "Flow" as const,
      metadata: {
        id: "5gdqkvfwb19p5rj7",
        name: "Issue fix",
        description: "Fix one issue",
        tags: [],
      },
      spec: {
        input: {
          schema: {
            type: "object" as const,
            properties: { issueId: { type: "string" as const } },
            required: ["issueId"],
            additionalProperties: false as const,
          },
        },
        limits: { maxNodeVisits: 10 },
        graph: {
          start: "done",
          steps: {
            done: {
              human: {
                selectionMode: "single" as const,
                prompt: { segments: [{ text: "Done?" }] },
                options: [
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No" },
                ],
              },
            },
          },
          loops: {},
          transitions: { done: { end: true as const } },
        },
      },
    };
    await project.publish({ expectedRevision: 0, resources: [flow] });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const flowExecutor: MissionExecutor = {
      kind: "flow",
      ref: "flow:5gdqkvfwb19p5rj7",
      name: "Issue fix",
    };
    const creator = createMissionCreator({
      missions,
      project,
      executors: catalog({ resolve: async () => flowExecutor }),
      getDefaultToolPermissionMode: () => "request-approval",
    });

    const mission = await creator.create({
      workspace,
      missionInput: { kind: "flow", value: { issueId: "CCAS-42" } },
      executorRef: flowExecutor.ref,
    });

    expect(mission.flowInput).toEqual({ issueId: "CCAS-42" });
    await expect(
      creator.create({
        workspace,
        missionInput: { kind: "flow", value: { issueId: "CCAS-42", extra: true } },
        executorRef: flowExecutor.ref,
      }),
    ).rejects.toThrow();
  });
});

function catalog(
  overrides: {
    readonly resolve?: MissionExecutorCatalog["resolve"];
    readonly validateModelOverride?: MissionExecutorCatalog["validateModelOverride"];
  } = {},
): MissionExecutorCatalog {
  return {
    list: async () => [],
    resolve: overrides.resolve ?? (async () => executor),
    getModelOptions: async () => {
      throw new Error("unused");
    },
    validateModelOverride: overrides.validateModelOverride ?? (async () => undefined),
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-mission-creator-"));
  temporaryPaths.push(root);
  return root;
}
