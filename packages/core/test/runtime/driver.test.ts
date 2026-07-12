import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ContextSystem,
  ExpertAgent,
  PragmaPaths,
  withExecutionRunScope,
  type DirectiveExecutionContext,
  type RuntimeAdapter,
  type RuntimeAgentSession,
  type RuntimeDriverSessionRequest,
} from "../../src/index.ts";
import { defineRuntimeDriver } from "../../src/runtime/driver.ts";
import { openRuntimeSession } from "../../src/runtime/session-factory.ts";
import type {
  RuntimeSessionCheckpoint,
  RuntimeSessionRestoreRequest,
} from "../../src/runtime/session-persistence.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("defineRuntimeDriver", () => {
  const owner = { workflowRunId: "workflow-runtime-driver", taskRunId: "task-runtime-driver" };

  it("rejects mismatched Workflow and task execution before native Session creation", async () => {
    let createSessionCalled = false;
    const runtime = defineRuntimeDriver<FakeEvent, FakeSession>({
      descriptor: { id: "fake-runtime", kind: "fake-runtime", displayName: "Fake Runtime" },
      createSession() {
        createSessionCalled = true;
        return { id: "native", attempts: 0 };
      },
      startTurn: () => ({}),
      mapEvent: () => ({ events: [] }),
    });
    const agent = await createTestAgent("owner-mismatch");
    const execution = {
      workflow: { id: "workflow-a" },
      task: { id: "task-a", workflowRunId: "workflow-b" },
    } as DirectiveExecutionContext;

    await expect(
      openRuntimeSession(runtime, {
        agent,
        execution,
        context: withExecutionRunScope(undefined, {
          workflowRunId: "workflow-a",
          taskRunId: "task-a",
        }),
      }),
    ).rejects.toThrow("belongs to Workflow workflow-b, not workflow-a");
    expect(createSessionCalled).toBe(false);
  });

  it("rejects a run scope that does not match the execution task", async () => {
    const runtime = defineRuntimeDriver<FakeEvent, FakeSession>({
      descriptor: { id: "fake-runtime", kind: "fake-runtime", displayName: "Fake Runtime" },
      createSession: () => ({ id: "native", attempts: 0 }),
      startTurn: () => ({}),
      mapEvent: () => ({ events: [] }),
    });
    const agent = await createTestAgent("scope-mismatch");
    const execution = {
      workflow: { id: "workflow-a" },
      task: { id: "task-a", workflowRunId: "workflow-a" },
    } as DirectiveExecutionContext;

    await expect(
      openRuntimeSession(runtime, {
        agent,
        execution,
        context: withExecutionRunScope(undefined, {
          workflowRunId: "workflow-a",
          taskRunId: "task-other",
        }),
      }),
    ).rejects.toThrow("execution scope must match Workflow workflow-a and task task-a");
  });
  it("rejects a runtime session ref with an empty native id", async () => {
    let createSessionCalled = false;
    const runtime = defineRuntimeDriver<FakeEvent, FakeSession>({
      descriptor: {
        id: "fake-runtime",
        kind: "fake-runtime",
        displayName: "Fake Runtime",
      },
      createSession() {
        createSessionCalled = true;
        return { id: "native-session-1", attempts: 0 };
      },
      startTurn() {
        return { outputText: "ok" };
      },
      mapEvent() {
        return { events: [] };
      },
    });
    const agent = await createTestAgent("invalid-ref");

    await expect(
      openTestSession(runtime, {
        agent,
        owner,
        systemSessionId: "invalid-ref-session",
        runtimeSession: { type: "fake-runtime", id: "" },
      }),
    ).rejects.toThrow();
    expect(createSessionCalled).toBe(false);
  });

  it("rejects a runtime session ref for a different runtime kind", async () => {
    const runtime = defineRuntimeDriver<FakeEvent, FakeSession>({
      descriptor: {
        id: "fake-runtime",
        kind: "fake-runtime",
        displayName: "Fake Runtime",
      },
      createSession() {
        return { id: "native-session-1", attempts: 0 };
      },
      startTurn() {
        return { outputText: "ok" };
      },
      mapEvent() {
        return { events: [] };
      },
    });
    const agent = await ExpertAgent.create({
      id: "coder",
      name: "Coder",
      description: "Responsible for code changes.",
      tags: ["coding"],
      version: "0.0.0",
      scope: "workspace",
      workspace: "/tmp/pragma-runtime-driver-mismatch-test",
      pragmaHome: await createTestPragmaHome("mismatch"),
      contextSystem: new ContextSystem(),
    });

    await expect(
      openTestSession(runtime, {
        agent,
        owner,
        systemSessionId: "mismatched-ref-session",
        runtimeSession: { type: "other-runtime", id: "session-1" },
      }),
    ).rejects.toThrow(
      "Runtime session type mismatch: cannot resume other-runtime:session-1 with runtime fake-runtime.",
    );
  });

  it("runs a native driver through core stream, retry, and checkpoint workflows", async () => {
    const checkpoints: RuntimeSessionCheckpoint[] = [];
    const restoreRequests: RuntimeSessionRestoreRequest[] = [];
    const runtime = defineRuntimeDriver<FakeEvent, FakeSession>(
      {
        descriptor: {
          id: "fake-runtime",
          kind: "fake-runtime",
          displayName: "Fake Runtime",
          capabilities: {
            supportsStreaming: true,
            supportsAbort: true,
          },
        },
        resolvePersistence(ctx) {
          return {
            mode: "checkpoint",
            sessionDir: ctx.paths.runtimeSessionDir("fake"),
            checkpointOn: ["session.created", "runtimeSessionId.changed", "turn.completed"],
          };
        },
        createSession() {
          return {
            id: "native-session-1",
            attempts: 0,
          };
        },
        readSession(session) {
          return {
            runtimeSessionId: session.id,
          };
        },
        async startTurn(session, turn) {
          session.attempts += 1;

          if (turn.attempt === 1) {
            turn.stream.writeNative({ type: "delta", text: "not json" });
            turn.stream.writeNative({ type: "completed", text: "not json" });
            return { outputText: "not json" };
          }

          session.id = "native-session-2";
          turn.stream.writeNative({ type: "delta", text: '{"ok":true}' });
          turn.stream.writeNative({ type: "completed", text: '{"ok":true}' });
          return {
            outputText: '{"ok":true}',
            runtimeSessionId: session.id,
          };
        },
        mapEvent(event, ctx) {
          if (event.type === "delta") {
            return {
              events: [ctx.events.messageDelta(event.text)],
              outputDelta: event.text,
            };
          }

          return {
            events: [ctx.events.messageCompleted(event.text)],
            completedText: event.text,
          };
        },
      },
      {
        persistenceProvider: {
          restore(request) {
            restoreRequests.push(request);
            return {};
          },
          checkpoint(checkpoint) {
            checkpoints.push(checkpoint);
          },
        },
      },
    );
    const agent = await ExpertAgent.create({
      id: "coder",
      name: "Coder",
      description: "Responsible for code changes.",
      tags: ["coding"],
      version: "0.0.0",
      scope: "workspace",
      workspace: "/tmp/pragma-runtime-driver-test",
      pragmaHome: await createTestPragmaHome("workflow"),
      contextSystem: new ContextSystem(),
    });
    const session = await openTestSession(runtime, {
      agent,
      owner,
      systemSessionId: "system-session-1",
    });
    const handle = session.submit({
      runId: "run-1",
      query: "Return JSON",
      output: z.object({ ok: z.boolean() }),
      outputRetryLimit: 1,
    });
    const events = [];
    for await (const event of handle.events) {
      events.push(event);
    }
    const result = await handle.result;

    expect(result.result.output).toEqual({ ok: true });
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "message.completed",
      "message.delta",
      "message.completed",
      "run.completed",
    ]);
    expect(session.info().runtimeSession.id).toBe("native-session-2");
    const sessionRecord = JSON.parse(
      await readFile(
        new PragmaPaths({ pragmaHome: agent.pragmaHome }).systemSessionManifest(
          owner.workflowRunId,
          "system-session-1",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(sessionRecord).toMatchObject({
      schemaVersion: 1,
      workflowRunId: owner.workflowRunId,
      systemSessionId: "system-session-1",
      agentId: agent.id,
      taskRunId: owner.taskRunId,
      runtimeSessionRef: { type: "fake-runtime", id: "native-session-2" },
      currentWorkspace: agent.workspace,
      workspaceHistory: [agent.workspace],
      status: "active",
    });
    expect(restoreRequests).toHaveLength(1);
    expect(checkpoints.map((checkpoint) => checkpoint.trigger)).toEqual([
      "session.created",
      "runtimeSessionId.changed",
      "turn.completed",
    ]);
  });

  it("rejects restore when the workflow-owned system session record is missing", async () => {
    let destroyedRuntimeSessionId: string | undefined;
    const runtime = defineRuntimeDriver<FakeEvent, FakeSession>(
      {
        descriptor: {
          id: "fake-runtime",
          kind: "fake-runtime",
          displayName: "Fake Runtime",
        },
        createSession() {
          throw new Error("Native session creation should not be reached.");
        },
        startTurn() {
          return {};
        },
        mapEvent() {
          return { events: [] };
        },
      },
      {
        persistenceProvider: {
          restore() {
            throw new Error("Restore failed");
          },
          checkpoint() {},
        },
      },
    );
    const agent = await ExpertAgent.create({
      id: "coder-restore-failure",
      name: "Coder",
      description: "Responsible for code changes.",
      tags: ["coding"],
      version: "0.0.0",
      scope: "workspace",
      workspace: "/tmp/pragma-runtime-driver-restore-failure-test",
      pragmaHome: await createTestPragmaHome("restore-failure"),
      contextSystem: new ContextSystem(),
      hooks: {
        afterSessionDestroy: ({ session }) => {
          destroyedRuntimeSessionId = session.runtimeSession.id;
        },
      },
    });

    await expect(
      openTestSession(runtime, {
        agent,
        owner,
        systemSessionId: "restore-failure-session",
        runtimeSession: { type: "fake-runtime", id: "session-requested" },
      }),
    ).rejects.toThrow(
      "Runtime system session was not found: restore-failure-session in workflow workflow-runtime-driver.",
    );
    expect(destroyedRuntimeSessionId).toBeUndefined();
  });

  it("marks the session record failed when beforeSessionCreate rejects", async () => {
    const runtime = defineRuntimeDriver<FakeEvent, FakeSession>({
      descriptor: {
        id: "fake-runtime",
        kind: "fake-runtime",
        displayName: "Fake Runtime",
      },
      createSession() {
        throw new Error("Native session creation should not be reached.");
      },
      startTurn() {
        return {};
      },
      mapEvent() {
        return { events: [] };
      },
    });
    const pragmaHome = await createTestPragmaHome("before-hook-failure");
    const agent = await ExpertAgent.create({
      id: "coder-before-hook-failure",
      name: "Coder",
      description: "Responsible for code changes.",
      tags: ["coding"],
      version: "0.0.0",
      scope: "workspace",
      workspace: "/tmp/pragma-runtime-driver-before-hook-failure-test",
      pragmaHome,
      contextSystem: new ContextSystem(),
      hooks: {
        beforeSessionCreate: () => {
          throw new Error("beforeSessionCreate failed");
        },
      },
    });

    await expect(
      openTestSession(runtime, {
        agent,
        owner,
        systemSessionId: "before-hook-failure-session",
      }),
    ).rejects.toThrow("beforeSessionCreate failed");
    const record = JSON.parse(
      await readFile(
        new PragmaPaths({ pragmaHome }).systemSessionManifest(
          owner.workflowRunId,
          "before-hook-failure-session",
        ),
        "utf8",
      ),
    ) as { readonly status: string };
    expect(record.status).toBe("failed");
  });

  it("does not carry captured output text across structured output retries", async () => {
    const runtime = defineRuntimeDriver<FakeEvent, FakeSession>({
      descriptor: {
        id: "fake-runtime",
        kind: "fake-runtime",
        displayName: "Fake Runtime",
      },
      createSession() {
        return {
          id: "native-session-1",
          attempts: 0,
        };
      },
      readSession(session) {
        return { runtimeSessionId: session.id };
      },
      startTurn(session, turn) {
        session.attempts += 1;

        if (turn.attempt === 1) {
          turn.stream.writeNative({ type: "delta", text: "not json" });
          return {};
        }

        turn.stream.writeNative({ type: "delta", text: '{"ok":true}' });
        return {};
      },
      mapEvent(event, ctx) {
        return event.type === "delta"
          ? {
              events: [ctx.events.messageDelta(event.text)],
              outputDelta: event.text,
            }
          : {
              events: [ctx.events.messageCompleted(event.text)],
              completedText: event.text,
            };
      },
    });
    const agent = await ExpertAgent.create({
      id: "coder",
      name: "Coder",
      description: "Responsible for code changes.",
      tags: ["coding"],
      version: "0.0.0",
      scope: "workspace",
      workspace: "/tmp/pragma-runtime-driver-retry-test",
      pragmaHome: await createTestPragmaHome("retry"),
      contextSystem: new ContextSystem(),
    });
    const session = await openTestSession(runtime, { agent, owner });

    const result = await session.submit({
      query: "Return JSON",
      output: z.object({ ok: z.boolean() }),
      outputRetryLimit: 1,
    }).result;

    expect(result.result.output).toEqual({ ok: true });
  });

  it("rejects session creation when the runtime cannot be used", async () => {
    const runtime = defineRuntimeDriver<FakeEvent, FakeSession>({
      descriptor: {
        id: "fake-runtime",
        kind: "fake-runtime",
        displayName: "Fake Runtime",
      },
      canUse: () => ({
        usable: false,
        reason: "Fake runtime binary is missing.",
      }),
      createSession() {
        throw new Error("Session creation should not be reached.");
      },
      startTurn() {
        return {};
      },
      mapEvent(event, ctx) {
        return event.type === "delta"
          ? {
              events: [ctx.events.messageDelta(event.text)],
              outputDelta: event.text,
            }
          : {
              events: [ctx.events.messageCompleted(event.text)],
              completedText: event.text,
            };
      },
    });
    const agent = await ExpertAgent.create({
      id: "coder",
      name: "Coder",
      description: "Responsible for code changes.",
      tags: ["coding"],
      version: "0.0.0",
      scope: "workspace",
      workspace: "/tmp/pragma-runtime-driver-can-use-test",
      pragmaHome: await createTestPragmaHome("can-use"),
      contextSystem: new ContextSystem(),
    });

    await expect(openTestSession(runtime, { agent, owner })).rejects.toThrow(
      "Runtime is not available: Fake Runtime (fake-runtime). Fake runtime binary is missing.",
    );
  });
});

