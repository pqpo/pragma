import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFileExecutionStore,
  createFileExpertSessionStore,
  createStaticRuntimeResolver,
  createNoopLoggerProvider,
  defineExpert,
  defineRuntimeDriver,
  fingerprintExpertExecutionDefinition,
  InMemoryContextStore,
  PragmaPaths,
  readRuntimeSessionRecord,
  RuntimeContextCompactionNotNeededError,
  StoredExecutionView,
  type ExpertSession,
  type RuntimeDriverSessionContext,
  type RuntimeContextWindowUsage,
  type RuntimeModelSelection,
  type RuntimeResolver,
} from "@pragma/core";
import type {
  PragmaExpertResource,
  PragmaExpertTeamResource,
  PragmaFlowResource,
  PragmaRuntimeProfileResource,
} from "@pragma/interpreter/ast";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MissionChatSnapshotSchema,
  MissionChatUpdateSchema,
  missionExecutorSnapshot,
  type DesktopToolPermissionMode,
  type MissionChatUpdate,
} from "../../../shared/contracts/index.ts";
import type { CapabilityCredentialStore } from "../capabilities/capability-credential-store.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import { compactExpertSessionContext, createMissionRunner } from "./mission-runner.ts";
import { createMissionStore } from "./mission-store.ts";
import { createPragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { DesktopUsageStore } from "../usage/usage-store.ts";

const temporaryPaths: string[] = [];
const settlementTimeoutMs = 10_000;

const isNodeErrorCode = (error: unknown, code: string): error is NodeJS.ErrnoException =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code: unknown }).code === code;

const purgeDirectory = async (path: string): Promise<void> => {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.map((entry) => rm(join(path, entry.name), { recursive: true, force: true })),
  );
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
};

const removeTemporaryPath = async (path: string): Promise<void> => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
      return;
    } catch (error) {
      if (
        !isNodeErrorCode(error, "ENOTEMPTY") &&
        !isNodeErrorCode(error, "EBUSY") &&
        !isNodeErrorCode(error, "EPERM")
      ) {
        throw error;
      }
      await purgeDirectory(path);
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 40));
    }
  }
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map(async (path) => await removeTemporaryPath(path)));
});

