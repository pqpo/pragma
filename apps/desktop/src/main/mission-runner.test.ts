import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRuntimeRegistry,
  defineRuntimeDriver,
  type RuntimeDriverSessionContext,
} from "@pragma/core";
import type { PragmaExpertResource, PragmaFlowResource } from "@pragma/interpreter/ast";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import type { CapabilityStore } from "./capability-store.ts";
import { createMissionRunner } from "./mission-runner.ts";
import { createMissionStore } from "./mission-store.ts";
import type { ModelProviderStore } from "./model-provider-store.ts";
import { createPragmaProjectStore } from "./pragma-project-store.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("MissionRunner", () => {
  it("compiles and runs the resource pinned by Mission v2", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-runner-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({ expectedRevision: 0, resources: [expertFixture()] });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Prepare a concise answer",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: snapshot.resources[0]!,
    });
    const startTurn = vi.fn(
      (
        session: { context: RuntimeDriverSessionContext; id: string },
        turn: { rawQuery: string },
      ) => ({
        outputText: `${session.context.agent.id}:${turn.rawQuery}`,
        runtimeSessionId: session.id,
      }),
    );
    const runtime = defineRuntimeDriver<
      never,
      { context: RuntimeDriverSessionContext; id: string }
    >({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: (context) => ({ context, id: `runtime-${context.systemSessionId}` }),
      restoreSession: (context) => ({ context, id: context.request.runtimeSession!.id }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn,
      mapEvent: () => ({ events: [] }),
      closeSession: () => undefined,
    });
    const runner = createMissionRunner({
      missions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "state"),
      modelProviders: {} as ModelProviderStore,
      runtimes: createRuntimeRegistry({ runtimes: [runtime], defaultRuntime: "fake" }),
    });

    const [firstRun, duplicateRun] = await Promise.all([
      runner.run(mission.id),
      runner.run(mission.id),
    ]);
    expect(firstRun.execution?.status).toBe("running");
    expect(duplicateRun.execution?.id).toBe(firstRun.execution?.id);
    expect(firstRun.execution?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: 3_000 },
    );
    expect(startTurn).toHaveBeenCalledTimes(1);
  });

  it("round-trips a Flow human interaction and resolves same-id resources by kind", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-human-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const expert = expertFixture();
    expert.metadata.id = "review";
    expert.spec.runtime = { id: "unregistered" };
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [expert, approvalFlowFixture()],
    });
    const flow = snapshot.resources.find((resource) => resource.kind === "Flow")!;
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Review the release",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: flow,
    });
    const runtime = defineRuntimeDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: () => ({ id: "runtime" }),
      restoreSession: () => ({ id: "runtime" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: () => ({ outputText: "unused", runtimeSessionId: "runtime" }),
      mapEvent: () => ({ events: [] }),
      closeSession: () => undefined,
    });
    const runner = createMissionRunner({
      missions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "state"),
      modelProviders: {} as ModelProviderStore,
      runtimes: createRuntimeRegistry({ runtimes: [runtime], defaultRuntime: "fake" }),
    });

    await runner.run(mission.id);
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("waiting"),
      { timeout: 3_000 },
    );
    const interactions = await runner.listHumanInteractions(mission.id);
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.request.kind).toBe("approval");
    await runner.respondToHumanInteraction({
      missionId: mission.id,
      interactionId: interactions[0]!.interactionId,
      requestId: "00000000-0000-4000-8000-000000000001",
      response: { approved: true, decision: "approved" },
    });
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: 3_000 },
    );
  });
});

function expertFixture(): PragmaExpertResource {
  return {
    apiVersion: "pragma/v1",
    kind: "Expert",
    metadata: {
      id: "writer",
      version: "1.0.0",
      name: "Writer",
      description: "Writes concise answers",
      tags: [],
    },
    spec: {
      scope: "Writing",
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}

function approvalFlowFixture(): PragmaFlowResource {
  return {
    apiVersion: "pragma/v1",
    kind: "Flow",
    metadata: {
      id: "review",
      version: "1.0.0",
      name: "Review",
      description: "Requires approval",
      tags: [],
    },
    spec: {
      limits: { maxNodeVisits: 10 },
      graph: {
        start: "approve",
        steps: {
          approve: {
            human: { kind: "approval", prompt: "Approve the release?" },
            version: "1.0.0",
          },
        },
        loops: {},
        transitions: { approve: { end: true } },
      },
    },
  };
}
