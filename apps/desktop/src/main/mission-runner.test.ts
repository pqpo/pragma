import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStaticRuntimeResolver,
  defineRuntimeDriver,
  type RuntimeDriverSessionContext,
} from "@pragma/core";
import type {
  PragmaExpertResource,
  PragmaFlowResource,
  PragmaRuntimeProfileResource,
} from "@pragma/interpreter/ast";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import type { CapabilityStore } from "./capability-store.ts";
import { createMissionRunner } from "./mission-runner.ts";
import { createMissionStore, type MissionStore } from "./mission-store.ts";
import { createPragmaProjectStore } from "./pragma-project-store.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryPaths.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("MissionRunner", () => {
  it("streams rich chat activity and interrupts the active execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-interrupt-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expertFixture()],
    });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Inspect before stopping",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: snapshot.resources.find((resource) => resource.kind === "Expert")!,
    });
    const cancelTurn = vi.fn();
    const runtime = defineRuntimeDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: () => ({ id: "runtime" }),
      restoreSession: () => ({ id: "runtime" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      async startTurn(_session, turn) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        turn.stream.write({
          runId: turn.runId,
          source: turn.source,
          type: "thought.delta",
          payload: { contentType: "text", delta: "Checking constraints." },
        });
        turn.stream.write({
          runId: turn.runId,
          source: turn.source,
          type: "tool.started",
          payload: {
            toolCallId: "tool-1",
            toolName: "read_file",
            kind: "tool",
            inputPreview: { path: "README.md" },
          },
        });
        await new Promise<void>((_resolve, reject) => {
          turn.signal.addEventListener("abort", () => reject(turn.signal.reason), { once: true });
        });
        return { outputText: "unreachable", runtimeSessionId: "runtime" };
      },
      mapEvent: () => ({ events: [] }),
      cancelTurn,
      closeSession: () => undefined,
    });
    const runner = createMissionRunner({
      missions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "state"),
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    });
    const updates = vi.fn();
    const unsubscribe = runner.subscribeChat(updates);

    await runner.run(mission.id);
    await vi.waitFor(async () => {
      const chat = await runner.getChat({ id: mission.id, limit: 50 });
      expect(chat.execution?.interruptible).toBe(true);
      expect(chat.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "thinking", content: "Checking constraints." }),
          expect.objectContaining({ kind: "tool", toolName: "read_file", status: "running" }),
        ]),
      );
    });

    const interrupted = await runner.interrupt(mission.id);
    expect(interrupted.execution?.status).toBe("cancelled");
    expect(cancelTurn).toHaveBeenCalledTimes(1);
    const settledChat = await runner.getChat({ id: mission.id, limit: 50 });
    expect(settledChat.execution?.interruptible).toBe(false);
    expect(settledChat.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "thinking", content: "Checking constraints." }),
        expect.objectContaining({ kind: "tool", toolName: "read_file", status: "failed" }),
      ]),
    );
    expect(updates).toHaveBeenCalled();
    unsubscribe();
  });

  it("compiles and runs the resource pinned by Mission v3", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-runner-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expertFixture()],
    });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Prepare a concise answer",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: snapshot.resources.find((resource) => resource.kind === "Expert")!,
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
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    });

    const firstRunPromise = runner.run(mission.id);
    const duplicateRunPromise = runner.run(mission.id);
    await expect(runner.delete(mission.id)).rejects.toThrow(
      "Wait for the current mission operation to finish.",
    );
    const [firstRun, duplicateRun] = await Promise.all([firstRunPromise, duplicateRunPromise]);
    expect(firstRun.execution?.status).toBe("running");
    expect(duplicateRun.execution?.id).toBe(firstRun.execution?.id);
    expect(firstRun.execution?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: 3_000 },
    );
    await expect(runner.getChat({ id: mission.id, limit: 50 })).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", content: "writer:Prepare a concise answer" }),
      ]),
    });

    const followup = runner.sendMessage({
      id: mission.id,
      content: "Make it shorter",
      requestId: "00000000-0000-4000-8000-000000000010",
    });
    await expect(
      runner.sendMessage({
        id: mission.id,
        content: "This turn must not be queued concurrently",
        requestId: "00000000-0000-4000-8000-000000000011",
      }),
    ).rejects.toThrow("Wait for the current mission operation to finish.");
    await expect(runner.delete(mission.id)).rejects.toThrow(
      "Wait for the current mission operation to finish.",
    );
    await followup;
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: 3_000 },
    );
    const conversation = await runner.getChat({ id: mission.id, limit: 50 });
    expect(
      conversation.entries
        .filter((entry) => entry.kind === "user" || entry.kind === "assistant")
        .map((entry) => entry.content),
    ).toEqual([
      "Prepare a concise answer",
      "writer:Prepare a concise answer",
      "Make it shorter",
      "writer:Make it shorter",
    ]);
    expect(startTurn).toHaveBeenCalledTimes(2);
    await expect(runner.listWorkItems(mission.id)).resolves.toEqual([
      expect.objectContaining({ kind: "expert", status: "succeeded", executorId: "writer" }),
    ]);
  });

  it("round-trips a Flow human interaction and resolves same-id resources by kind", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-human-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const expert = expertFixture();
    expert.metadata.id = "review";
    const runtimeProfile = runtimeFixture("unregistered");
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeProfile, expert, approvalFlowFixture()],
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
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    });

    await runner.run(mission.id);
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("waiting"),
      { timeout: 3_000 },
    );
    const waitingMission = await missions.get(mission.id);
    const rejectRecoveryReference = vi.fn(async () => {
      throw new Error("timeline preflight failed");
    });
    const recoveryMissions = {
      ...missions,
      appendExecutionReference: rejectRecoveryReference,
    } satisfies MissionStore;
    const restartingRunner = createMissionRunner({
      missions: recoveryMissions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "state"),
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    });
    await expect(restartingRunner.run(mission.id)).rejects.toThrow("timeline preflight failed");
    expect(rejectRecoveryReference).toHaveBeenCalledWith({
      missionId: mission.id,
      inputMessageId: waitingMission.execution?.inputMessageId,
      executionId: waitingMission.execution?.id,
      createdAt: waitingMission.execution?.startedAt,
    });
    await expect(runner.listWorkItems(mission.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "flow" }),
        expect.objectContaining({ kind: "human-task", status: "waiting" }),
      ]),
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

  it("projects and truncates replies without copying assistant text into messages.jsonl", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-reply-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expertFixture()],
    });
    const storedMissions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await storedMissions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Persist this reply",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: snapshot.resources.find((resource) => resource.kind === "Expert")!,
    });
    const runtime = defineRuntimeDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: () => ({ id: "runtime" }),
      restoreSession: () => ({ id: "runtime" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: (_session, turn) => ({
        outputText:
          turn.rawQuery === "Return oversized reply"
            ? "x".repeat(200_001)
            : `writer:${turn.rawQuery}`,
        runtimeSessionId: "runtime",
      }),
      mapEvent: () => ({ events: [] }),
      closeSession: () => undefined,
    });
    const runner = createMissionRunner({
      missions: storedMissions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "state"),
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    });
    await runner.run(mission.id);
    await vi.waitFor(
      async () =>
        expect((await storedMissions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: 3_000 },
    );
    await runner.sendMessage({
      id: mission.id,
      content: "Return oversized reply",
      requestId: "00000000-0000-4000-8000-000000000020",
    });
    await vi.waitFor(
      async () =>
        expect((await storedMissions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: 3_000 },
    );
    const chat = await runner.getChat({ id: mission.id, limit: 50 });
    const reply = chat.entries.filter((entry) => entry.kind === "assistant").at(-1);
    expect(reply?.kind).toBe("assistant");
    if (reply?.kind !== "assistant") throw new Error("Expected an assistant reply.");
    expect(reply.content).toHaveLength(200_000);
    expect(reply.content.endsWith("…")).toBe(true);
    const timeline = await readFile(join(root, "missions", mission.id, "messages.jsonl"), "utf8");
    expect(timeline).not.toContain('"kind":"assistant"');
    expect(timeline).not.toContain("x".repeat(1_000));
  });
});

function expertFixture(): PragmaExpertResource {
  return {
    apiVersion: "pragma/v2",
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
      runtime: { ref: "runtime-profile:writer.runtime@1.0.0" },
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}

function runtimeFixture(runtimeId = "fake"): PragmaRuntimeProfileResource {
  return {
    apiVersion: "pragma/v2",
    kind: "RuntimeProfile",
    metadata: {
      id: "writer.runtime",
      version: "1.0.0",
      name: "Writer Runtime",
      description: "Runtime used by the test writer.",
      tags: [],
    },
    spec: {
      adapter: "pragma.runtime.profile@v1",
      config: { runtimeId },
    },
  };
}

function approvalFlowFixture(): PragmaFlowResource {
  return {
    apiVersion: "pragma/v2",
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
