import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentLauncher,
  createPragma,
  createRuntimeRegistry,
  defineTask,
  ExpertAgent,
} from "../../src/index.ts";
import { createTestRuntimeAdapter } from "../runtime-test-utils.ts";
import type {
  Directive,
  RuntimeAdapter,
  RuntimeAgentSession,
  RuntimeDriverSessionRequest,
  RuntimeSessionInfo,
  RuntimeStreamEvent,
  RuntimeSubmitHandle,
  RuntimeSubmitRequest,
} from "../../src/index.ts";

describe("createAgentLauncher", () => {
  it("requires workflow execution context", async () => {
    const explorer = await createTestAgent("code-explorer");
    const launcher = createAgentLauncher({
      agents: [explorer],
    });

    const result = await launcher.tool.call(
      {
        agentId: "code-explorer",
        task: "Inspect the repository.",
      },
      undefined,
    );

    expect(result).toMatchObject({
      isError: true,
      details: {
        code: "missing_workflow_execution",
      },
    });
  });

  it("creates child workflow runs and starts fresh runtime sessions by default", async () => {
    const runtime = createRecordingRuntimeAdapter();
    const app = createPragma({
      storage: "memory",
      runtimes: createRuntimeRegistry({
        defaultRuntime: "fake",
        runtimes: [runtime.adapter],
      }),
    });
    const explorer = await createTestAgent("code-explorer");
    const launcher = createAgentLauncher({
      agents: [explorer],
    });
    const parent = createParentDirective(launcher.tool);

    const result = await app.run(parent, {
      input: {
        agentId: explorer.id,
        sessionPolicy: "fresh",
      },
    });
    const tree = await app.runs.getTree(result.workflowRunId);

    expect(runtime.createSessionRequests).toHaveLength(2);
    expect(runtime.createSessionRequests.map((request) => request.runtimeSession)).toEqual([
      undefined,
      undefined,
    ]);
    expect(tree?.children).toHaveLength(2);
    expect(tree?.children[0]?.workflow.parentWorkflowRunId).toBe(result.workflowRunId);
    expect(result.output.workflowRunIds).toHaveLength(2);
    expect(result.output.workflowRunIds[0]).not.toBe(result.output.workflowRunIds[1]);
  });

  it("continues the same child Workflow and Runtime Session for reuse_by_agent", async () => {
    const runtime = createRecordingRuntimeAdapter();
    const app = createPragma({
      storage: "memory",
      runtimes: createRuntimeRegistry({
        defaultRuntime: "fake",
        runtimes: [runtime.adapter],
      }),
    });
    const explorer = await createTestAgent("reusable-explorer");
    const launcher = createAgentLauncher({ agents: [explorer] });
    const parent = createParentDirective(launcher.tool);

    const result = await app.run(parent, {
      input: { agentId: explorer.id, sessionPolicy: "reuse_by_agent" },
    });
    const tree = await app.runs.getTree(result.workflowRunId);

    expect(tree?.children).toHaveLength(1);
    expect(tree?.children[0]?.tasks).toHaveLength(2);
    expect(result.output.workflowRunIds[0]).toBe(result.output.workflowRunIds[1]);
    expect(runtime.createSessionRequests).toHaveLength(2);
    expect(runtime.createSessionRequests[1]?.runtimeSession).toEqual(
      runtime.createSessionRequests[0]?.runtimeSession ?? {
        type: "fake-runtime",
        id: "runtime-session-1",
      },
    );
    expect(runtime.createSessionRequests[1]?.systemSessionId).toBe(
      runtime.createSessionRequests[0]?.systemSessionId,
    );
  });

  it("cancels delegated child workflow runs when the parent run is cancelled", async () => {
    const runtime = createPendingRuntimeAdapter();
    const app = createPragma({
      storage: "memory",
      runtimes: createRuntimeRegistry({
        defaultRuntime: "fake",
        runtimes: [runtime.adapter],
      }),
    });
    const explorer = await createTestAgent("code-explorer");
    const launcher = createAgentLauncher({
      agents: [explorer],
    });
    const parent = createSingleLaunchDirective(launcher.tool);

    const handle = await app.start(parent, {
      input: {
        agentId: explorer.id,
      },
    });

    await waitFor(async () => {
      const tree = await app.runs.getTree(handle.workflowRunId);
      return (tree?.children.length ?? 0) > 0;
    });

    await handle.cancel("stop delegated work");
    await expect(handle.result).rejects.toThrow("stop delegated work");

    const tree = await app.runs.getTree(handle.workflowRunId);

    expect(tree?.workflow.status).toBe("cancelled");
    expect(tree?.taskStatusCounts).toMatchObject({
      cancelled: 1,
    });
    expect(tree?.children).toHaveLength(1);
    expect(tree?.children[0]?.workflow.status).toBe("cancelled");
    expect(tree?.children[0]?.taskStatusCounts).toMatchObject({
      cancelled: 1,
    });
  });
});

async function createTestAgent(id: string): Promise<ExpertAgent> {
  return await ExpertAgent.create({
    pragmaHome: join(tmpdir(), `pragma-agent-launcher-${randomUUID()}`),
    id,
    name: id,
    description: "Test expert agent",
    tags: ["test"],
    version: "0.0.0",
    scope: "test",
    workspace: process.cwd(),
  });
}

