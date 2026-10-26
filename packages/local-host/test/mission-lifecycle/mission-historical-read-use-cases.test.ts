import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileExpertSessionStore, createStaticRuntimeResolver } from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { createMissionStore } from "../../src/missions/repository/mission-store.ts";
import { createSqliteExecutionStore } from "../../src/execution/sqlite-execution-store.ts";
import { writeMissionExecutionProjection } from "../../src/missions/repository/mission-execution-projection.ts";
import {
  createLocalHostMissionExecutionService,
  type LocalHostMissionExecutionResourcePorts,
  type LocalHostMissionExecutionServiceOptions,
} from "../../src/missions/execution-service.ts";

const temporaryPaths: string[] = [];
const stores = new Set<ReturnType<typeof createSqliteExecutionStore>>();
function trackedExecutionStore(pragmaHome: string) {
  const store = createSqliteExecutionStore({ pragmaHome });
  stores.add(store);
  return store;
}
function createHistoricalReadService(options: LocalHostMissionExecutionServiceOptions) {
  return createLocalHostMissionExecutionService({
    ...options,
    executionStore: trackedExecutionStore(options.pragmaHome),
  });
}
afterEach(async () => {
  await Promise.all([...stores].map((store) => store.close()));
  stores.clear();
  await Promise.all(
    temporaryPaths.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function appendExecutionEvent(
  store: ReturnType<typeof createSqliteExecutionStore>,
  executionId: string,
  invocationId: string,
  type: string,
  data: unknown,
  eventId: string = crypto.randomUUID(),
): Promise<void> {
  await store.commit({
    commitId: `event:${eventId}`,
    executionId,
    events: [{ eventId, invocationId, type, data }],
  });
}

describe("shared Mission historical read use cases", { timeout: 30_000 }, () => {
  it("hydrates delivery facts on latest and earlier pages without a control read", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-page-delivery-"));
    temporaryPaths.push(root);
    const pragmaHome = join(root, "state");
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const expert = { metadata: { id: "1xddvess309a6gme", name: "Writer" } };
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Original question",
      project: { id: "project", revision: 1 },
      executor: { kind: "expert", ref: `expert:${expert.metadata.id}`, name: expert.metadata.name },
    });
    const executionId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const timestamp = "2026-10-26T00:00:00.000Z";
    const removedId = crypto.randomUUID();
    const steerId = crypto.randomUUID();
    await missions.appendUserMessage(mission.id, {
      id: removedId,
      content: "Withdrawn",
      createdAt: timestamp,
    });
    await missions.appendUserMessage(mission.id, {
      id: steerId,
      content: "Corrected",
      createdAt: timestamp,
    });
    await missions.updateExecution(mission.id, {
      id: executionId,
      sessionId,
      inputMessageId: mission.initialMessageId,
      status: "succeeded",
      startedAt: timestamp,
    });
    const executions = trackedExecutionStore(pragmaHome);
    const sessions = createFileExpertSessionStore({ executions, pragmaHome });
    // History consumes only prompt/event facts; no Runtime or control-state query is needed.
    const readSnapshot = vi.spyOn(sessions, "readSnapshot").mockResolvedValue({
      session: {
        schemaVersion: "pragma.expert-session/v7",
        sessionId,
        expertId: expert.metadata.id,
        definitionFingerprint: "a".repeat(64),
        status: "closed",
        queuedRequestIds: [],
        executionIds: [executionId],
        rootContextId: "root",
        contexts: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      prompts: [removedId, steerId].map((requestId) => ({
        requestId,
        sessionId,
        executionId,
        purpose: "user" as const,
        content: requestId,
        mode: "steer" as const,
        status: requestId === removedId ? ("cancelled" as const) : ("succeeded" as const),
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
      events: [
        {
          eventId: crypto.randomUUID(),
          sessionId,
          schemaVersion: "pragma.expert-session-event/v1",
          cursor: { sessionId, sequence: 1 },
          type: "prompt.removed",
          data: { requestId: removedId },
          occurredAt: timestamp,
        },
      ],
    });
    const runner = createHistoricalReadService({
      missions,
      pragmaHome,
      expertSessionStore: sessions,
      resourcePorts: {
        createCompileService: () => ({}),
        readProjectResources: async () => [{ kind: "Expert", metadata: expert.metadata }],
      } as LocalHostMissionExecutionResourcePorts,
      runtimes: {
        getDefaultRuntimeId: async () => "unused",
        bind: async () => {
          throw new Error("History must not bind a Runtime");
        },
        resolve: async () => {
          throw new Error("History must not resolve a Runtime");
        },
      },
    });
    const latest = await runner.getChatPage({ id: mission.id, limit: 1 });
    expect(latest.entries).toEqual([
      expect.objectContaining({
        id: steerId,
        delivery: { requestedMode: "steer", effectiveMode: "steer", status: "succeeded" },
      }),
    ]);
    const earlier = await runner.getChatPage({
      id: mission.id,
      limit: 1,
      beforeCursor: latest.page.nextBeforeCursor!,
    });
    expect(earlier.entries).toEqual([
      expect.objectContaining({
        id: removedId,
        delivery: {
          requestedMode: "steer",
          effectiveMode: "steer",
          status: "cancelled",
          removed: true,
        },
      }),
    ]);
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    readSnapshot.mockRejectedValueOnce(new Error("Session temporarily unavailable"));
    const degraded = await runner.getChatPage({ id: mission.id, limit: 1 });
    expect(degraded.entries[0]?.id).toBe(steerId);
    expect(degraded.syncIssues).toEqual([
      expect.objectContaining({ section: "history", retryable: true }),
    ]);
    const reloaded = await runner.getChatPage({ id: mission.id, limit: 50 });
    expect(reloaded.entries.find((entry) => entry.id === removedId)).toMatchObject({
      delivery: { removed: true },
    });
    expect(reloaded.syncIssues).toBeUndefined();
  });

  it("normalizes an archived legacy projection without rewriting it from a read", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-order-repair-"));
    temporaryPaths.push(root);
    const pragmaHome = join(root, "state");
    const expert = { metadata: { id: "1xddvess309a6gme", name: "Writer" } };
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Repair old conversation",
      project: { id: "project", revision: 1 },
      executor: { kind: "expert", ref: `expert:${expert.metadata.id}`, name: expert.metadata.name },
    });
    const executions = trackedExecutionStore(pragmaHome);
    const executionId = "00000000-0000-4000-8000-000000000121";
    const timestamp = new Date("2026-08-24T00:00:00.000Z").getTime();
    const createdAt = new Date(timestamp).toISOString();
    const definition = { id: expert.metadata.id, kind: "expert" as const };
    await executions.create(
      {
        schemaVersion: "pragma.execution/v12",
        executionId,
        version: 0,
        kind: "expert-turn",
        definition,
        rootInvocationId: executionId,
        status: "running",
        input: { text: mission.goal, attachments: [] },
        state: {},
        lastAppliedSequence: 0,
        createdAt,
        updatedAt: createdAt,
      },
      {
        invocationId: executionId,
        rootInvocationId: executionId,
        definition,
        executorId: expert.metadata.id,
        contextId: "00000000-0000-4000-8000-000000000122",
        status: "running",
        pendingExpertMessages: [],
        input: { text: mission.goal, attachments: [] },
        createdAt,
        updatedAt: createdAt,
      },
    );
    await appendExecutionEvent(
      executions,
      executionId,
      executionId,
      "invocation.message.appended",
      {
        runId: "run-a",
        source: { kind: "runtime", runId: "run-a", path: [] },
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Reasoning" },
            { type: "text", text: "Answer" },
          ],
          api: "test",
          provider: "test",
          model: "test-model",
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
          timestamp,
        },
      },
    );
    await executions.commit({
      commitId: "complete-old-execution",
      executionId,
      executionPatch: { status: "succeeded" },
    });
    await executions.archive(executionId);
    await missions.appendExecutionReference({
      missionId: mission.id,
      inputMessageId: mission.initialMessageId,
      executionId,
      createdAt,
    });
    const projectionDirectory = join(missions.storagePath!(mission.id), "execution-projections");
    const projectionPath = join(projectionDirectory, `${executionId}.jsonl`);
    // Written by the pre-repair writer at d48a414d839d, before orderingVersion existed.
    const historicalProjection = new URL(
      "../mission-repository/fixtures/mission-execution-projection-pre-order-repair.jsonl",
      import.meta.url,
    );
    await mkdir(projectionDirectory, { recursive: true });
    await copyFile(historicalProjection, projectionPath);
    const runtime = defineRuntimeTestDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: () => ({ id: "runtime" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: () => ({ outputText: "unused", runtimeSessionId: "runtime" }),
      mapEvent: () => ({ events: [] }),
    });
    const runner = createHistoricalReadService({
      missions,
      resourcePorts: {
        createCompileService: () => ({}),
        readProjectResources: async () => [{ kind: "Expert", metadata: expert.metadata }],
      } as LocalHostMissionExecutionResourcePorts,
      pragmaHome,
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    });

    const projectionBefore = await readFile(projectionPath, "utf8");
    const chat = await runner.getChatPage({ id: mission.id, limit: 50 });
    expect(chat.entries.map((entry) => entry.kind)).toEqual(["user", "thinking", "assistant"]);
    expect(chat.syncIssues).toBeUndefined();
    expect(await readFile(projectionPath, "utf8")).toBe(projectionBefore);
  });

  it("pages a normalized legacy projection without background repair", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-final-boundary-repair-"));
    temporaryPaths.push(root);
    const expert = { metadata: { id: "1xddvess309a6gme", name: "Writer" } };
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Repair late teammate output",
      project: { id: "project", revision: 1 },
      executor: { kind: "expert", ref: `expert:${expert.metadata.id}`, name: expert.metadata.name },
    });
    const executionId = "00000000-0000-4000-8000-000000000123";
    await missions.appendExecutionReference({
      missionId: mission.id,
      inputMessageId: mission.initialMessageId,
      executionId,
      createdAt: "2026-08-24T00:00:00.000Z",
    });
    const projectionDirectory = join(missions.storagePath!(mission.id), "execution-projections");
    const projectionPath = join(projectionDirectory, `${executionId}.jsonl`);
    await writeMissionExecutionProjection(
      projectionPath,
      executionId,
      [
        {
          id: "coordinator-intermediate",
          executionId,
          invocationId: "coordinator-root",
          executorId: "0000000000pragma",
          eventSequence: 1,
          kind: "assistant",
          content: "I will delegate this work",
          streaming: false,
          createdAt: "2026-08-24T00:00:00.000Z",
        },
        {
          id: "coordinator-final",
          executionId,
          invocationId: "coordinator-root",
          executorId: "0000000000pragma",
          eventSequence: 2,
          kind: "assistant",
          content: "Final answer",
          streaming: false,
          finalAnswer: true,
          createdAt: "2026-08-24T00:00:01.000Z",
        },
        {
          id: "teammate-late-thinking",
          executionId,
          invocationId: "teammate",
          executorId: expert.metadata.id,
          eventSequence: 3,
          kind: "thinking",
          content: "Late diagnostic reasoning",
          streaming: false,
          createdAt: "2026-08-24T00:00:02.000Z",
        },
      ],
      2,
    );
    const runtime = defineRuntimeTestDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: () => ({ id: "runtime" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: () => ({ outputText: "unused", runtimeSessionId: "runtime" }),
      mapEvent: () => ({ events: [] }),
    });
    const runner = createHistoricalReadService({
      missions,
      resourcePorts: {
        createCompileService: () => ({}),
        readProjectResources: async () => [{ kind: "Expert", metadata: expert.metadata }],
      } as LocalHostMissionExecutionResourcePorts,
      pragmaHome: join(root, "state"),
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
      getSystemExecutorMetadata: () => [
        {
          id: "0000000000pragma",
          name: "Pragma",
          avatarId: "pragma.avatar.expert.default",
        },
      ],
    });

    const projectionBefore = await readFile(projectionPath, "utf8");
    const latest = await runner.getChatPage({ id: mission.id, limit: 2 });
    expect(latest.entries.map((entry) => entry.id)).toEqual([
      "teammate-late-thinking",
      "coordinator-final",
    ]);
    expect(latest.entries).toMatchObject([
      { executorId: expert.metadata.id, executorName: "Writer" },
      {
        executorId: "0000000000pragma",
        executorName: "Pragma",
        executorAvatarId: "pragma.avatar.expert.default",
      },
    ]);
    const earlier = await runner.getChatPage({
      id: mission.id,
      beforeCursor: latest.page.nextBeforeCursor,
      limit: 2,
    });
    expect(earlier.entries.map((entry) => entry.id)).toEqual([
      mission.initialMessageId,
      "coordinator-intermediate",
    ]);
    expect(await readFile(projectionPath, "utf8")).toBe(projectionBefore);
  });

  it("projects initial Mission attachments onto the durable user chat entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-chat-attachments-"));
    temporaryPaths.push(root);
    const sourceImage = join(root, "screen.png");
    await writeFile(sourceImage, "image-bytes");
    const expert = { metadata: { id: "1xddvess309a6gme", name: "Writer" } };
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Summarize the image",
      project: { id: "project", revision: 1 },
      executor: { kind: "expert", ref: `expert:${expert.metadata.id}`, name: expert.metadata.name },
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
    const runtime = defineRuntimeTestDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: () => ({ id: "runtime" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: () => ({ outputText: "done", runtimeSessionId: "runtime" }),
      mapEvent: () => ({ events: [] }),
    });
    const runner = createHistoricalReadService({
      missions,
      resourcePorts: {
        createCompileService: () => ({}),
        readProjectResources: async () => [{ kind: "Expert", metadata: expert.metadata }],
      } as LocalHostMissionExecutionResourcePorts,
      pragmaHome: join(root, "state"),
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    });

    const chat = await runner.getChatPage({ id: mission.id, limit: 50 });
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

  it("paginates a single long Mission turn by visible entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-long-turn-page-"));
    temporaryPaths.push(root);
    const expert = { metadata: { id: "1xddvess309a6gme", name: "Writer" } };
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Run one very long turn",
      project: { id: "project", revision: 1 },
      executor: { kind: "expert", ref: `expert:${expert.metadata.id}`, name: expert.metadata.name },
    });
    const executionId = "00000000-0000-4000-8000-000000000077";
    await missions.appendExecutionReference({
      missionId: mission.id,
      inputMessageId: mission.initialMessageId,
      executionId,
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    await missions.writeExecutionProjection(
      mission.id,
      executionId,
      Array.from({ length: 45 }, (_, index) => ({
        id: `assistant:${index + 1}`,
        timelineSequence: 1,
        executionId,
        kind: "assistant" as const,
        content: `answer ${index + 1}`,
        streaming: false,
        createdAt: new Date(Date.UTC(2026, 7, 25, 0, 0, index + 1)).toISOString(),
      })),
    );
    const runtime = defineRuntimeTestDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
      createSession: () => ({ id: "runtime" }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: () => ({ outputText: "unused", runtimeSessionId: "runtime" }),
      mapEvent: () => ({ events: [] }),
    });
    const runner = createHistoricalReadService({
      missions,
      resourcePorts: {
        createCompileService: () => ({}),
        readProjectResources: async () => [{ kind: "Expert", metadata: expert.metadata }],
      } as LocalHostMissionExecutionResourcePorts,
      pragmaHome: join(root, "state"),
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    });

    const latest = await runner.getChatPage({ id: mission.id, limit: 20 });
    expect(latest.entries.map((entry) => entry.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `assistant:${index + 26}`),
    );
    expect(latest.page.nextBeforeCursor).toBeTypeOf("string");
    const middle = await runner.getChatPage({
      id: mission.id,
      beforeCursor: latest.page.nextBeforeCursor,
      limit: 20,
    });
    expect(middle.entries.map((entry) => entry.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `assistant:${index + 6}`),
    );
    const earliest = await runner.getChatPage({
      id: mission.id,
      beforeCursor: middle.page.nextBeforeCursor,
      limit: 20,
    });
    expect(earliest.entries.map((entry) => entry.id)).toEqual([
      mission.initialMessageId,
      ...Array.from({ length: 5 }, (_, index) => `assistant:${index + 1}`),
    ]);
    expect(earliest.page.nextBeforeCursor).toBeUndefined();
  });
});
