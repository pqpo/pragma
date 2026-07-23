import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFileExecutionStore,
  createFileExpertSessionStore,
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
  defineRuntimeDriver,
  fingerprintExpertExecutionDefinition,
  PragmaPaths,
  type ExpertAgentHumanRequest,
  type ExpertAgentHumanResponse,
  type RuntimeDriverSessionContext,
} from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })),
  );
});

describe("ExpertSession human interaction recovery", () => {
  it("immediately replaces a lease owned by a process that has exited", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-stale-session-lease-"));
    tempDirs.push(home);
    const executions = createFileExecutionStore({ pragmaHome: home });
    const sessions = createFileExpertSessionStore({ executions, pragmaHome: home });
    const now = new Date().toISOString();
    await sessions.create({
      schemaVersion: "pragma.expert-session/v4",
      sessionId: "stale-lease-session",
      expertId: "expert",
      expertVersion: "1.0.0",
      definitionFingerprint: "a".repeat(64),
      status: "open",
      queuedRequestIds: [],
      executionIds: [],
      rootContextId: "root",
      contexts: {
        root: {
          schemaVersion: "pragma.runtime-context/v4",
          contextId: "root",
          owner: { type: "expert-session", ownerId: "stale-lease-session" },
          origin: { type: "expert-session", sessionId: "stale-lease-session" },
          expert: { id: "expert", version: "1.0.0" },
          runtime: { runtimeId: "fake", revision: 1, fingerprint: "a".repeat(64) },
          lifecycle: "open",
          createdAt: now,
          updatedAt: now,
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    const paths = new PragmaPaths({ pragmaHome: home });
    await writeFile(
      paths.expertSessionLease("stale-lease-session"),
      `${JSON.stringify({
        claimId: "exited-owner",
        processId: 2_147_483_647,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      })}\n`,
      "utf8",
    );

    await expect(sessions.claimLease("stale-lease-session", "new-owner", 30_000)).resolves.toBe(
      true,
    );
    await sessions.releaseLease("stale-lease-session", "new-owner");
  });

  it.each([
    {
      name: "tool approval",
      storedRequest: {
        kind: "tool_approval",
        toolName: "write_file",
        toolCallId: "tool-call-before-restart",
        reason: "Write the generated file.",
        input: { path: "result.txt" },
      } satisfies ExpertAgentHumanRequest,
      regeneratedRequest: {
        kind: "tool_approval",
        toolName: "write_file",
        toolCallId: "tool-call-after-restart",
        reason: "Write the generated file.",
        input: { path: "result.txt" },
      } satisfies ExpertAgentHumanRequest,
      response: {
        kind: "tool_approval",
        approved: true,
      } satisfies ExpertAgentHumanResponse,
    },
    {
      name: "askUserQuestion",
      storedRequest: {
        kind: "user_question",
        toolName: "askUserQuestion",
        toolCallId: "question-before-restart",
        questions: [
          {
            question: "Which environment?",
            header: "Environment",
            kind: "single_choice",
            options: [
              { label: "staging", description: "Use staging." },
              { label: "production", description: "Use production." },
            ],
          },
        ],
      } satisfies ExpertAgentHumanRequest,
      regeneratedRequest: {
        kind: "user_question",
        toolName: "askUserQuestion",
        toolCallId: "question-after-restart",
        questions: [
          {
            question: "Which environment?",
            header: "Environment",
            kind: "single_choice",
            options: [
              { label: "staging", description: "Use staging." },
              { label: "production", description: "Use production." },
            ],
          },
        ],
      } satisfies ExpertAgentHumanRequest,
      response: {
        kind: "user_question",
        answered: true,
        answers: { "Which environment?": "staging" },
      } satisfies ExpertAgentHumanResponse,
    },
  ])("restores an unanswered $name after a process restart", async (scenario) => {
    const home = await mkdtemp(join(tmpdir(), "pragma-human-recovery-"));
    tempDirs.push(home);
    const executions = createFileExecutionStore({ pragmaHome: home });
    const sessions = createFileExpertSessionStore({ executions, pragmaHome: home });
    let runtimeStarts = 0;
    const runtime = createRecoveryRuntime(scenario.regeneratedRequest, () => {
      runtimeStarts += 1;
    });
    const runtimes = createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: "human-recovery",
    });
    const runtimeBinding = (await runtimes.bind({ runtimeId: "human-recovery" })).binding;
    const expert = await defineExpert({
      id: "human-recovery-expert",
      name: "Human recovery expert",
      description: "Exercises restart recovery.",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: home,
      pragmaHome: home,
    });
    const sessionId = "session-1";
    const executionId = "execution-1";
    const contextId = "context-1";
    const interactionId = "interaction-1";
    const now = new Date().toISOString();
    const definition = {
      id: expert.id,
      version: expert.version,
      kind: "expert" as const,
    };
    await sessions.create({
      schemaVersion: "pragma.expert-session/v4",
      sessionId,
      expertId: expert.id,
      expertVersion: expert.version,
      definitionFingerprint: fingerprintExpertExecutionDefinition(expert),
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
          createdAt: now,
          updatedAt: now,
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    await executions.create(
      {
        schemaVersion: "pragma.execution/v6",
        executionId,
        version: 0,
        kind: "expert-turn",
        definition,
        rootInvocationId: executionId,
        status: "running",
        input: "Continue after the human response.",
        state: {},
        lastAppliedSequence: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        invocationId: executionId,
        rootInvocationId: executionId,
        definition,
        executorId: expert.id,
        contextId,
        status: "running",
        input: "Continue after the human response.",
        createdAt: now,
        updatedAt: now,
      },
    );
    await sessions.transact(sessionId, ({ session }) => ({
      result: undefined,
      session,
      prompts: [
        {
          requestId: "prompt-1",
          sessionId,
          content: "Continue after the human response.",
          mode: "enqueue",
          executionId,
          status: "running",
          createdAt: now,
          updatedAt: now,
        },
      ],
    }));
    await executions.appendEvent(
      executionId,
      executionId,
      "human.requested",
      { interactionId, request: scenario.storedRequest },
      `human-request:${interactionId}`,
    );

    const app = createPragma({
      pragmaHome: home,
      runtimes,
      executionStore: executions,
      expertSessionStore: sessions,
    });
    const resumed = await app.experts.resumeSession(expert, { sessionId });
    const turn = (await resumed.listTurns())[0]!;

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(runtimeStarts).toBe(0);

    await turn.respondToHumanInteraction(interactionId, scenario.response, {
      requestId: "response-after-restart",
    });

    const result = await turn.result;
    const events = await executions.readEvents(executionId);
    await resumed.close();

    expect(JSON.parse(String(result))).toEqual(scenario.response);
    expect(events.filter((event) => event.type === "human.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "human.responded")).toHaveLength(1);
    expect(runtimeStarts).toBe(1);
    expect((await resumed.getState()).lastStatus).toBe("succeeded");
  });
});

function createRecoveryRuntime(request: ExpertAgentHumanRequest, onStart: () => void) {
  interface RecoverySession {
    readonly context: RuntimeDriverSessionContext;
  }

  return defineRuntimeDriver<never, RecoverySession>({
    descriptor: {
      id: "human-recovery",
      kind: "fake",
      displayName: "Human recovery",
    },
    createSession: async (context) => ({ context }),
    readSession: () => ({ runtimeSessionId: "human-recovery-session" }),
    async startTurn(session, turn) {
      onStart();
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      const handler = session.context.request.humanInteractionHandler;
      if (handler === undefined) throw new Error("Human interaction handler is missing.");
      const response = await handler(request);
      turn.stream.write({
        runId: turn.runId,
        source: turn.source,
        type: "message.delta",
        payload: { role: "assistant", contentType: "text", delta: JSON.stringify(response) },
      });
      return {
        outputText: JSON.stringify(response),
        runtimeSessionId: "human-recovery-session",
      };
    },
    mapEvent: () => ({ events: [] }),
    cancelTurn: () => undefined,
    closeSession: () => undefined,
  });
}
