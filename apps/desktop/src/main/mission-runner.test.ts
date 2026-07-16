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
import { createMissionStore, type MissionStore } from "./mission-store.ts";
import type { ModelProviderStore } from "./model-provider-store.ts";
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
    const snapshot = await project.publish({ expectedRevision: 0, resources: [expertFixture()] });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Inspect before stopping",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: snapshot.resources[0]!,
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
      modelProviders: {} as ModelProviderStore,
      runtimes: createRuntimeRegistry({ runtimes: [runtime], defaultRuntime: "fake" }),
    });
    const updates = vi.fn();
    const unsubscribe = runner.subscribeChat(updates);

    await runner.run(mission.id);
    await vi.waitFor(async () => {
      const chat = await runner.getChat(mission.id);
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
    const settledChat = await runner.getChat(mission.id);
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
    expect((await missions.get(mission.id)).messages.at(-1)?.content).toBe(
      "writer:Prepare a concise answer",
    );

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
    const conversation = (await missions.get(mission.id)).messages;
    expect(conversation.map((message) => message.content)).toEqual([
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

  it("keeps execution success independent from reply persistence and truncates long replies", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-reply-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({ expectedRevision: 0, resources: [expertFixture()] });
    const storedMissions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await storedMissions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Persist this reply",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: snapshot.resources[0]!,
    });
    let rejectAssistantReply = true;
    const missions: MissionStore = {
      ...storedMissions,
      appendMessage: async (id, message) => {
        if (rejectAssistantReply && message.role === "assistant") {
          throw new Error("reply storage unavailable");
        }
        return await storedMissions.appendMessage(id, message);
      },
    };
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
      missions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "state"),
      modelProviders: {} as ModelProviderStore,
      runtimes: createRuntimeRegistry({ runtimes: [runtime], defaultRuntime: "fake" }),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runner.run(mission.id);
    await vi.waitFor(
      async () =>
        expect((await storedMissions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: 3_000 },
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to persist Mission reply"),
      expect.objectContaining({ message: "reply storage unavailable" }),
    );

    rejectAssistantReply = false;
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
    const reply = (await storedMissions.get(mission.id)).messages.at(-1);
    expect(reply?.role).toBe("assistant");
    expect(reply?.content).toHaveLength(200_000);
    expect(reply?.content.endsWith("…")).toBe(true);
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