describe("MissionRunner", { timeout: 15_000 }, () => {
  it("treats a restored Runtime with no compactable history as a normal no-op", async () => {
    const session = {
      canCompactRootContext: vi.fn(async () => undefined),
      compactRootContext: vi.fn(async () => {
        throw new RuntimeContextCompactionNotNeededError();
      }),
    } satisfies Pick<ExpertSession, "canCompactRootContext" | "compactRootContext">;

    await expect(compactExpertSessionContext(session)).resolves.toEqual({
      outcome: "not_needed",
    });
    expect(session.compactRootContext).toHaveBeenCalledOnce();
  });

  it("projects initial Mission attachments onto the durable user chat entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-chat-attachments-"));
    temporaryPaths.push(root);
    const sourceImage = join(root, "screen.png");
    await writeFile(sourceImage, "image-bytes");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expertFixture()],
    });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Summarize the image",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: missionExecutorSnapshot(
        snapshot.resources.find((resource) => resource.kind === "Expert")!,
      ),
      attachments: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          kind: "image",
          name: "screen.png",
          path: sourceImage,
          mimeType: "image/png",
        },
      ],
    });
    const runtime = defineRuntimeDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: () => ({ id: "runtime" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: () => ({ outputText: "done", runtimeSessionId: "runtime" }),
      mapEvent: () => ({ events: [] }),
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

    const chat = await runner.getChat({ id: mission.id, limit: 50 });
    expect(chat.entries).toEqual([
      expect.objectContaining({
        id: mission.initialMessageId,
        kind: "user",
        content: "Summarize the image",
        attachments: [
          expect.objectContaining({
            id: "00000000-0000-4000-8000-000000000002",
            kind: "image",
            name: "screen.png",
            mimeType: "image/png",
          }),
        ],
      }),
    ]);
  });

  it("skips compilation for a follow-up on the live Mission Session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-followup-fast-path-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expertFixture()],
    });
    const compile = vi.spyOn(project, "compile");
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Start the Mission",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: missionExecutorSnapshot(
        snapshot.resources.find((resource) => resource.kind === "Expert")!,
      ),
    });
    const runtime = defineRuntimeDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: () => ({ id: "runtime" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: () => ({ outputText: "done", runtimeSessionId: "runtime" }),
      mapEvent: () => ({ events: [] }),
    });
    const onExecutionLinked = vi.fn(async () => undefined);
    const onMissionActivity = vi.fn(async () => undefined);
    const onExecutionTerminal = vi.fn(async () => undefined);
    const runner = createMissionRunner({
      missions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "state"),
      runtimes: createStaticRuntimeResolver({
        runtimes: [runtime],
        defaultRuntimeId: "fake",
      }),
      assertStorageWriteAllowed: async () => undefined,
      hostContextStores: [{ namespace: "memory", store: new InMemoryContextStore() }],
      onExecutionLinked,
      onMissionActivity,
      onExecutionTerminal,
    });

    await runner.run(mission.id);
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: settlementTimeoutMs },
    );
    compile.mockImplementation(async () => {
      throw new Error("A follow-up on a live Mission Session must not recompile.");
    });
    await runner.sendMessage({
      id: mission.id,
      content: "Continue without recompiling",
      requestId: "00000000-0000-4000-8000-000000000099",
    });
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: settlementTimeoutMs },
    );

    expect(compile).toHaveBeenCalledTimes(1);
    expect(onExecutionLinked).toHaveBeenCalledTimes(2);
    expect(onExecutionLinked).toHaveBeenCalledWith({
      mission: expect.objectContaining({ id: mission.id }),
      executionId: expect.any(String),
    });
    expect(onMissionActivity).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(onExecutionTerminal).toHaveBeenCalledTimes(2));
  });

  it("creates a successor Session when the live execution definition changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-definition-successor-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expertFixture()],
    });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Start with the first definition",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: missionExecutorSnapshot(
        snapshot.resources.find((resource) => resource.kind === "Expert")!,
      ),
    });
    const historicalBoardOutput: { id: string | undefined } = { id: undefined };
    const runtime = defineRuntimeDriver<
      never,
      { id: string; context: RuntimeDriverSessionContext }
    >({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: (context) => ({ id: `runtime-${context.systemSessionId}`, context }),
      restoreSession: (context) => ({ id: context.request.runtimeSession!.id, context }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      async startTurn(session, turn) {
        if (turn.rawQuery === mission.goal) {
          return {
            outputText: "historical mission board output\n".repeat(4_000),
            runtimeSessionId: session.id,
          };
        }
        const historicalOutputId = historicalBoardOutput.id;
        if (historicalOutputId === undefined)
          throw new Error("Historical board output id is missing.");
        const read = session.context.agent
          .createDefaultTools()
          .find((tool) => tool.name === "read_expert_context");
        if (read === undefined) throw new Error("read_expert_context is missing.");
        const results = await Promise.all(
          [0, 1].map(
            async () =>
              await read.call({ namespace: "mission-board", id: historicalOutputId }, turn.signal, {
                execution: session.context.request.executionContext,
              }),
          ),
        );
        const failed = results.find(
          (result) =>
            result.isError === true || !result.text.includes("historical mission board output"),
        );
        return {
          outputText:
            failed === undefined ? "successor-read-ok" : `successor-read-failed:${failed.text}`,
          runtimeSessionId: session.id,
        };
      },
      mapEvent: () => ({ events: [] }),
      closeSession: () => undefined,
    });
    let definitionVersion = 1;
    const compileSystemExecutor = vi.fn(async () => {
      const expert = await defineExpert({
        id: "1xddvess309a6gme",
        name: "Writer",
        description: "Writes concise answers",
        tags: [],
        scope: "Writing",
        instructions: `Definition ${definitionVersion}`,
        workspace: root,
        pragmaHome: join(root, "state"),
        defaultRuntimeId: "fake",
      });
      return {
        ref: mission.executor.ref,
        value: expert,
        fingerprint: String(definitionVersion).repeat(64),
        projectFingerprint: "a".repeat(64),
        environmentFingerprint: {
          environmentId: "desktop",
          projectFingerprint: "a".repeat(64),
          value: "b".repeat(64),
          resources: [],
          plugins: [],
        },
        rootRuntimeId: "fake",
        dependencies: [],
      };
    });
    const createRunner = (missionStore = missions) =>
      createMissionRunner({
        missions: missionStore,
        project,
        capabilityStore: {} as CapabilityStore,
        capabilityCredentials: {} as CapabilityCredentialStore,
        capabilitiesPath: join(root, "capabilities"),
        pragmaHome: join(root, "state"),
        executionStore: createFileExecutionStore({ pragmaHome: join(root, "state") }),
        runtimes: createStaticRuntimeResolver({
          runtimes: [runtime],
          defaultRuntimeId: "fake",
        }),
        compileSystemExecutor,
        getSystemExecutorFingerprint: () => `definition-${definitionVersion}`,
        assertStorageWriteAllowed: async () => undefined,
      });
    let activeMissions = missions;
    let runner = createRunner();

    await runner.run(mission.id);
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: settlementTimeoutMs },
    );
    const originalSessionId = (await missions.get(mission.id)).execution?.sessionId;
    expect(originalSessionId).toMatch(/^[0-9a-f-]{36}$/);
    if (originalSessionId === undefined) throw new Error("Original Session id is missing.");
    const originalExecutionId = (await missions.get(mission.id)).execution!.id;
    const originalExecution = await createFileExecutionStore({
      pragmaHome: join(root, "state"),
    }).get(originalExecutionId);
    if (originalExecution?.output?.type !== "context") {
      throw new Error("Expected the original Mission turn to produce a Context output.");
    }
    const originalBoardOutput = originalExecution.output.contexts[0];
    if (originalBoardOutput === undefined) {
      throw new Error("Expected the original Mission turn to produce a Context reference.");
    }
    expect(originalBoardOutput.namespace).toBe("mission-board");
    historicalBoardOutput.id = originalBoardOutput.id;
    definitionVersion = 2;
    activeMissions = createMissionStore({ missionsPath: join(root, "missions") });
    runner = createRunner(activeMissions);

    await runner.sendMessage({
      id: mission.id,
      content: "Continue with the changed definition",
      requestId: "00000000-0000-4000-8000-000000000098",
    });
    await vi.waitFor(
      async () =>
        expect((await activeMissions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: settlementTimeoutMs },
    );

    expect((await activeMissions.get(mission.id)).execution?.sessionId).not.toBe(originalSessionId);
    expect(compileSystemExecutor).toHaveBeenCalledTimes(2);
    await expect(runner.getChat({ id: mission.id, limit: 50 })).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", content: "successor-read-ok" }),
      ]),
    });
    await runner.delete(mission.id);
    await expect(
      readFile(join(root, "missions", mission.id, "board", "shared", originalBoardOutput.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("limits deletion reconciliation to the target Mission and does not let analytics block deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-usage-delete-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expertFixture()],
    });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const executor = missionExecutorSnapshot(
      snapshot.resources.find((resource) => resource.kind === "Expert")!,
    );
    const target = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Delete this Mission",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor,
    });
    await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Keep this Mission",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor,
    });
    const markSubjectDeleted = vi.fn();
    const usage = {
      trackingStartedAt: "2026-01-01T00:00:00.000Z",
      markSubjectDeleted,
    } as unknown as DesktopUsageStore;
    const openRevision = vi
      .spyOn(project, "openRevision")
      .mockRejectedValueOnce(new Error("usage attribution unavailable"));
    const onStorageTrashed = vi.fn();
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
      runtimes: createStaticRuntimeResolver({
        runtimes: [runtime],
        defaultRuntimeId: "fake",
      }),
      usage,
      loggerProvider: createNoopLoggerProvider(),
      onStorageTrashed,
    });

    await expect(runner.delete(target.id)).resolves.toBeUndefined();
    await expect(missions.get(target.id)).rejects.toThrow();
    expect(openRevision).toHaveBeenCalledTimes(1);
    expect(markSubjectDeleted).toHaveBeenCalledWith("mission", target.id);
    expect(onStorageTrashed).toHaveBeenCalledOnce();
    expect(await missions.list()).toHaveLength(1);
  });

  it("projects and compacts the persisted root context window", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-context-window-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expertFixture()],
    });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Track the root context",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: missionExecutorSnapshot(
        snapshot.resources.find((resource) => resource.kind === "Expert")!,
      ),
    });
    let compactable = true;
    let contextUsageTokens = 50_000;
    const compactContext = vi.fn(() => {
      compactable = false;
      contextUsageTokens = 10_000;
      return {
        usedTokens: contextUsageTokens,
        contextWindowTokens: 200_000,
        percent: 5,
        measurement: "reported" as const,
        observedAt: new Date().toISOString(),
      };
    });
    let finishTurn = (): void => undefined;
    const turnCanFinish = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    const runtime = defineRuntimeDriver<RuntimeContextWindowUsage, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: () => ({ id: "runtime" }),
      restoreSession: () => ({ id: "runtime" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      async startTurn(_session, turn) {
        turn.stream.writeNative({
          usedTokens: 40_000,
          contextWindowTokens: 200_000,
          percent: 20,
          measurement: "reported",
          observedAt: new Date().toISOString(),
        });
        await turnCanFinish;
        return { outputText: "done", runtimeSessionId: "runtime" };
      },
      mapEvent: (usage) => ({ events: [], contextWindowUsage: usage }),
      readContextWindow: () => ({
        usedTokens: contextUsageTokens,
        contextWindowTokens: 200_000,
        percent: (contextUsageTokens / 200_000) * 100,
        measurement: "reported",
        observedAt: new Date().toISOString(),
      }),
      canCompactContext: () => compactable,
      compactContext,
    });
    const runtimes = createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" });
    const createRunner = () =>
      createMissionRunner({
        missions,
        project,
        capabilityStore: {} as CapabilityStore,
        capabilityCredentials: {} as CapabilityCredentialStore,
        capabilitiesPath: join(root, "capabilities"),
        pragmaHome: join(root, "state"),
        runtimes,
      });
    const runner = createRunner();
    const chatUpdates: MissionChatUpdate[] = [];
    const unsubscribe = runner.subscribeChat((update) => chatUpdates.push(update));

    await runner.run(mission.id);
    await vi.waitFor(() => {
      expect(
        chatUpdates.some(
          (update) =>
            update.kind === "patch" &&
            update.patches.some(
              (patch) =>
                patch.type === "context-window.update" && patch.usage.usedTokens === 40_000,
            ),
        ),
      ).toBe(true);
    });
    expect((await missions.get(mission.id)).execution?.status).toBe("running");
    finishTurn();
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: settlementTimeoutMs },
    );
    unsubscribe();
    await expect(runner.getChat({ id: mission.id, limit: 50 })).resolves.toMatchObject({
      contextWindow: {
        supportsInspection: true,
        supportsCompaction: true,
        canCompact: true,
        usage: { usedTokens: 50_000, contextWindowTokens: 200_000, percent: 25 },
      },
    });
    await expect(runner.compactContext(mission.id)).resolves.toMatchObject({
      outcome: "compacted",
      contextWindow: {
        canCompact: false,
        compactionBlockedReason: "not_ready",
        usage: { usedTokens: 10_000, percent: 5 },
      },
    });
    expect(compactContext).toHaveBeenCalledOnce();
    await expect(runner.compactContext(mission.id)).resolves.toMatchObject({
      outcome: "not_needed",
      contextWindow: {
        canCompact: false,
        compactionBlockedReason: "not_ready",
      },
    });
    expect(compactContext).toHaveBeenCalledOnce();

    const storedMission = await missions.get(mission.id);
    const storedSession = await createFileExpertSessionStore({
      executions: createFileExecutionStore({ pragmaHome: join(root, "state") }),
      pragmaHome: join(root, "state"),
    }).get(storedMission.execution!.sessionId!);
    const storedRootContext = storedSession?.contexts[storedSession.rootContextId];
    const storedRuntimeSession = await readRuntimeSessionRecord(
      new PragmaPaths({ pragmaHome: join(root, "state") }),
      storedMission.execution!.sessionId!,
      storedRootContext!.snapshot!.systemSessionId,
    );
    expect(storedRuntimeSession.contextWindowUsage).toMatchObject({
      usedTokens: 10_000,
      percent: 5,
    });

    await expect(createRunner().getChat({ id: mission.id, limit: 50 })).resolves.toMatchObject({
      contextWindow: {
        canCompact: true,
        usage: { usedTokens: 10_000, contextWindowTokens: 200_000, percent: 5 },
      },
    });

    const unavailableRuntimes: RuntimeResolver = {
      getDefaultRuntimeId: async () => "fake",
      bind: async () => {
        throw new Error("Runtime is unavailable.");
      },
      resolve: async () => {
        throw new Error("Runtime is unavailable.");
      },
    };
    const unavailableRunner = createMissionRunner({
      missions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "state"),
      runtimes: unavailableRuntimes,
    });
    const chatWithoutRuntime = await unavailableRunner.getChat({ id: mission.id, limit: 50 });
    expect(chatWithoutRuntime.entries).not.toHaveLength(0);
    expect(chatWithoutRuntime.contextWindow).toBeUndefined();
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
        turn.stream.write({
          runId: turn.runId,
          source: turn.source,
          type: "progress",
          payload: {
            stage: "context.compaction.started",
            data: {
              operationId: "compact-live",
              trigger: "auto",
              runtimeId: "fake",
            },
          },
        });
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
            expect.objectContaining({
              kind: "thinking",
              executorName: "Writer",
              content: "Checking constraints.",
            }),
            expect.objectContaining({
              kind: "tool",
              executorName: "Writer",
              toolName: "read_file",
              status: "running",
            }),
            expect.objectContaining({
              kind: "context_operation",
              operationId: "compact-live",
              status: "running",
            }),
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
        expect.objectContaining({
          kind: "context_operation",
          operationId: "compact-live",
          status: "failed",
        }),
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
          entry: expect.objectContaining({ kind: "thinking", executorName: "Writer" }),
        }),
        expect.objectContaining({
          type: "entry.upsert",
          entry: expect.objectContaining({ kind: "tool", executorName: "Writer" }),
        }),
        expect.objectContaining({
          type: "entry.upsert",
          entry: expect.objectContaining({
            kind: "context_operation",
            operationId: "compact-live",
          }),
        }),
      ]),
    );
    unsubscribe();
  });

  it("keeps live chat valid after a tool reports an oversized error", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-long-tool-error-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expertFixture()],
    });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Continue after a large validation failure",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: missionExecutorSnapshot(
        snapshot.resources.find((resource) => resource.kind === "Expert")!,
      ),
    });
    let outputWritten = (): void => undefined;
    const outputWasWritten = new Promise<void>((resolve) => {
      outputWritten = resolve;
    });
    let finishTurn = (): void => undefined;
    const turnCanFinish = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    const oversizedError = "validation failed: ".padEnd(12_000, "x");
    const runtime = defineRuntimeDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: () => ({ id: "runtime" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      async startTurn(_session, turn) {
        turn.stream.write({
          runId: turn.runId,
          source: turn.source,
          type: "tool.started",
          payload: {
            toolCallId: "prepare-flow",
            toolName: "prepare_dsl_changes",
            kind: "tool",
          },
        });
        turn.stream.write({
          runId: turn.runId,
          source: turn.source,
          type: "tool.failed",
          payload: {
            toolCallId: "prepare-flow",
            toolName: "prepare_dsl_changes",
            kind: "tool",
            message: oversizedError,
          },
        });
        turn.stream.write({
          runId: turn.runId,
          source: turn.source,
          type: "message.delta",
          payload: {
            role: "assistant",
            contentType: "text",
            delta: "Continuing after validation failed.",
          },
        });
        outputWritten();
        await turnCanFinish;
        return { outputText: "Completed after validation failed.", runtimeSessionId: "runtime" };
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
    const updates: unknown[] = [];
    const unsubscribe = runner.subscribeChat((update) => updates.push(update));

    await runner.run(mission.id);
    await outputWasWritten;
    await vi.waitFor(async () => {
      const chat = await runner.getChat({ id: mission.id, limit: 50 });
      expect(() => MissionChatSnapshotSchema.parse(chat)).not.toThrow();
      expect(chat.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "tool",
            toolName: "prepare_dsl_changes",
            status: "failed",
            error: expect.stringMatching(/…$/u),
          }),
          expect.objectContaining({
            kind: "assistant",
            content: "Continuing after validation failed.",
          }),
        ]),
      );
      const tool = chat.entries.find((entry) => entry.kind === "tool");
      expect(tool?.kind === "tool" ? tool.error : undefined).toHaveLength(10_000);
      expect(updates.length).toBeGreaterThanOrEqual(3);
      expect(updates.every((update) => MissionChatUpdateSchema.safeParse(update).success)).toBe(
        true,
      );
    });

    finishTurn();
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: settlementTimeoutMs },
    );
    unsubscribe();
  });

  it("streams nested agent turns into their work conversation without leaking into root chat", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-child-stream-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expertFixture()],
    });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Observe delegated work",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: missionExecutorSnapshot(
        snapshot.resources.find((resource) => resource.kind === "Expert")!,
      ),
    });
    let announceChildDelta = (): void => undefined;
    const childDeltaWritten = new Promise<void>((resolve) => {
      announceChildDelta = resolve;
    });
    let finishTurn = (): void => undefined;
    const turnCanFinish = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    const runtime = defineRuntimeDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: () => ({ id: "runtime" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      async startTurn(_session, turn) {
        const childSource = {
          kind: "agent" as const,
          runId: "child-run",
          parentRunId: turn.runId,
          sessionId: "child-session",
          parentSessionId: "root-session",
          agentId: "child-session",
          displayName: "Researcher",
          path: [],
        };
        turn.stream.write({
          runId: "child-run",
          parentRunId: turn.runId,
          source: childSource,
          type: "run.started",
          payload: { task: "Inspect the live state" },
        });
        turn.stream.write({
          runId: "child-run",
          parentRunId: turn.runId,
          source: childSource,
          type: "message.delta",
          payload: { role: "assistant", contentType: "text", delta: "Live child answer" },
        });
        announceChildDelta();
        await turnCanFinish;
        turn.stream.write({
          runId: "child-run",
          parentRunId: turn.runId,
          source: childSource,
          type: "message.completed",
          payload: { role: "assistant", contentType: "text", text: "Live child answer" },
        });
        return { outputText: "Root answer", runtimeSessionId: "runtime" };
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

    await runner.run(mission.id);
    await childDeltaWritten;
    await vi.waitFor(async () => {
      const work = await runner.getWork(mission.id);
      const child = work.records.find((record) => record.sessionId === "child-session");
      expect(child).toBeDefined();
      await expect(
        runner.getWorkConversation({
          id: mission.id,
          recordId: child!.recordId,
          limit: 100,
        }),
      ).resolves.toMatchObject({
        entries: [
          expect.objectContaining({ kind: "user", content: "Inspect the live state" }),
          expect.objectContaining({
            kind: "assistant",
            content: "Live child answer",
            streaming: true,
          }),
        ],
      });
    });
    expect((await runner.getChat({ id: mission.id, limit: 50 })).entries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", content: "Live child answer" }),
      ]),
    );

    finishTurn();
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: settlementTimeoutMs },
    );
  });

  it("identifies Team, delegated Expert, and Flow output in live and historical chat", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-executor-labels-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const writer = expertFixtureWithReviewerTool();
    const reviewer = reviewerFixture();
    const team = expertTeamFixture();
    const flow = expertFlowFixture();
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), writer, reviewer, team, flow],
    });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const missionFor = async (
      resource: PragmaExpertResource | PragmaExpertTeamResource | PragmaFlowResource,
      goal: string,
    ) =>
      await missions.create({
        workspace: { path: root, basename: "workspace" },
        goal,
        ...(resource.kind === "Flow" ? { flowInput: {} } : {}),
        project: { id: snapshot.projectId, revision: snapshot.revision },
        executor: missionExecutorSnapshot(resource),
      });
    const expertMission = await missionFor(writer, "Delegate review");
    const teamMission = await missionFor(team, "Coordinate review");
    const flowMission = await missionFor(flow, "Run review flow");
    const runtime = defineRuntimeDriver<
      never,
      { context: RuntimeDriverSessionContext; id: string }
    >({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: (context) => ({ context, id: `runtime:${context.systemSessionId}` }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      async startTurn(session, turn) {
        const tools = session.context.agent.tools ?? [];
        const spawn = tools.find((tool) => tool.name === "spawn_expert");
        const wait = tools.find((tool) => tool.name === "wait_experts");
        const callReviewer = tools.find((tool) => tool.name === "call_reviewer");
        let output = `${session.context.agent.id}:${turn.rawQuery}`;
        if (
          spawn !== undefined &&
          wait !== undefined &&
          session.context.agent.id === writer.metadata.id
        ) {
          const spawned = await spawn.call(
            { expertId: reviewer.metadata.id, prompt: "Team review" },
            turn.signal,
            { execution: session.context.request.executionContext },
          );
          const invocationId = (spawned.details as { invocationId: string }).invocationId;
          const waited = await wait.call({ invocationIds: [invocationId] }, turn.signal, {
            execution: session.context.request.executionContext,
          });
          const completed = (waited.details as { completed: Array<{ output?: unknown }> })
            .completed;
          output = `writer:${String(completed[0]?.output)}`;
        } else if (callReviewer !== undefined && turn.rawQuery === "Delegate review") {
          const delegated = await callReviewer.call({ prompt: "Standalone review" }, turn.signal, {
            execution: session.context.request.executionContext,
          });
          output = `writer:${String(delegated.details)}`;
        }
        turn.stream.write({
          runId: turn.runId,
          source: turn.source,
          type: "message.delta",
          payload: { role: "assistant", contentType: "text", delta: output },
        });
        return { outputText: output, runtimeSessionId: session.id };
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
    const updates: MissionChatUpdate[] = [];
    const unsubscribe = runner.subscribeChat((update) => updates.push(update));

    for (const mission of [expertMission, teamMission, flowMission]) {
      await runner.run(mission.id);
      await vi.waitFor(
        async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
        { timeout: settlementTimeoutMs },
      );
    }

    const expertChat = await runner.getChat({ id: expertMission.id, limit: 50 });
    const teamChat = await runner.getChat({ id: teamMission.id, limit: 50 });
    const flowChat = await runner.getChat({ id: flowMission.id, limit: 50 });
    const expertOutputs = expertChat.entries.filter((entry) => entry.kind === "assistant");
    const teamOutputs = teamChat.entries.filter((entry) => entry.kind === "assistant");
    const flowOutputs = flowChat.entries.filter((entry) => entry.kind === "assistant");

    expect(expertOutputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ executorId: writer.metadata.id, executorName: "Writer" }),
        expect.objectContaining({ executorId: reviewer.metadata.id, executorName: "Reviewer" }),
      ]),
    );
    expect(teamOutputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ executorId: writer.metadata.id, executorName: "Writer" }),
        expect.objectContaining({ executorId: reviewer.metadata.id, executorName: "Reviewer" }),
      ]),
    );
    expect(flowOutputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ executorId: reviewer.metadata.id, executorName: "Reviewer" }),
      ]),
    );
    expect(
      updates
        .filter((update) => update.kind === "patch")
        .flatMap((update) => update.patches)
        .filter((patch) => patch.type === "entry.upsert")
        .map((patch) => patch.entry)
        .filter((entry) => entry.kind === "assistant"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ executorId: writer.metadata.id, executorName: "Writer" }),
        expect.objectContaining({ executorId: reviewer.metadata.id, executorName: "Reviewer" }),
      ]),
    );
    unsubscribe();
  });

  it("keeps Work available with ID fallbacks when executor names cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-work-name-fallback-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expertFixture()],
    });
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Read work without project metadata",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: missionExecutorSnapshot(
        snapshot.resources.find((resource) => resource.kind === "Expert")!,
      ),
    });
    vi.spyOn(project, "openRevision").mockRejectedValueOnce(
      new Error("Project metadata unavailable"),
    );
    const unavailableRuntimes: RuntimeResolver = {
      getDefaultRuntimeId: async () => "fake",
      bind: async () => {
        throw new Error("Runtime is unavailable.");
      },
      resolve: async () => {
        throw new Error("Runtime is unavailable.");
      },
    };
    const runner = createMissionRunner({
      missions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "state"),
      runtimes: unavailableRuntimes,
      loggerProvider: createNoopLoggerProvider(),
    });

    await expect(runner.getWork(mission.id)).resolves.toMatchObject({
      missionId: mission.id,
      records: [],
    });
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

    const getMission = missions.get.bind(missions);
    let missionReads = 0;
    let enterFinalMissionRead = (): void => undefined;
    const finalMissionReadEntered = new Promise<void>((resolve) => {
      enterFinalMissionRead = resolve;
    });
    let releaseFinalMissionRead = (): void => undefined;
    const finalMissionReadCanFinish = new Promise<void>((resolve) => {
      releaseFinalMissionRead = resolve;
    });
    vi.spyOn(missions, "get").mockImplementation(async (id) => {
      if (id === mission.id && (missionReads += 1) === 2) {
        enterFinalMissionRead();
        await finalMissionReadCanFinish;
      }
      return await getMission(id);
    });

    const racedSnapshot = runner.getChat({ id: mission.id, limit: 50 });
    await finalMissionReadEntered;
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
      releaseFinalMissionRead();
    }

    await expect(racedSnapshot).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", content: "Codex answer" }),
      ]),
      execution: { status: "succeeded", interruptible: false },
    });
  });

  it("compiles and runs the resource pinned by a Mission", async () => {
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
    const runtimesForToolPermissionMode = vi.fn((mode: DesktopToolPermissionMode) =>
      runtimeResolvers.get(mode)!,
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
        expect.objectContaining({
          kind: "assistant",
          content: "1xddvess309a6gme:Prepare a concise answer",
        }),
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
      "1xddvess309a6gme:Prepare a concise answer",
      "Make it shorter",
      "1xddvess309a6gme:Make it shorter",
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
            executorId: "1xddvess309a6gme",
            title: "Writer",
          }),
        ],
      }),
    );

    const latestMission = await missions.get(mission.id);
    const executionId = latestMission.execution!.id;
    const store = createFileExecutionStore({ pragmaHome: join(root, "state") });
    const childConversationStartedAt = Date.now();
    const emittedAt = new Date(childConversationStartedAt).toISOString();
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
        prompt: "Inspect the repository and report complete findings",
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
          measurement: "reported",
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: childConversationStartedAt + 1,
      },
    });
    const followupSource = {
      ...childSource,
      runId: "child-followup-turn",
    };
    await store.appendEvent(executionId, executionId, "runtime.event", {
      schemaVersion: "pragma.stream/v1",
      eventId: "child-followup-started",
      sequence: 102,
      runId: "child-followup-turn",
      parentRunId: "root-run",
      emittedAt: new Date(childConversationStartedAt + 2).toISOString(),
      source: followupSource,
      type: "run.started",
      payload: { task: "Refine the findings" },
    });
    await store.appendEvent(executionId, executionId, "invocation.message.appended", {
      runId: "child-followup-turn",
      parentRunId: "root-run",
      source: followupSource,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Refined findings" }],
        api: "codex",
        provider: "openai",
        model: "test",
        usage: {
          measurement: "reported",
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: childConversationStartedAt + 3,
      },
    });

    const work = await runner.getWork(mission.id);
    const subagent = work.records.find((record) => record.sessionId === "child-thread");
    expect(subagent).toMatchObject({
      kind: "runtime-agent",
      title: "Researcher",
      tasks: [
        expect.objectContaining({ runId: "child-turn" }),
        expect.objectContaining({ runId: "child-followup-turn" }),
      ],
    });
    expect(work.records.filter((record) => record.sessionId === "child-thread")).toHaveLength(1);
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
      sequence: 103,
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
    await store.appendEvent(executionId, executionId, "runtime.event", {
      schemaVersion: "pragma.stream/v1",
      eventId: "child-b-started",
      sequence: 104,
      runId: "child-b-turn",
      parentRunId: "root-run",
      emittedAt: new Date(childConversationStartedAt + 4).toISOString(),
      source: {
        ...childSource,
        runId: "child-b-turn",
        sessionId: "child-b",
        agentId: "child-b",
        displayName: "Architect",
      },
      type: "run.started",
      payload: { task: "Review the system" },
    });
    const enrichedWork = await runner.getWork(mission.id);
    expect(enrichedWork.records.find((record) => record.sessionId === "child-a")).toMatchObject({
      title: "Architect",
    });
    expect(
      enrichedWork.records.find((record) => record.sessionId === "child-a"),
    ).not.toHaveProperty("fallbackOrdinal");
    expect(enrichedWork.records.find((record) => record.sessionId === "child-b")).toMatchObject({
      title: "Architect",
    });
    expect(enrichedWork.records.filter((record) => record.title === "Architect")).toHaveLength(2);
    const compactionSource = {
      kind: "agent" as const,
      runId: "root-run",
      sessionId: "root-thread",
      path: [],
    };
    await store.appendEvent(executionId, executionId, "runtime.event", {
      schemaVersion: "pragma.stream/v1",
      eventId: "compaction-started",
      sequence: 105,
      runId: "root-run",
      emittedAt,
      source: compactionSource,
      type: "progress",
      payload: {
        stage: "context.compaction.started",
        data: {
          operationId: "compact-1",
          trigger: "auto",
          runtimeId: "codex-local",
        },
      },
    });
    await store.appendEvent(executionId, executionId, "runtime.event", {
      schemaVersion: "pragma.stream/v1",
      eventId: "compaction-completed",
      sequence: 106,
      runId: "root-run",
      emittedAt: new Date(childConversationStartedAt + 5).toISOString(),
      source: compactionSource,
      type: "progress",
      payload: {
        stage: "context.compaction.completed",
        data: {
          operationId: "compact-1",
          trigger: "auto",
          runtimeId: "codex-local",
        },
      },
    });
    await expect(
      runner.getWorkConversation({ id: mission.id, recordId: subagent!.recordId, limit: 100 }),
    ).resolves.toMatchObject({
      entries: [
        expect.objectContaining({
          kind: "user",
          content: "Inspect the repository and report complete findings",
        }),
        expect.objectContaining({ kind: "assistant", content: "Subagent findings" }),
        expect.objectContaining({ kind: "user", content: "Refine the findings" }),
        expect.objectContaining({ kind: "assistant", content: "Refined findings" }),
      ],
    });
    await expect(runner.getChat({ id: mission.id, limit: 50 })).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ kind: "agent_activity", action: "spawn" }),
        expect.objectContaining({
          kind: "context_operation",
          operationId: "compact-1",
          status: "succeeded",
        }),
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
    await vi.waitFor(async () => await runner.delete(mission.id), {
      timeout: settlementTimeoutMs,
    });
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
      id: "1xddvess309a6gme",
      name: "Writer",
      description: "Writes concise answers",
      tags: [],
      scope: "Writing",
      instructions: "Write concise answers.",
      workspace: root,
      pragmaHome,
      defaultRuntimeId: "fake",
      models: { default: { model: { providerId: "test", modelId: "test-model" } } },
    });
    const executions = createFileExecutionStore({ pragmaHome });
    const expertSessions = createFileExpertSessionStore({ executions, pragmaHome });
    const runtimeBinding = (await runtimes.bind({ runtimeId: "fake" })).binding;
    const sessionId = "10000000-0000-4000-8000-000000000001";
    const executionId = "20000000-0000-4000-8000-000000000001";
    const contextId = "30000000-0000-4000-8000-000000000001";
    const interactionId = "pending-question";
    const startedAt = new Date().toISOString();
    const definition = { id: expert.id, kind: "expert" as const };
    await expertSessions.create({
      schemaVersion: "pragma.expert-session/v5",
      sessionId,
      expertId: expert.id,
      definitionFingerprint: fingerprintExpertExecutionDefinition(expert),
      status: "open",
      activeExecutionId: executionId,
      queuedRequestIds: [],
      executionIds: [executionId],
      rootContextId: contextId,
      contexts: {
        [contextId]: {
          schemaVersion: "pragma.runtime-context/v5",
          contextId,
          owner: { type: "expert-session", ownerId: sessionId },
          origin: { type: "expert-session", sessionId },
          expert: { id: expert.id },
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
        schemaVersion: "pragma.execution/v9",
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

  it("round-trips a Flow human interaction with globally unique resource IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-human-"));
    temporaryPaths.push(root);
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const expert = expertFixture();
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
      flowInput: { goal: "Review the release", workspace: root },
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
    const executionStore = createFileExecutionStore({ pragmaHome: join(root, "state") });
    const execution = (await executionStore.get(waitingMission.execution!.id))!;
    await executionStore.update(execution.executionId, {
      state: {
        ...execution.state,
        __recoveryClaim: {
          claimId: "exited-desktop-process",
          processId: 2_147_483_647,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
      },
    });
    const restartingRunner = createMissionRunner({
      missions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: join(root, "state"),
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    });

    const chat = await restartingRunner.getChat({ id: mission.id, limit: 50 });
    expect(chat.execution).toMatchObject({
      id: waitingMission.execution!.id,
      status: "waiting",
      interruptible: false,
    });
    expect(chat.pendingInteractions).toHaveLength(1);
    expect(chat.pendingInteractions[0]?.request.kind).toBe("question");
    const interactions = await restartingRunner.listHumanInteractions(mission.id);
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.request.kind).toBe("question");
    await restartingRunner.respondToHumanInteraction({
      missionId: mission.id,
      interactionId: interactions[0]!.interactionId,
      requestId: "00000000-0000-4000-8000-000000000001",
      response: {
        answers: { "Approve the release?": "Ship" },
      },
    });
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: settlementTimeoutMs },
    );
    const events = (
      await new StoredExecutionView(waitingMission.execution!.id, executionStore).listEvents({
        scope: { kind: "all" },
        limit: 1_000,
      })
    ).items;
    expect(events.filter((event) => event.type === "human.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "human.responded")).toHaveLength(1);
  });

  it("continues a Mission whose persisted ExpertSession uses a legacy Expert id", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-legacy-expert-session-"));
    temporaryPaths.push(root);
    const pragmaHome = join(root, "state");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expertFixture()],
    });
    const expertResource = snapshot.resources.find((resource) => resource.kind === "Expert")!;
    await writeFile(
      join(root, "projects", snapshot.projectId, "identity-migrations.json"),
      `${JSON.stringify(
        {
          schemaVersion: "pragma.desktop-project-identity-migrations/v1",
          projectId: snapshot.projectId,
          migrations: [
            {
              kind: "Expert",
              sourceId: "issue_reporter",
              targetId: expertResource.metadata.id,
            },
          ],
        },
        undefined,
        2,
      )}\n`,
    );
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Created before DSL identity migration",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: missionExecutorSnapshot(expertResource),
    });
    const runtime = defineRuntimeDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: () => ({ id: "runtime" }),
      restoreSession: () => ({ id: "runtime" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: (_session, turn) => ({
        outputText: `writer:${turn.rawQuery}`,
        runtimeSessionId: "runtime",
      }),
      mapEvent: () => ({ events: [] }),
      closeSession: () => undefined,
    });
    const runtimes = createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" });
    const executions = createFileExecutionStore({ pragmaHome });
    const expertSessions = createFileExpertSessionStore({ executions, pragmaHome });
    const sessionId = "10000000-0000-4000-8000-000000000024";
    const executionId = "20000000-0000-4000-8000-000000000024";
    const contextId = "30000000-0000-4000-8000-000000000024";
    const now = new Date().toISOString();
    const runtimeBinding = (await runtimes.bind({ runtimeId: "fake" })).binding;
    await expertSessions.create({
      schemaVersion: "pragma.expert-session/v5",
      sessionId,
      expertId: "issue_reporter",
      definitionFingerprint: "c".repeat(64),
      status: "open",
      queuedRequestIds: [],
      executionIds: [],
      rootContextId: contextId,
      contexts: {
        [contextId]: {
          schemaVersion: "pragma.runtime-context/v5",
          contextId,
          owner: { type: "expert-session", ownerId: sessionId },
          origin: { type: "expert-session", sessionId },
          expert: { id: "issue_reporter" },
          runtime: runtimeBinding,
          lifecycle: "open",
          createdAt: now,
          updatedAt: now,
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    await missions.updateExecution(mission.id, {
      id: executionId,
      inputMessageId: mission.initialMessageId,
      sessionId,
      status: "succeeded",
      startedAt: now,
      finishedAt: now,
    });
    const runner = createMissionRunner({
      missions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome,
      runtimes,
    });

    await runner.sendMessage({
      id: mission.id,
      content: "Continue after upgrade",
      requestId: "00000000-0000-4000-8000-000000000024",
    });
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: settlementTimeoutMs },
    );

    const migrated = await expertSessions.get(sessionId);
    expect(migrated?.expertId).toBe(expertResource.metadata.id);
    expect(migrated?.contexts[migrated.rootContextId]?.expert.id).toBe(expertResource.metadata.id);
    const chat = await runner.getChat({ id: mission.id, limit: 50 });
    expect(chat.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", content: "writer:Continue after upgrade" }),
      ]),
    );
  });

  it("creates a successor ExpertSession when an existing Mission definition is incompatible", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-successor-session-"));
    temporaryPaths.push(root);
    const pragmaHome = join(root, "state");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expertFixture()],
    });
    const expertResource = snapshot.resources.find((resource) => resource.kind === "Expert")!;
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Keep working after incompatible upgrade",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: missionExecutorSnapshot(expertResource),
    });
    const runtime = defineRuntimeDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: () => ({ id: "runtime" }),
      restoreSession: () => ({ id: "runtime" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: (_session, turn) => ({
        outputText: `successor:${turn.rawQuery}`,
        runtimeSessionId: "runtime",
      }),
      mapEvent: () => ({ events: [] }),
      closeSession: () => undefined,
    });
    const runtimes = createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" });
    const executions = createFileExecutionStore({ pragmaHome });
    const expertSessions = createFileExpertSessionStore({ executions, pragmaHome });
    const sessionId = "10000000-0000-4000-8000-000000000025";
    const executionId = "20000000-0000-4000-8000-000000000025";
    const contextId = "30000000-0000-4000-8000-000000000025";
    const now = new Date().toISOString();
    const runtimeBinding = (await runtimes.bind({ runtimeId: "fake" })).binding;
    const definition = { id: expertResource.metadata.id, kind: "expert" as const };
    await expertSessions.create({
      schemaVersion: "pragma.expert-session/v5",
      sessionId,
      expertId: expertResource.metadata.id,
      definitionFingerprint: "b".repeat(64),
      status: "open",
      activeExecutionId: executionId,
      queuedRequestIds: [],
      executionIds: [executionId],
      rootContextId: contextId,
      contexts: {
        [contextId]: {
          schemaVersion: "pragma.runtime-context/v5",
          contextId,
          owner: { type: "expert-session", ownerId: sessionId },
          origin: { type: "expert-session", sessionId },
          expert: { id: expertResource.metadata.id },
          runtime: runtimeBinding,
          lifecycle: "open",
          createdAt: now,
          updatedAt: now,
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    await executions.create(
      {
        schemaVersion: "pragma.execution/v9",
        executionId,
        version: 0,
        kind: "expert-turn",
        definition,
        rootInvocationId: executionId,
        status: "running",
        input: mission.goal,
        state: {},
        lastAppliedSequence: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        invocationId: executionId,
        rootInvocationId: executionId,
        definition,
        executorId: expertResource.metadata.id,
        contextId,
        status: "running",
        input: mission.goal,
        createdAt: now,
        updatedAt: now,
      },
    );
    await missions.updateExecution(mission.id, {
      id: executionId,
      inputMessageId: mission.initialMessageId,
      sessionId,
      status: "running",
      startedAt: now,
    });
    const runner = createMissionRunner({
      missions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome,
      runtimes,
    });

    await runner.sendMessage({
      id: mission.id,
      content: "Continue on a successor",
      requestId: "00000000-0000-4000-8000-000000000025",
    });
    await vi.waitFor(
      async () => expect((await missions.get(mission.id)).execution?.status).toBe("succeeded"),
      { timeout: settlementTimeoutMs },
    );

    const updatedMission = await missions.get(mission.id);
    expect(updatedMission.execution?.sessionId).not.toBe(sessionId);
    const oldSession = await expertSessions.get(sessionId);
    expect(oldSession).toMatchObject({
      sessionId,
      definitionFingerprint: "b".repeat(64),
      lastStatus: "interrupted",
    });
    expect(oldSession?.activeExecutionId).toBeUndefined();
    await expect(executions.get(executionId)).resolves.toMatchObject({ status: "interrupted" });
    await expect(executions.getInvocation(executionId, executionId)).resolves.toMatchObject({
      status: "interrupted",
    });
    const successorId = updatedMission.execution!.sessionId!;
    expect(await expertSessions.get(successorId)).toMatchObject({
      sessionId: successorId,
      expertId: expertResource.metadata.id,
    });
    await expect(runner.getChat({ id: mission.id, limit: 50 })).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({
          kind: "assistant",
          content: "successor:Continue on a successor",
        }),
      ]),
    });
  });

  it("keeps the old ExpertSession active when successor creation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-successor-create-fails-"));
    temporaryPaths.push(root);
    const pragmaHome = join(root, "state");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [runtimeFixture(), expertFixture()],
    });
    const expertResource = snapshot.resources.find((resource) => resource.kind === "Expert")!;
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Do not damage the old session",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: missionExecutorSnapshot(expertResource),
    });
    const runtime = defineRuntimeDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: () => ({ id: "runtime" }),
      restoreSession: () => ({ id: "runtime" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: () => ({ outputText: "unreachable", runtimeSessionId: "runtime" }),
      mapEvent: () => ({ events: [] }),
      closeSession: () => undefined,
    });
    const availableRuntimes = createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: "fake",
    });
    const executions = createFileExecutionStore({ pragmaHome });
    const expertSessions = createFileExpertSessionStore({ executions, pragmaHome });
    const sessionId = "10000000-0000-4000-8000-000000000026";
    const executionId = "20000000-0000-4000-8000-000000000026";
    const contextId = "30000000-0000-4000-8000-000000000026";
    const now = new Date().toISOString();
    const runtimeBinding = (await availableRuntimes.bind({ runtimeId: "fake" })).binding;
    await expertSessions.create({
      schemaVersion: "pragma.expert-session/v5",
      sessionId,
      expertId: expertResource.metadata.id,
      definitionFingerprint: "c".repeat(64),
      status: "open",
      activeExecutionId: executionId,
      queuedRequestIds: [mission.initialMessageId],
      executionIds: [executionId],
      rootContextId: contextId,
      contexts: {
        [contextId]: {
          schemaVersion: "pragma.runtime-context/v5",
          contextId,
          owner: { type: "expert-session", ownerId: sessionId },
          origin: { type: "expert-session", sessionId },
          expert: { id: expertResource.metadata.id },
          runtime: runtimeBinding,
          lifecycle: "open",
          createdAt: now,
          updatedAt: now,
        },
      },
      createdAt: now,
      updatedAt: now,
    });
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
          status: "queued" as const,
          createdAt: now,
          updatedAt: now,
        },
      ],
    }));
    await missions.updateExecution(mission.id, {
      id: executionId,
      inputMessageId: mission.initialMessageId,
      sessionId,
      status: "running",
      startedAt: now,
    });
    const failingSuccessorRuntimes: RuntimeResolver = {
      getDefaultRuntimeId: async () => await availableRuntimes.getDefaultRuntimeId(),
      bind: async () => {
        throw new Error("Successor Runtime bind failed.");
      },
      resolve: async (request) => await availableRuntimes.resolve(request),
    };
    const runner = createMissionRunner({
      missions,
      project,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome,
      runtimes: failingSuccessorRuntimes,
    });

    await expect(
      runner.sendMessage({
        id: mission.id,
        content: "Try to continue",
        requestId: "00000000-0000-4000-8000-000000000026",
      }),
    ).rejects.toThrow("Successor Runtime bind failed.");

    await expect(expertSessions.get(sessionId)).resolves.toMatchObject({
      sessionId,
      activeExecutionId: executionId,
      queuedRequestIds: [mission.initialMessageId],
    });
    expect((await expertSessions.get(sessionId))?.lastStatus).toBeUndefined();
    await expect(missions.get(mission.id)).resolves.toMatchObject({
      execution: {
        id: executionId,
        sessionId,
        status: "running",
      },
    });
  });

  it("projects oversized replies as Mission Board references without copying full text", async () => {
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
    expect(reply.content.length).toBeLessThan(10_000);
    expect(reply.content).toContain("[Context output summary truncated.]");
    expect(reply.content).toContain("Full output is available through Context System:");
    expect(reply.content).toContain("mission-board/");
    expect(reply.content).not.toContain("x".repeat(5_000));
    const timeline = await readFile(join(root, "missions", mission.id, "messages.jsonl"), "utf8");
    expect(timeline).not.toContain('"kind":"assistant"');
    expect(timeline).not.toContain("x".repeat(5_000));
  });
});

