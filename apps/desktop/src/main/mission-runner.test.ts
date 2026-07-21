import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFileExecutionStore,
  createFileExpertSessionStore,
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

import { missionExecutorSnapshot, type DesktopToolPermissionMode } from "../shared/desktop-api.ts";
import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import type { CapabilityStore } from "./capability-store.ts";
import { createMissionRunner, normalizeGeneratedMissionTitle } from "./mission-runner.ts";
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
  it("normalizes model-generated titles for the Mission header", () => {
    expect(normalizeGeneratedMissionTitle('## "批量更新 Git 子模块。"\n额外说明')).toBe(
      "批量更新 Git 子模块",
    );
    expect(normalizeGeneratedMissionTitle("a".repeat(80))).toBe(`${"a".repeat(47)}…`);
    expect(() => normalizeGeneratedMissionTitle({ title: "invalid" })).toThrow(
      "did not return text",
    );
  });

  it("summarizes a Mission title in a separate background Expert session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-title-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expertFixture()],
    });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Inspect every Git submodule and create the compatibility branch when it is missing",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: missionExecutorSnapshot(
        snapshot.resources.find((resource) => resource.kind === "Expert")!,
      ),
    });
    const titlePrompt = vi.fn();
    const runtime = defineRuntimeDriver<never, { context: RuntimeDriverSessionContext }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: (context) => ({ context }),
      async startTurn(session, turn) {
        expect(session.context.agent.id).toBe("pragma-desktop-mission-title");
        titlePrompt(turn.rawQuery);
        return {
          outputText: '"Create missing submodule branches."',
          runtimeSessionId: "title-session",
        };
      },
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

    await expect(runner.summarizeTitle(mission.id)).resolves.toMatchObject({
      title: "Create missing submodule branches",
    });
    expect(titlePrompt).toHaveBeenCalledWith(expect.stringContaining(mission.goal));
  });

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
        session: {
          context: RuntimeDriverSessionContext;
          id: string;
          toolPermissionMode: DesktopToolPermissionMode;
        },
        turn: { rawQuery: string; modelSelection?: RuntimeModelSelection | undefined },
      ) => ({
        outputText: `${session.context.agent.id}:${turn.rawQuery}`,
        runtimeSessionId: session.id,
      }),
    );
    const openedSessionModes: DesktopToolPermissionMode[] = [];
    const createSession = vi.fn((context: RuntimeDriverSessionContext) => {
      openedSessionModes.push("request-approval");
      return {
        context,
        id: `runtime-${context.systemSessionId}`,
        toolPermissionMode: "request-approval" as const,
      };
    });
    const runtimeForMode = (toolPermissionMode: DesktopToolPermissionMode) =>
      defineRuntimeDriver<
        never,
        {
          context: RuntimeDriverSessionContext;
          id: string;
          toolPermissionMode: DesktopToolPermissionMode;
        }
      >({
        descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
        createSession:
          toolPermissionMode === "request-approval"
            ? createSession
            : (context) => {
                openedSessionModes.push(toolPermissionMode);
                return {
                  context,
                  id: `runtime-${context.systemSessionId}`,
                  toolPermissionMode,
                };
              },
        restoreSession: (context) => {
          openedSessionModes.push(toolPermissionMode);
          return { context, id: context.request.runtimeSession!.id, toolPermissionMode };
        },
        readSession: (session) => ({ runtimeSessionId: session.id }),
        startTurn,
        mapEvent: () => ({ events: [] }),
        closeSession: () => undefined,
      });
    const runtime = runtimeForMode("request-approval");
    const runtimeResolver = createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: "fake",
    });
    const runtimeResolvers = new Map(
      (["request-approval", "auto-approve", "full-access"] as const).map((mode) => [
        mode,
        createStaticRuntimeResolver({ runtimes: [runtimeForMode(mode)], defaultRuntimeId: "fake" }),
      ]),
    );
    const runtimesForToolPermissionMode = vi.fn(
      (mode: DesktopToolPermissionMode) => runtimeResolvers.get(mode)!,
    );
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
    expect(startTurn.mock.calls.map(([session]) => session.toolPermissionMode)).toEqual([
      "request-approval",
      "auto-approve",
    ]);
    expect(openedSessionModes).toEqual(["request-approval", "auto-approve"]);
    await expect(runner.getWork(mission.id)).resolves.toEqual(
      expect.objectContaining({
        missionId: mission.id,
        records: [
          expect.objectContaining({
            kind: "root",
            status: "succeeded",
            executorId: "writer",
            title: "Writer",
          }),
        ],
      }),
    );

    const latestMission = await missions.get(mission.id);
    const executionId = latestMission.execution!.id;
    const store = createFileExecutionStore({ pragmaHome: join(root, "state") });
    const emittedAt = new Date().toISOString();
    const childSource = {
      kind: "agent" as const,
      runId: "child-turn",
      parentRunId: "root-run",
      sessionId: "child-thread",
      parentSessionId: "root-thread",
      agentId: "child-thread",
      agentType: "codex-subagent",
      displayName: "Researcher",
      path: [],
    };
    await store.appendEvent(executionId, executionId, "runtime.event", {
      schemaVersion: "pragma.stream/v1",
      eventId: "spawn-child",
      sequence: 100,
      runId: "root-run",
      emittedAt,
      source: {
        kind: "agent",
        runId: "root-run",
        sessionId: "root-thread",
        path: [],
      },
      type: "agent.command",
      payload: {
        commandId: "spawn-child",
        action: "spawn",
        phase: "completed",
        senderSessionId: "root-thread",
        targetSessionIds: ["child-a", "child-b", "child-thread"],
      },
    });
    await store.appendEvent(executionId, executionId, "runtime.event", {
      schemaVersion: "pragma.stream/v1",
      eventId: "child-started",
      sequence: 101,
      runId: "child-turn",
      parentRunId: "root-run",
      emittedAt,
      source: childSource,
      type: "run.started",
      payload: { task: "Inspect repository" },
    });
    await store.appendEvent(executionId, executionId, "invocation.message.appended", {
      runId: "child-turn",
      parentRunId: "root-run",
      source: childSource,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Subagent findings" }],
        api: "codex",
        provider: "openai",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    });

    const work = await runner.getWork(mission.id);
    const subagent = work.records.find((record) => record.sessionId === "child-thread");
    expect(subagent).toMatchObject({
      kind: "runtime-agent",
      title: "Researcher",
      tasks: [expect.objectContaining({ runId: "child-turn" })],
    });
    expect(work.records.find((record) => record.sessionId === "child-a")).toMatchObject({
      kind: "runtime-agent",
      title: "Subagent 1",
      fallbackOrdinal: 1,
    });
    expect(work.records.find((record) => record.sessionId === "child-b")).toMatchObject({
      kind: "runtime-agent",
      title: "Subagent 2",
      fallbackOrdinal: 2,
    });
    expect(subagent).not.toHaveProperty("fallbackOrdinal");

    await store.appendEvent(executionId, executionId, "runtime.event", {
      schemaVersion: "pragma.stream/v1",
      eventId: "child-a-started",
      sequence: 102,
      runId: "child-a-turn",
      parentRunId: "root-run",
      emittedAt,
      source: {
        ...childSource,
        runId: "child-a-turn",
        sessionId: "child-a",
        agentId: "child-a",
        displayName: "Architect",
      },
      type: "run.started",
      payload: { task: "Design the system" },
    });
    const enrichedWork = await runner.getWork(mission.id);
    expect(enrichedWork.records.find((record) => record.sessionId === "child-a")).toMatchObject({
      title: "Architect",
    });
    expect(
      enrichedWork.records.find((record) => record.sessionId === "child-a"),
    ).not.toHaveProperty("fallbackOrdinal");
    expect(enrichedWork.records.find((record) => record.sessionId === "child-b")).toMatchObject({
      title: "Subagent 2",
      fallbackOrdinal: 2,
    });
    await expect(
      runner.getWorkOutput({ id: mission.id, recordId: subagent!.recordId, limit: 100 }),
    ).resolves.toMatchObject({
      entries: [expect.objectContaining({ kind: "assistant", content: "Subagent findings" })],
    });
    await expect(runner.getChat({ id: mission.id, limit: 50 })).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ kind: "agent_activity", action: "spawn" }),
      ]),
    });
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

  it("resumes the original Expert turn when a Mission restarts with pending human input", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-expert-human-recovery-"));
    temporaryPaths.push(root);
    const pragmaHome = join(root, "state");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expertFixture()],
    });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Continue after choosing an environment",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: missionExecutorSnapshot(
        snapshot.resources.find((resource) => resource.kind === "Expert")!,
      ),
    });
    const request = {
      kind: "user_question" as const,
      toolName: "askUserQuestion" as const,
      toolCallId: "question-after-restart",
      questions: [
        {
          question: "Which environment?",
          header: "Environment",
          kind: "single_choice" as const,
          options: [
            { label: "staging", description: "Use staging." },
            { label: "production", description: "Use production." },
          ],
        },
      ],
    };
    let runtimeStarts = 0;
    const runtime = defineRuntimeDriver<never, { context: RuntimeDriverSessionContext }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: (context) => ({ context }),
      readSession: () => ({ runtimeSessionId: "recovered-runtime-session" }),
      async startTurn(session) {
        runtimeStarts += 1;
        const handler = session.context.request.humanInteractionHandler;
        if (handler === undefined) throw new Error("Human interaction handler is missing.");
        const response = await handler(request);
        return {
          outputText: JSON.stringify(response),
          runtimeSessionId: "recovered-runtime-session",
        };
      },
      mapEvent: () => ({ events: [] }),
      closeSession: () => undefined,
    });
    const runtimes = createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: "fake",
    });
    const expert = await defineExpert({
      id: "writer",
      name: "Writer",
      description: "Recovery test Expert",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: root,
      pragmaHome,
      defaultRuntimeId: "fake",
    });
    const executions = createFileExecutionStore({ pragmaHome });
    const expertSessions = createFileExpertSessionStore({ executions, pragmaHome });
    const runtimeBinding = (await runtimes.bind({ runtimeId: "fake" })).binding;
    const sessionId = "10000000-0000-4000-8000-000000000001";
    const executionId = "20000000-0000-4000-8000-000000000001";
    const contextId = "30000000-0000-4000-8000-000000000001";
    const interactionId = "pending-question";
    const startedAt = new Date().toISOString();
    const definition = { id: expert.id, version: expert.version, kind: "expert" as const };
    await expertSessions.create({
      schemaVersion: "pragma.expert-session/v4",
      sessionId,
      expertId: expert.id,
      expertVersion: expert.version,
      definitionFingerprint: "a".repeat(64),
      status: "open",
      activeExecutionId: executionId,
      queuedRequestIds: [],
      executionIds: [executionId],
      rootContextId: contextId,
      contexts: {
        [contextId]: {
          schemaVersion: "pragma.runtime-context/v4",
          contextId,
          owner: { type: "expert-session", ownerId: sessionId },
          origin: { type: "expert-session", sessionId },
          expert: { id: expert.id, version: expert.version },
          runtime: runtimeBinding,
          lifecycle: "open",
          createdAt: startedAt,
          updatedAt: startedAt,
        },
      },
      createdAt: startedAt,
      updatedAt: startedAt,
    });
    await executions.create(
      {
        schemaVersion: "pragma.execution/v5",
        executionId,
        version: 0,
        kind: "expert-turn",
        definition,
        rootInvocationId: executionId,
        status: "running",
        input: mission.goal,
        state: {},
        lastAppliedSequence: 0,
        createdAt: startedAt,
        updatedAt: startedAt,
      },
      {
        invocationId: executionId,
        rootInvocationId: executionId,
        definition,
        executorId: expert.id,
        contextId,
        status: "running",
        input: mission.goal,
        createdAt: startedAt,
        updatedAt: startedAt,
      },
    );
    await expertSessions.transact(sessionId, ({ session }) => ({
      result: undefined,
      session,
      prompts: [
        {
          requestId: mission.initialMessageId,
          sessionId,
          content: mission.goal,
          mode: "enqueue" as const,
          executionId,
          status: "running" as const,
          createdAt: startedAt,
          updatedAt: startedAt,
        },
      ],
    }));
    await executions.appendEvent(
      executionId,
      executionId,
      "human.requested",
      { interactionId, request },
      `human-request:${interactionId}`,
    );
    await missions.appendExecutionReference({
      missionId: mission.id,
      inputMessageId: mission.initialMessageId,
      executionId,
      createdAt: startedAt,
    });
    await missions.updateExecution(mission.id, {
      id: executionId,
      inputMessageId: mission.initialMessageId,
      sessionId,
      status: "waiting",
      startedAt,
    });
    const runner = createMissionRunner({
      missions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome,
      runtimes,
      compileSystemExecutor: async () => ({
        ref: mission.executor.ref,
        value: expert,
        fingerprint: "b".repeat(64),
        projectFingerprint: "c".repeat(64),
        environmentFingerprint: {
          environmentId: "desktop",
          projectFingerprint: "c".repeat(64),
          value: "d".repeat(64),
          resources: [],
          plugins: [],
        },
        rootRuntimeId: "fake",
        dependencies: [],
      }),
    });

    const resumed = await runner.run(mission.id);
    expect(resumed.execution).toMatchObject({ id: executionId, status: "waiting", sessionId });
    expect(runtimeStarts).toBe(0);
    const interactions = await runner.listHumanInteractions(mission.id);
    expect(interactions).toEqual([
      expect.objectContaining({
        interactionId,
        request: expect.objectContaining({ kind: "question" }),
      }),
    ]);

    await runner.respondToHumanInteraction({
      missionId: mission.id,
      interactionId,
      requestId: "40000000-0000-4000-8000-000000000001",
      response: { answers: { "Which environment?": "staging" } },
    });
    await vi.waitFor(
      async () =>
        expect((await missions.get(mission.id)).execution).toMatchObject({
          id: executionId,
          status: "succeeded",
        }),
      { timeout: settlementTimeoutMs },
    );
    expect(runtimeStarts).toBe(1);
    expect(await expertSessions.listPrompts(sessionId)).toHaveLength(1);
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
    await expect(runner.getWork(mission.id)).resolves.toEqual(
      expect.objectContaining({
        records: expect.arrayContaining([
          expect.objectContaining({ kind: "flow" }),
          expect.objectContaining({ kind: "human-task", status: "waiting" }),
        ]),
      }),
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
