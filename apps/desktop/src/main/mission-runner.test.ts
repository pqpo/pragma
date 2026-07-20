import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStaticRuntimeResolver,
  defineExpert,
  defineRuntimeDriver,
  type RuntimeDriverSessionContext,
  type RuntimeModelSelection,
  type RuntimeResolver,
} from "@pragma/core";
import type {
  PragmaExpertResource,
  PragmaFlowResource,
  PragmaRuntimeProfileResource,
} from "@pragma/interpreter/ast";
import { afterEach, describe, expect, it, vi } from "vitest";

import { missionExecutorSnapshot } from "../shared/desktop-api.ts";
import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import type { CapabilityStore } from "./capability-store.ts";
import { createMissionRunner } from "./mission-runner.ts";
import { createMissionStore, type MissionStore } from "./mission-store.ts";
import { createPragmaProjectStore } from "./pragma-project-store.ts";

const temporaryPaths: string[] = [];
const settlementTimeoutMs = 10_000;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryPaths.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("MissionRunner", { timeout: 15_000 }, () => {
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
      executor: missionExecutorSnapshot(
        snapshot.resources.find((resource) => resource.kind === "Expert")!,
      ),
      toolPermissionMode: "full-access",
    });
    const cancelTurn = vi.fn();
    const runtime = defineRuntimeDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: () => ({ id: "runtime" }),
      restoreSession: () => ({ id: "runtime" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      async startTurn(_session, turn) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        for (const delta of "Checking constraints.") {
          turn.stream.write({
            runId: turn.runId,
            source: turn.source,
            type: "thought.delta",
            payload: { contentType: "text", delta },
          });
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
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
    const runtimeResolver = createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: "fake",
    });
    const runtimesForToolPermissionMode = vi.fn(() => runtimeResolver);
    const runner = createMissionRunner({
      missions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "state"),
      runtimes: runtimeResolver,
      runtimesForToolPermissionMode,
    });
    const updates = vi.fn();
    const unsubscribe = runner.subscribeChat(updates);

    await runner.run(mission.id);
    expect(runtimesForToolPermissionMode).toHaveBeenCalledWith("full-access");
    await vi.waitFor(
      async () => {
        const chat = await runner.getChat({ id: mission.id, limit: 50 });
        expect(chat.execution?.interruptible).toBe(true);
        expect(chat.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "thinking", content: "Checking constraints." }),
            expect.objectContaining({ kind: "tool", toolName: "read_file", status: "running" }),
          ]),
        );
      },
      { timeout: settlementTimeoutMs },
    );

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
    const patchUpdates = updates.mock.calls
      .map(([update]) => update)
      .filter((update) => update.kind === "patch");
    expect(patchUpdates.length).toBeGreaterThanOrEqual("Checking constraints.".length + 1);
    expect(patchUpdates.flatMap((update) => update.patches)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "entry.upsert",
          entry: expect.objectContaining({ kind: "thinking" }),
        }),
        expect.objectContaining({
          type: "entry.upsert",
          entry: expect.objectContaining({ kind: "tool" }),
        }),
      ]),
    );
    unsubscribe();
  });

  it("keeps the captured live answer when the execution settles during a chat read", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-chat-settlement-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expertFixture()],
    });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Keep the final Codex answer visible",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: missionExecutorSnapshot(
        snapshot.resources.find((resource) => resource.kind === "Expert")!,
      ),
    });
    let announceDelta = (): void => undefined;
    const deltaWritten = new Promise<void>((resolve) => {
      announceDelta = resolve;
    });
    let finishTurn = (): void => undefined;
    const turnCanFinish = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    const runtime = defineRuntimeDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "codex-local", displayName: "Codex" },
      createSession: () => ({ id: "codex-thread" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      async startTurn(_session, turn) {
        turn.stream.write({
          runId: turn.runId,
          source: turn.source,
          type: "message.delta",
          payload: { role: "assistant", contentType: "text", delta: "Codex answer" },
        });
        announceDelta();
        await turnCanFinish;
        return { outputText: "Codex answer", runtimeSessionId: "codex-thread" };
      },
      mapEvent: () => ({ events: [] }),
      closeSession: () => undefined,
    });
    const runtimeResolver = createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: "fake",
    });
    const runner = createMissionRunner({
      missions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "state"),
      runtimes: runtimeResolver,
    });

    await runner.run(mission.id);
    await deltaWritten;

    const openRevision = project.openRevision.bind(project);
    let enterProjectRead = (): void => undefined;
    const projectReadEntered = new Promise<void>((resolve) => {
      enterProjectRead = resolve;
    });
    let releaseProjectRead = (): void => undefined;
    const projectReadCanFinish = new Promise<void>((resolve) => {
      releaseProjectRead = resolve;
    });
    vi.spyOn(project, "openRevision").mockImplementationOnce(async (revision) => {
      enterProjectRead();
      await projectReadCanFinish;
      return await openRevision(revision);
    });

    const racedSnapshot = runner.getChat({ id: mission.id, limit: 50 });
    await projectReadEntered;
    finishTurn();
    try {
      await vi.waitFor(
        async () => {
          const settled = await runner.getChat({ id: mission.id, limit: 50 });
          expect(settled.entries).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                kind: "assistant",
                content: "Codex answer",
                timelineSequence: expect.any(Number),
              }),
            ]),
          );
          expect(settled.execution).toMatchObject({ status: "succeeded", interruptible: false });
        },
        { timeout: settlementTimeoutMs },
      );
    } finally {
      releaseProjectRead();
    }

    await expect(racedSnapshot).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", content: "Codex answer" }),
      ]),
      execution: { status: "succeeded", interruptible: false },
    });
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
      executor: missionExecutorSnapshot(
        snapshot.resources.find((resource) => resource.kind === "Expert")!,
      ),
      modelOverride: {
        providerId: "provider",
        modelId: "model",
        thinkingLevel: "high",
      },
    });
    const startTurn = vi.fn(
      (
        session: { context: RuntimeDriverSessionContext; id: string },
        turn: { rawQuery: string; modelSelection?: RuntimeModelSelection | undefined },
      ) => ({
        outputText: `${session.context.agent.id}:${turn.rawQuery}`,
        runtimeSessionId: session.id,
      }),
    );
    const createSession = vi.fn((context: RuntimeDriverSessionContext) => ({
      context,
      id: `runtime-${context.systemSessionId}`,
    }));
    const runtime = defineRuntimeDriver<
      never,
      { context: RuntimeDriverSessionContext; id: string }
    >({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession,
      restoreSession: (context) => ({ context, id: context.request.runtimeSession!.id }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn,
      mapEvent: () => ({ events: [] }),
      closeSession: () => undefined,
    });
    const runtimeResolver = createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: "fake",
    });
    const runtimesForToolPermissionMode = vi.fn(() => runtimeResolver);
    const runner = createMissionRunner({
      missions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "state"),
      runtimes: runtimeResolver,
      runtimesForToolPermissionMode,
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
      { timeout: settlementTimeoutMs },
    );
    await expect(runner.getRuntimeBinding(mission.id)).resolves.toMatchObject({
      runtimeId: "fake",
      revision: 1,
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          modelSelection: {
            model: { providerId: "provider", modelId: "model" },
            thinkingLevel: "high",
          },
        }),
      }),
    );
    await expect(runner.getChat({ id: mission.id, limit: 50 })).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", content: "writer:Prepare a concise answer" }),
      ]),
    });

    const configured = await runner.updateOptions({
      id: mission.id,
      toolPermissionMode: "auto-approve",
      modelOverride: {
        providerId: "provider",
        modelId: "model",
        thinkingLevel: "low",
      },
    });
    expect(configured).toMatchObject({
      toolPermissionMode: "auto-approve",
      modelOverride: { thinkingLevel: "low" },
    });
    expect(runtimesForToolPermissionMode).toHaveBeenCalledWith("auto-approve");

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
      { timeout: settlementTimeoutMs },
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
    expect(startTurn.mock.calls[1]?.[1].modelSelection).toEqual({
      model: { providerId: "provider", modelId: "model" },
      thinkingLevel: "low",
    });
    await expect(runner.listWorkItems(mission.id)).resolves.toEqual([
      expect.objectContaining({ kind: "expert", status: "succeeded", executorId: "writer" }),
    ]);
  });

  it("keeps an existing Mission on its original Runtime and ignores changed Expert defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-runtime-binding-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const expert = expertFixture();
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expert],
    });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Keep this conversation on PI",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: missionExecutorSnapshot(expert),
    });
    const piSelections: (RuntimeModelSelection | undefined)[] = [];
    const piTurns = vi.fn((_session, turn) => {
      piSelections.push(turn.modelSelection);
      return { outputText: "pi", runtimeSessionId: "pi-session" };
    });
    const codexTurns = vi.fn(() => ({ outputText: "codex", runtimeSessionId: "codex-session" }));
    const pi = defineRuntimeDriver<never, { id: string }>({
      descriptor: { id: "pi", kind: "cloud-pi-agent", displayName: "PI" },
      listModels: async () => [
        {
          id: "pi-model",
          displayName: "PI Model",
          provider: { kind: "registered", id: "pi-provider", displayName: "PI Provider" },
        },
      ],
      createSession: () => ({ id: "pi-session" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: piTurns,
      mapEvent: () => ({ events: [] }),
      closeSession: () => undefined,
    });
    const codex = defineRuntimeDriver<never, { id: string }>({
      descriptor: { id: "codex", kind: "codex-local", displayName: "Codex" },
      listModels: async () => [
        {
          id: "codex-model",
          displayName: "Codex Model",
          provider: { kind: "runtime-managed", id: "openai", displayName: "OpenAI" },
        },
      ],
      createSession: () => ({ id: "codex-session" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: codexTurns,
      mapEvent: () => ({ events: [] }),
      closeSession: () => undefined,
    });
    const registered = createStaticRuntimeResolver({
      runtimes: [pi, codex],
      defaultRuntimeId: "pi",
    });
    let defaultRuntimeId = "pi";
    const configured: {
      runtimeId: string;
      modelSelection?: RuntimeModelSelection | undefined;
    } = { runtimeId: "pi" };
    const validate = async (
      resolved: Awaited<ReturnType<RuntimeResolver["bind"]>>,
      selection: RuntimeModelSelection | undefined,
    ) => {
      if (selection === undefined) return resolved;
      const models = await resolved.adapter.listModels?.();
      if (
        !models?.some(
          (model) =>
            model.id === selection.model.modelId &&
            model.provider.id === selection.model.providerId,
        )
      ) {
        throw new Error(
          `Runtime model is unavailable: ${resolved.binding.runtimeId}/${selection.model.providerId}/${selection.model.modelId}.`,
        );
      }
      return resolved;
    };
    const runtimes: RuntimeResolver = {
      getDefaultRuntimeId: async () => defaultRuntimeId,
      bind: async (request = {}) =>
        await validate(
          await registered.bind({ ...request, runtimeId: request.runtimeId ?? defaultRuntimeId }),
          request.modelSelection,
        ),
      resolve: async (request) =>
        await validate(await registered.resolve(request), request.modelSelection),
    };
    const runner = createMissionRunner({
      missions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "state"),
      runtimes,
      compileSystemExecutor: async ({ mission: current }) => {
        const compiledExpert = await defineExpert({
          id: "writer",
          name: "Writer",
          description: "Runtime binding test Expert",
          tags: [],
          version: "1.0.0",
          scope: "test",
          workspace: current.workspace.path,
          pragmaHome: join(root, "state"),
          defaultRuntimeId: configured.runtimeId,
          ...(configured.modelSelection === undefined
            ? {}
            : { models: { default: configured.modelSelection } }),
        });
        return {
          ref: current.executor.ref,
          value: compiledExpert,
          fingerprint: "c".repeat(64),
          projectFingerprint: "d".repeat(64),
          environmentFingerprint: {
            environmentId: "desktop",
            projectFingerprint: "d".repeat(64),
            value: "e".repeat(64),
            resources: [],
            plugins: [],
          },
          rootRuntimeId: configured.runtimeId,
          dependencies: [],
        };
      },
    });

    const first = await runner.run(mission.id);
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: settlementTimeoutMs },
    );
    defaultRuntimeId = "codex";
    configured.runtimeId = "codex";
    configured.modelSelection = {
      model: { providerId: "openai", modelId: "codex-model" },
    };
    await runner.sendMessage({
      id: mission.id,
      content: "Continue on the original Runtime",
      requestId: "00000000-0000-4000-8000-000000000020",
    });
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: settlementTimeoutMs },
    );

    expect((await missions.get(mission.id)).execution?.sessionId).toBe(first.execution?.sessionId);
    expect(piTurns).toHaveBeenCalledTimes(2);
    expect(piSelections).toEqual([undefined, undefined]);
    expect(codexTurns).not.toHaveBeenCalled();
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
      executor: missionExecutorSnapshot(flow),
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
      { timeout: settlementTimeoutMs },
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
      { timeout: settlementTimeoutMs },
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
      executor: missionExecutorSnapshot(
        snapshot.resources.find((resource) => resource.kind === "Expert")!,
      ),
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
      { timeout: settlementTimeoutMs },
    );
    await runner.sendMessage({
      id: mission.id,
      content: "Return oversized reply",
      requestId: "00000000-0000-4000-8000-000000000020",
    });
    await vi.waitFor(
      async () =>
        expect((await storedMissions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: settlementTimeoutMs },
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
      instructions: "Write concise answers.",
      runtime: { ref: "runtime-profile:writer_runtime@1.0.0" },
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
      id: "writer_runtime",
      version: "1.0.0",
      name: "Writer Runtime",
      description: "Runtime used by the test writer.",
      tags: [],
    },
    spec: {
      adapter: "pragma.runtime.profile@v1",
      config: { runtimeId, providerId: "test", model: "test-model" },
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