function createParentDirective(tool: ReturnType<typeof createAgentLauncher>["tool"]): Directive<
  {
    readonly agentId: string;
    readonly sessionPolicy?: "fresh" | "reuse_by_agent" | undefined;
  },
  { readonly workflowRunIds: readonly string[] }
> {
  return defineTask({
    id: "parent-launcher",
    version: "1.0.0",
    async handler({ input, execution }) {
      const outputs = [];

      for (const task of ["first inspection", "second inspection"]) {
        const result = await tool.call(
          {
            agentId: input.agentId,
            task,
            sessionPolicy: input.sessionPolicy,
          },
          undefined,
          {
            workflowExecution: execution,
          },
        );

        if (result.isError) {
          throw new Error(result.text);
        }

        outputs.push(readWorkflowRunId(result.details));
      }

      return {
        workflowRunIds: outputs,
      };
    },
  });
}

function createSingleLaunchDirective(
  tool: ReturnType<typeof createAgentLauncher>["tool"],
): Directive<
  {
    readonly agentId: string;
  },
  { readonly workflowRunId: string }
> {
  return defineTask({
    id: "single-parent-launcher",
    version: "1.0.0",
    async handler({ input, execution }) {
      const result = await tool.call(
        {
          agentId: input.agentId,
          task: "inspect until cancelled",
        },
        undefined,
        {
          workflowExecution: execution,
        },
      );

      if (result.isError) {
        throw new Error(result.text);
      }

      return {
        workflowRunId: readWorkflowRunId(result.details),
      };
    },
  });
}

function createRecordingRuntimeAdapter(): {
  readonly adapter: RuntimeAdapter;
  readonly createSessionRequests: RuntimeDriverSessionRequest[];
} {
  let nextSessionId = 1;
  const createSessionRequests: RuntimeDriverSessionRequest[] = [];
  const adapter = createTestRuntimeAdapter({
    descriptor: {
      id: "fake",
      kind: "fake-runtime",
      displayName: "Fake Runtime",
      capabilities: {
        targets: ["agent"],
      },
    },
    async openSession(request) {
      createSessionRequests.push(request);
      const runtimeSession = request.runtimeSession ?? {
        type: "fake-runtime",
        id: `runtime-session-${nextSessionId++}`,
      };

      return createRecordingSession(request, runtimeSession);
    },
  });

  return {
    adapter,
    createSessionRequests,
  };
}

function createPendingRuntimeAdapter(): {
  readonly adapter: RuntimeAdapter;
} {
  const adapter = createTestRuntimeAdapter({
    descriptor: {
      id: "fake",
      kind: "fake-runtime",
      displayName: "Fake Runtime",
      capabilities: {
        targets: ["agent"],
      },
    },
    async openSession(request) {
      return createPendingSession(request);
    },
  });

  return {
    adapter,
  };
}

function createRecordingSession(
  request: RuntimeDriverSessionRequest,
  runtimeSession: RuntimeSessionInfo["runtimeSession"],
): RuntimeAgentSession {
  return {
    info: () => ({
      systemSessionId: request.systemSessionId ?? "system-session",
      runtimeSession,
      agentId: request.agent.id,
      runtime: {
        id: "fake",
        kind: "fake-runtime",
        displayName: "Fake Runtime",
      },
      sessionState: "active",
      runState: undefined,
    }),
    messages: () => [],
    submit<TSubmitOutput = string>(
      submission: RuntimeSubmitRequest<TSubmitOutput>,
    ): RuntimeSubmitHandle<TSubmitOutput> {
      return {
        runId: submission.runId ?? "run",
        events: emptyEvents(),
        result: Promise.resolve({
          runId: submission.runId ?? "run",
          result: {
            output: `handled:${submission.query}` as TSubmitOutput,
          },
        }),
        cancel: async () => undefined,
      };
    },
    abort: async () => undefined,
  };
}

function createPendingSession(request: RuntimeDriverSessionRequest): RuntimeAgentSession {
  const runtimeSession = request.runtimeSession ?? {
    type: "fake-runtime",
    id: "runtime-session-pending",
  };
  const pendingResult = new Promise<never>(() => undefined);

  return {
    info: () => ({
      systemSessionId: request.systemSessionId ?? "system-session",
      runtimeSession,
      agentId: request.agent.id,
      runtime: {
        id: "fake",
        kind: "fake-runtime",
        displayName: "Fake Runtime",
      },
      sessionState: "active",
      runState: undefined,
    }),
    messages: () => [],
    submit<TSubmitOutput = string>(
      submission: RuntimeSubmitRequest<TSubmitOutput>,
    ): RuntimeSubmitHandle<TSubmitOutput> {
      return {
        runId: submission.runId ?? "run",
        events: emptyEvents(),
        result: pendingResult,
        cancel: async () => undefined,
      };
    },
    abort: async () => undefined,
  };
}

function emptyEvents(): AsyncIterable<RuntimeStreamEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return {
            done: true,
            value: undefined as unknown as RuntimeStreamEvent,
          };
        },
      };
    },
  };
}

function readWorkflowRunId(details: unknown): string {
  if (
    typeof details === "object" &&
    details !== null &&
    "workflowRunId" in details &&
    typeof details.workflowRunId === "string"
  ) {
    return details.workflowRunId;
  }

  throw new Error("launch_agent result details did not include workflowRunId.");
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 1_000) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  throw new Error("Timed out waiting for condition.");
}
