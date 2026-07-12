import type {
  RuntimeAdapter,
  RuntimeAgentSession,
  RuntimeDriverSessionRequest,
  RuntimeSessionInfo,
  RuntimeSubmitHandle,
} from "@pragma/core";
import { ContextSystem, ExpertAgent, createPragma } from "@pragma/core";
import { createRuntimeRegistry } from "@pragma/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineAgent } from "../src/index.ts";
import { createTestRuntimeAdapter } from "./runtime-test-utils.ts";

describe("defineAgent", () => {
  it("normalizes instructions into the ExpertAgent system prompt", async () => {
    const contextSystem = new ContextSystem();
    const agent = await defineAgent({
      id: "coder",
      name: "Coder",
      description: "Responsible for code changes.",
      instructions: "Prefer small, verified changes.",
      tags: ["coding"],
      version: "0.0.0",
      scope: "workspace",
      workspace: "/tmp/pragma-directive-test",
      contextSystem,
    });

    expect(agent).toBeInstanceOf(ExpertAgent);
    expect(agent.contextSystem).toBe(contextSystem);

    const context = await agent.buildContext();

    expect(context.systemPrompt).toContain("You are Coder.");
    expect(context.systemPrompt).toContain("Prefer small, verified changes.");
  });

  it("runs through Pragma without exposing direct Session creation", async () => {
    const runtime = createFakeRuntime({
      id: "test-runtime",
      output: {
        summary: "implemented",
        changedFiles: ["src/index.ts"],
        testsPassed: true,
      },
    });
    const agent = await defineAgent({
      id: "coder",
      name: "Coder",
      description: "Responsible for code changes.",
      tags: ["coding"],
      version: "0.0.0",
      scope: "workspace",
      workspace: "/tmp/pragma-directive-test",
    });

    expect("createSession" in agent).toBe(false);
    const result = await createPragma({
      storage: "memory",
      runtimes: createRuntimeRegistry({
        runtimes: [runtime],
        defaultRuntime: "test-runtime",
      }),
    }).run(agent, {
      input: { prompt: "Implement login" },
      output: z.object({
        summary: z.string(),
        changedFiles: z.array(z.string()),
        testsPassed: z.boolean(),
      }),
    });
    expect(runtime.requests).toEqual([
      expect.objectContaining({
        agent,
        workflowExecution: expect.any(Object),
      }),
    ]);
    expect(result.output).toEqual({
      summary: "implemented",
      changedFiles: ["src/index.ts"],
      testsPassed: true,
    });
  });

  it("does not load memory tools or context unless the memory plugin is explicitly registered", async () => {
    const agent = await defineAgent({
      id: "memory-not-implicit",
      name: "Memory Not Implicit",
      description: "Does not load memory by default.",
      tags: ["memory"],
      version: "0.0.0",
      scope: "workspace",
      workspace: "/tmp/pragma-directive-test",
    });

    expect(agent.tools?.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["append_task_memory", "patch_task_memory"]),
    );

    const skillWrite = await agent.addContext({
      namespace: "memory",
      id: "skills/implicit-memory.md",
      content: "# Skill Card\n\nThis should fail when memory is not explicitly registered.\n",
    });
    expect(skillWrite.ok).toBe(false);
  });
});

function createFakeRuntime(options: {
  readonly id: string;
  readonly output: unknown;
}): RuntimeAdapter & { readonly requests: RuntimeDriverSessionRequest[] } {
  const requests: RuntimeDriverSessionRequest[] = [];

  const runtime = createTestRuntimeAdapter({
    descriptor: {
      id: options.id,
      kind: "fake-runtime",
      displayName: "Fake Runtime",
      capabilities: {
        targets: ["agent"],
      },
    },
    async openSession(request) {
      requests.push(request);
      return createFakeSession(options.output);
    },
  });

  return Object.assign(runtime, { requests });
}

function createFakeSession(output: unknown): RuntimeAgentSession {
  return {
    info: () => createFakeSessionInfo(),
    messages: () => [],
    submit<TSubmitOutput>(): RuntimeSubmitHandle<TSubmitOutput> {
      return {
        runId: "run-1",
        events: createEmptyEvents(),
        result: Promise.resolve({
          runId: "run-1",
          result: {
            output: output as TSubmitOutput,
          },
        }),
        cancel: async () => undefined,
      };
    },
    abort: async () => undefined,
  };
}

function createFakeSessionInfo(): RuntimeSessionInfo {
  return {
    systemSessionId: "system-session-1",
    runtimeSession: {
      type: "fake-runtime",
      id: "runtime-session-1",
    },
    agentId: "coder",
    runtime: {
      id: "test-runtime",
      kind: "fake-runtime",
      displayName: "Fake Runtime",
    },
    sessionState: "active",
    runState: undefined,
  };
}

function createEmptyEvents() {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ value: undefined, done: true }) as const,
      };
    },
  };
}