function expertFixture(): PragmaExpertResource {
  return {
    apiVersion: "pragma/v3",
    kind: "Expert",
    metadata: {
      id: "1xddvess309a6gme",
      name: "Writer",
      description: "Writes concise answers",
      tags: [],
    },
    spec: {
      scope: "Writing",
      instructions: "Write concise answers.",
      runtime: { ref: "runtime-profile:rdzgnq05qfqcpqcm" },
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}

function expertFixtureWithReviewerTool(): PragmaExpertResource {
  const expert = expertFixture();
  return {
    ...expert,
    spec: {
      ...expert.spec,
      tools: [
        {
          adapter: "pragma.tool.call@v1",
          target: { ref: "expert:3sfd30h5017wd17d" },
          tool: {
            name: "call_reviewer",
            description: "Call the reviewer",
            approval: "none",
          },
        },
      ],
    },
  };
}

function reviewerFixture(): PragmaExpertResource {
  return {
    ...expertFixture(),
    metadata: {
      id: "3sfd30h5017wd17d",
      name: "Reviewer",
      description: "Reviews proposed work",
      tags: [],
    },
    spec: {
      ...expertFixture().spec,
      scope: "Review",
      instructions: "Review the delegated work.",
    },
  };
}

function expertTeamFixture(): PragmaExpertTeamResource {
  return {
    apiVersion: "pragma/v3",
    kind: "ExpertTeam",
    metadata: {
      id: "vyv9pwwzaksth2dd",
      name: "Editorial Team",
      description: "Coordinates writing and review",
      tags: [],
    },
    spec: {
      coordinator: { ref: "expert:1xddvess309a6gme" },
      members: [{ ref: "expert:3sfd30h5017wd17d" }],
      contextStores: [],
      delegation: {
        allow: { "1xddvess309a6gme": ["3sfd30h5017wd17d"], "3sfd30h5017wd17d": [] },
        maxConcurrency: 2,
        maxDepth: 2,
        context: "context-policy:pragma.fresh@v1",
        runtimes: {},
      },
    },
  };
}

function expertFlowFixture(): PragmaFlowResource {
  return {
    apiVersion: "pragma/v3",
    kind: "Flow",
    metadata: {
      id: "ffdfk2cczgqjda7q",
      name: "Review Flow",
      description: "Runs the reviewer",
      tags: [],
    },
    spec: {
      limits: { maxNodeVisits: 10 },
      graph: {
        start: "review",
        steps: {
          review: {
            expert: { ref: "expert:3sfd30h5017wd17d" },
            prompt: { segments: [{ text: "Flow review" }] },
          },
        },
        loops: {},
        transitions: { review: { end: true } },
      },
    },
  };
}

function runtimeFixture(runtimeId = "fake"): PragmaRuntimeProfileResource {
  return {
    apiVersion: "pragma/v3",
    kind: "RuntimeProfile",
    metadata: {
      id: "rdzgnq05qfqcpqcm",
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
    apiVersion: "pragma/v3",
    kind: "Flow",
    metadata: {
      id: "t9ne4d8njvvxv2ea",
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
            human: {
              selectionMode: "single",
              prompt: { segments: [{ text: "Approve the release?" }] },
              options: [
                { value: "ship", label: "Ship" },
                { value: "hold", label: "Hold" },
              ],
            },
          },
        },
        loops: {},
        transitions: { approve: { end: true } },
      },
    },
  };
}
