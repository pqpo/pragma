import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFileExecutionStore,
  createFileExpertSessionStore,
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
  defineRuntimeDriver,
  PragmaPaths,
  registerExpertToolsMcpSession,
  type ExpertToolsMcpSessionRegistration,
  type RuntimeDriverSessionContext,
} from "../src/index.ts";
import { createRuntimeTestFeatures } from "../src/testing/index.ts";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map(async (home) => {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }),
  );
});

describe("Human interaction checkpoint across the HTTP MCP boundary", { timeout: 30_000 }, () => {
  it("stops the active Runtime after non-TTY checkpoint and resumes the same interaction", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-http-human-checkpoint-"));
    homes.push(home);
    const executionStore = createFileExecutionStore({ pragmaHome: home });
    const sessionStore = createFileExpertSessionStore({
      executions: executionStore,
      pragmaHome: home,
    });
    const state = {
      starts: 0,
      cancelCalls: 0,
      initialTurnReturnedWithoutCancellation: false,
      checkpointReachedRuntimeBeforeCancellation: false,
    };
    const runtime = createHttpMcpRuntime(state);
    const runtimes = createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: "http-mcp-checkpoint",
    });
    const app = createPragma({
      pragmaHome: home,
      runtimes,
      executionStore,
      expertSessionStore: sessionStore,
    });
    const expert = await defineExpert({
      id: "http-mcp-checkpoint-expert",
      name: "HTTP MCP checkpoint expert",
      description: "Exercises the real HTTP MCP checkpoint boundary.",
      tags: [],
      scope: "test",
      workspace: home,
      pragmaHome: home,
    });
    const sessionId = "http-mcp-checkpoint-session";
    const session = await app.experts.createSession(expert, { sessionId });
    const turn = await session.prompt("Ask the user to continue.", {
      requestId: "http-mcp-checkpoint-request",
    });

    await waitForExecutionEvent(executionStore, turn.executionId, "human.waiting");
    const requested = await readHumanRequest(executionStore, turn.executionId);
    await turn.checkpointWaitingHuman();

    const waitingEvents = await executionStore.readEvents(turn.executionId);
    expect(waitingEvents.map((event) => event.type)).toContain("human.waiting");
    expect(waitingEvents.map((event) => event.type)).not.toContain("invocation.succeeded");
    expect(waitingEvents.map((event) => event.type)).not.toContain("execution.succeeded");
    await expect(executionStore.get(turn.executionId)).resolves.toMatchObject({
      status: "waiting",
    });
    await expect(
      access(new PragmaPaths({ pragmaHome: home }).expertSessionLease(sessionId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(state.cancelCalls).toBe(1);
    expect(state.initialTurnReturnedWithoutCancellation).toBe(false);
    expect(state.checkpointReachedRuntimeBeforeCancellation).toBe(false);

    const resumed = await app.experts.resumeSession(expert, { sessionId });
    const resumedTurn = (await resumed.listTurns()).find(
      (candidate) => candidate.executionId === turn.executionId,
    );
    if (resumedTurn === undefined) throw new Error("Checkpointed turn was not recoverable.");
    await resumedTurn.respondToHumanInteraction(
      requested.interactionId,
      {
        kind: "user_question",
        answered: true,
        answers: { Continue: "yes" },
      },
      { requestId: "http-mcp-checkpoint-response" },
    );

    await expect(resumedTurn.result).resolves.toBeDefined();
    const completedEvents = await executionStore.readEvents(turn.executionId);
    expect(completedEvents.map((event) => event.type)).toContain("human.resumed");
    expect(completedEvents.map((event) => event.type)).toContain("invocation.succeeded");
    expect(completedEvents.map((event) => event.type)).toContain("execution.succeeded");
    expect(state.starts).toBe(2);
    await resumed.releaseAfterTerminal();
  });
});

interface HttpMcpRuntimeSession {
  readonly context: RuntimeDriverSessionContext;
  readonly registration: ExpertToolsMcpSessionRegistration;
}

function createHttpMcpRuntime(state: {
  starts: number;
  cancelCalls: number;
  initialTurnReturnedWithoutCancellation: boolean;
  checkpointReachedRuntimeBeforeCancellation: boolean;
}) {
  return defineRuntimeDriver<never, HttpMcpRuntimeSession>({
    features: createRuntimeTestFeatures({ enabled: ["cancellation", "close"] }),
    descriptor: {
      id: "http-mcp-checkpoint",
      kind: "fake",
      displayName: "HTTP MCP checkpoint runtime",
    },
    createSession: async (context) => ({
      context,
      registration: await registerExpertToolsMcpSession({
        agent: context.agent,
        getContext: () => context.lifecycle.currentContext,
        humanInteractionHandler: context.request.humanInteractionHandler,
        logger: context.logger,
        state: {},
        executionContext: context.request.executionContext,
      }),
    }),
    readSession: (session) => ({ runtimeSessionId: session.registration.id }),
    async startTurn(session, turn) {
      state.starts += 1;
      const client = new Client(
        { name: "http-mcp-checkpoint-runtime", version: "1.0.0" },
        { capabilities: {} },
      );
      await client.connect(new StreamableHTTPClientTransport(new URL(session.registration.url)));
      try {
        const tools = await client.listTools();
        if (!tools.tools.some((tool) => tool.name === "askUserQuestion")) {
          throw new Error("The HTTP MCP gateway did not expose askUserQuestion.");
        }
        const result = await client
          .callTool({
            name: "askUserQuestion",
            arguments: {
              questions: [
                {
                  question: "Continue",
                  header: "Decision",
                  kind: "text",
                  options: [],
                },
              ],
            },
          })
          .catch((error: unknown) => {
            if (state.cancelCalls === 0) {
              state.checkpointReachedRuntimeBeforeCancellation = true;
            }
            throw error;
          });
        if (state.starts === 1 && !turn.signal.aborted) {
          state.initialTurnReturnedWithoutCancellation = true;
        }
        return {
          outputText: JSON.stringify(result),
          runtimeSessionId: session.registration.id,
        };
      } finally {
        await client.close();
      }
    },
    mapEvent: () => ({ events: [] }),
    cancelTurn: () => {
      state.cancelCalls += 1;
    },
    closeSession: async (session) => await session.registration.dispose(),
  });
}

async function readHumanRequest(
  store: ReturnType<typeof createFileExecutionStore>,
  executionId: string,
): Promise<{ readonly interactionId: string }> {
  const event = (await store.readEvents(executionId)).find(
    (candidate) => candidate.type === "human.requested",
  );
  const data = event?.data;
  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as Record<string, unknown>)["interactionId"] !== "string"
  ) {
    throw new Error("Human interaction request was not persisted.");
  }
  return { interactionId: (data as Record<string, string>)["interactionId"]! };
}

async function waitForExecutionEvent(
  store: ReturnType<typeof createFileExecutionStore>,
  executionId: string,
  type: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await store.readEvents(executionId)).some((event) => event.type === type)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${type}.`);
}