async function createTestAgent(suffix: string): Promise<ExpertAgent> {
  return await ExpertAgent.create({
    id: `coder-${suffix}`,
    name: "Coder",
    description: "Responsible for code changes.",
    tags: ["coding"],
    version: "0.0.0",
    scope: "workspace",
    workspace: `/tmp/pragma-runtime-driver-${suffix}-test`,
    pragmaHome: await createTestPragmaHome(suffix),
    contextSystem: new ContextSystem(),
  });
}

async function createTestPragmaHome(suffix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `pragma-runtime-driver-${suffix}-`));
  tempDirs.push(dir);
  return dir;
}

type FakeEvent =
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "completed"; readonly text: string };

interface FakeSession {
  id: string;
  attempts: number;
}

async function openTestSession(
  runtime: RuntimeAdapter,
  request: Omit<RuntimeDriverSessionRequest, "workflowExecution"> & {
    readonly owner: { readonly workflowRunId: string; readonly taskRunId?: string | undefined };
  },
): Promise<RuntimeAgentSession> {
  const taskRunId = request.owner.taskRunId ?? "task-runtime-driver";
  const execution = {
    workflow: { id: request.owner.workflowRunId },
    task: {
      id: taskRunId,
      workflowRunId: request.owner.workflowRunId,
    },
  } as DirectiveExecutionContext;
  const { owner, ...sessionRequest } = request;

  return await openRuntimeSession(runtime, {
    ...sessionRequest,
    execution,
    context: withExecutionRunScope(sessionRequest.context, {
      workflowRunId: owner.workflowRunId,
      taskRunId,
    }),
  });
}
