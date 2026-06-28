import type {
  RuntimeAdapter,
  RuntimeAgentSession,
  RuntimeSessionInfo,
  RuntimeSubmitHandle,
} from "@expertmesh/agent-core";
import { ContextSystem, ExpertAgent } from "@expertmesh/agent-core";
import { createRuntimeRegistry } from "@expertmesh/agent-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineAgent } from "../src/index.ts";

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
      workspace: "/tmp/expertmesh-loop-test",
      contextSystem,
    });

    expect(agent).toBeInstanceOf(ExpertAgent);
    expect(agent.contextSystem).toBe(contextSystem);

    const context = await agent.buildContext();

    expect(context.systemPrompt).toContain("You are Coder.");
    expect(context.systemPrompt).toContain("Prefer small, verified changes.");
  });

  it("runs through the selected runtime registry", async () => {
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
      workspace: "/tmp/expertmesh-loop-test",
    });

    const result = await agent.run("Implement login", {
      runtime: "test-runtime",
      runtimes: createRuntimeRegistry({
        runtimes: [runtime],
        defaultRuntime: "test-runtime",
      }),
      output: z.object({
        summary: z.string(),
        changedFiles: z.array(z.string()),
        testsPassed: z.boolean(),
      }),
    });

    expect(result.output).toEqual({
      summary: "implemented",
      changedFiles: ["src/index.ts"],
      testsPassed: true,
    });
  });
});

function createFakeRuntime(options: {
  readonly id: string;
  readonly output: unknown;
}): RuntimeAdapter {
  return {
    descriptor: {
      id: options.id,
      kind: "fake-runtime",
      displayName: "Fake Runtime",
      capabilities: {
        targets: ["agent"],
      },
    },
    async createSession() {
      return createFakeSession(options.output);
    },
  };
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
