import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPragmaManagementTools,
  type PragmaAgentDslProjectPort,
} from "@pragma/built-in-agents";

import type { MissionExecutor, PragmaProjectSnapshot } from "../../../shared/contracts/index.ts";
import { createDesktopPragmaAgentMissionPort } from "../built-in-agents/pragma-agent-task-adapter.ts";
import { createMissionCreator } from "./mission-creator.ts";
import type { MissionExecutorCatalog } from "./mission-executor-catalog.ts";
import type { MissionRunner } from "./mission-runner.ts";
import { createMissionStore } from "./mission-store.ts";
import { createPragmaProjectStore } from "../projects/pragma-project-store.ts";
import { createContextStoreStore } from "../context-stores/context-store-store.ts";

// Workspace validation uses real filesystem access; Electron IPC is unused here.
vi.mock("electron", () => ({ BrowserWindow: class {}, dialog: {}, ipcMain: {} }));

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
    await expect(
      creator.create({
        workspace,
        missionInput: { kind: "prompt", value: "Mount a draft directly" },
        executorRef: executor.ref,
        contextMounts: [
          {
            kind: "context-store-draft",
            draftId: "20000000-0000-4000-8000-000000000001",
          },
        ],
      }),
    ).rejects.toThrow("only be mounted by the knowledge revision tools");
  });

  it("lets the default Agent submit a task against the initial project revision", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const contextStores = createContextStoreStore({ storesPath: join(root, "knowledge") });
    const knowledge = await contextStores.create({
      mode: "blank",
      name: "Product notes",
      description: "Requirements",
    });
    const creator = createMissionCreator({
      missions,
      project,
      contextStores,
      executors: catalog(),
      getDefaultToolPermissionMode: () => "request-approval",
    });
    const run = vi.fn(async (id: string) => await missions.get(id));
    const runner = {
      run,
    } as unknown as MissionRunner;
    const missionPort = createDesktopPragmaAgentMissionPort({
      missions,
      runner,
      creator,
      stateRoot: join(root, "state"),
    });

    const tool = createPragmaManagementTools({
      project: {} as PragmaAgentDslProjectPort,
      missions: missionPort,
    }).find((candidate) => candidate.name === "create_mission")!;
    const input = {
      goal: "Restore the team",
      executorRef: executor.ref,
      workspaceId: workspace,
      contextStoreIds: [knowledge.id],
    };
    expect(JSON.stringify(tool.inputSchema)).toContain("Absolute path");
    for (const workspaceId of ["default", "workspace", join(root, "missing")]) {
      await expect(
        tool.call({ ...input, workspaceId }, undefined, { toolCallId: "tool-call-1" }),
      ).resolves.toMatchObject({
        isError: true,
        details: { code: "invalid_input", message: expect.stringMatching(/workspace/iu) },
      });
    }
    expect(await missions.list()).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();

    // The selected store changes after admission but before creation. Recheck
    // readiness inside the same revision lock that persists the Mission.
    const withRevisionLock = contextStores.withRevisionLock.bind(contextStores);
    vi.spyOn(contextStores, "withRevisionLock").mockImplementationOnce(
      async (id, operation) =>
        await withRevisionLock(id, async () => {
          await writeFile(
            join(root, "knowledge", knowledge.id, "store.json"),
            JSON.stringify({ ...knowledge, status: "needs_attention" }),
          );
          return await operation();
        }),
    );
    await expect(tool.call(input, undefined, { toolCallId: "tool-call-1" })).resolves.toMatchObject(
      { isError: true, details: { code: "unavailable" } },
    );
    expect(await missions.list()).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
    await writeFile(join(root, "knowledge", knowledge.id, "store.json"), JSON.stringify(knowledge));

    await expect(
      tool.call({ ...input, contextStoreIds: [knowledge.id, knowledge.id] }, undefined, {
        toolCallId: "tool-call-1",
      }),
    ).resolves.toMatchObject({ isError: true, details: { code: "invalid_input" } });
    const missingKnowledge = await tool.call(
      { ...input, contextStoreIds: ["20000000-0000-4000-8000-000000000099"] },
      undefined,
      { toolCallId: "tool-call-1" },
    );
    expect(missingKnowledge).toMatchObject({ isError: true, details: { code: "not_found" } });
    expect(await missions.list()).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();

    // A problem reading an unrelated catalog must not block a selected store.
    const list = vi
      .spyOn(contextStores, "list")
      .mockRejectedValue(new Error("Unrelated store catalog failed."));
    const result = await tool.call(input, undefined, { toolCallId: "tool-call-1" });
    expect(result.isError).not.toBe(true);
    expect(list).not.toHaveBeenCalled();
    const mission = result.details;

    expect(mission).toMatchObject({
      goal: "Restore the team",
      executorRef: executor.ref,
      workspaceId: workspace,
      contextStoreIds: [knowledge.id],
    });
    const stored = (await missions.list())[0]!;
    expect((await missions.get(stored.id)).contextMounts).toEqual([
      { kind: "context-store", storeId: knowledge.id },
    ]);
    expect((await project.get()).revision).toBe(1);
    // Retrying the same approved tool call reuses the persisted Mission.
    const retried = await tool.call(input, undefined, { toolCallId: "tool-call-1" });
    expect(retried.details).toEqual(mission);
    expect(await missions.list()).toHaveLength(1);
    expect(run).toHaveBeenCalled();
    const withoutKnowledge = await tool.call({ ...input, contextStoreIds: undefined }, undefined, {
      toolCallId: "tool-call-2",
    });
    expect(withoutKnowledge.isError).not.toBe(true);
    expect(withoutKnowledge.details).toMatchObject({ contextStoreIds: [] });
  });

  it("validates and persists exact structured Flow input", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const flow = {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
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

  it("checks storage capacity and pins a branch to the latest project revision", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    await project.publish({ expectedRevision: 0, resources: [] });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const source = await missions.create({
      workspace: { path: workspace, basename: "workspace" },
      goal: "Continue with updated experts",
      project: { id: "studio", revision: 1 },
      executor,
    });
    const executionId = "00000000-0000-4000-8000-000000000041";
    const settled = await missions.updateExecution(source.id, {
      id: executionId,
      inputMessageId: source.initialMessageId,
      status: "succeeded",
      startedAt: "2026-08-20T00:00:00.000Z",
      finishedAt: "2026-08-20T00:01:00.000Z",
    });
    await project.publish({
      expectedRevision: 1,
      resources: [],
      artifacts: new Map([["updated-experts.txt", "revision 2"]]),
    });
    let capacityChecks = 0;
    const creator = createMissionCreator({
      missions,
      project,
      executors: catalog(),
      getDefaultToolPermissionMode: () => "request-approval",
      assertStorageWriteAllowed: () => {
        capacityChecks += 1;
      },
    });
    const firstTurn = (await missions.readTimelinePage(source.id, { limit: 10 })).turns[0]!;
    const user = {
      ...firstTurn.message,
      kind: "user" as const,
      timelineSequence: firstTurn.sequence,
    };

    const branch = await creator.createBranch({
      source: settled,
      expectedExecutionId: executionId,
      expectedMessageId: "assistant:final",
      history: [
        user,
        {
          id: "assistant:final",
          kind: "assistant",
          content: "Done.",
          executionId,
          timelineSequence: 1,
          streaming: false,
          createdAt: "2026-08-20T00:01:00.000Z",
        },
      ],
    });

    expect(capacityChecks).toBe(1);
    expect(branch.project.revision).toBe(2);
    expect(branch.execution).toBeUndefined();
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
