import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  RuntimeAdapter,
  RuntimeAgentSession,
  RuntimeCreateSessionRequest,
  RuntimeSessionInfo,
  RuntimeSubmitHandle,
} from "@pragma/core";
import { ContextSystem, ExpertAgent } from "@pragma/core";
import { createRuntimeRegistry } from "@pragma/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineAgent } from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
      workspace: "/tmp/pragma-loop-test",
      contextSystem,
    });

    expect(agent).toBeInstanceOf(ExpertAgent);
    expect(agent.contextSystem).toBe(contextSystem);

    const context = await agent.buildContext();

    expect(context.systemPrompt).toContain("You are Coder.");
    expect(context.systemPrompt).toContain("Prefer small, verified changes.");
  });

  it("creates sessions through the selected runtime registry", async () => {
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
      workspace: "/tmp/pragma-loop-test",
    });

    const session = await agent.createSession({
      runtime: "test-runtime",
      runtimes: createRuntimeRegistry({
        runtimes: [runtime],
        defaultRuntime: "test-runtime",
      }),
      systemSessionId: "system-session-from-agent",
      runtimeSession: {
        type: "fake-runtime",
        id: "runtime-session-from-agent",
      },
    });
    const handle = session.submit({
      query: "Implement login",
      output: z.object({
        summary: z.string(),
        changedFiles: z.array(z.string()),
        testsPassed: z.boolean(),
      }),
    });
    const result = await handle.result;

    expect(handle.runId).toBe("run-1");
    expect(runtime.requests).toEqual([
      expect.objectContaining({
        agent,
        systemSessionId: "system-session-from-agent",
        runtimeSession: {
          type: "fake-runtime",
          id: "runtime-session-from-agent",
        },
      }),
    ]);
    expect(result.result.output).toEqual({
      summary: "implemented",
      changedFiles: ["src/index.ts"],
      testsPassed: true,
    });
  });

  it("loads task memory tools and unified memory context by default", async () => {
    const agent = await defineAgent({
      id: `memory-defaults-${crypto.randomUUID()}`,
      name: "Memory Defaults",
      description: "Loads default memory categories.",
      tags: ["memory"],
      version: "0.0.0",
      scope: "workspace",
      workspace: await createTempWorkspace(),
    });

    expect(agent.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "append_task_memory",
        "patch_task_memory",
      ]),
    );

    const skillWrite = await agent.addContext({
      namespace: "memory",
      id: "skills/default-memory.md",
      content: "# Skill Card\n\nDefault memory wiring works.\n",
    });
    expect(skillWrite).toMatchObject({
      ok: true,
    });
  });

  it("can disable all memory categories during agent creation", async () => {
    const agent = await defineAgent({
      id: "memory-disabled",
      name: "Memory Disabled",
      description: "Disables all default memory categories.",
      tags: ["memory"],
      version: "0.0.0",
      scope: "workspace",
      workspace: await createTempWorkspace(),
      memory: false,
    });

    expect(agent.tools?.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([
        "append_task_memory",
        "patch_task_memory",
      ]),
    );

    const skillWrite = await agent.addContext({
      namespace: "memory",
      id: "skills/disabled-memory.md",
      content: "# Skill Card\n\nThis should fail when memory is disabled.\n",
    });
    expect(skillWrite.ok).toBe(false);
  });

  it("can disable selected memory categories while keeping the others enabled", async () => {
    const agent = await defineAgent({
      id: `memory-selective-${crypto.randomUUID()}`,
      name: "Memory Selective",
      description: "Disables selected default memory categories.",
      tags: ["memory"],
      version: "0.0.0",
      scope: "workspace",
      workspace: await createTempWorkspace(),
      memory: {
        experience: false,
        fact: false,
      },
    });

    const toolNames = agent.tools?.map((tool) => tool.name) ?? [];

    expect(toolNames).toEqual(
      expect.arrayContaining(["append_task_memory", "patch_task_memory"]),
    );
    expect(toolNames).not.toEqual(
      expect.arrayContaining(["append_experience_memory", "write_fact_memory"]),
    );

    const skillWrite = await agent.addContext({
      namespace: "memory",
      id: "skills/selective-memory.md",
      content: "# Skill Card\n\nSkill memory should still be available.\n",
    });
    expect(skillWrite).toMatchObject({
      ok: true,
    });
  });
});

async function createTempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pragma-core-memory-"));
  tempDirs.push(dir);
  return dir;
}

function createFakeRuntime(options: {
  readonly id: string;
  readonly output: unknown;
}): RuntimeAdapter & { readonly requests: RuntimeCreateSessionRequest[] } {
  const requests: RuntimeCreateSessionRequest[] = [];

  return {
    requests,
    descriptor: {
      id: options.id,
      kind: "fake-runtime",
      displayName: "Fake Runtime",
      capabilities: {
        targets: ["agent"],
      },
    },
    async createSession(request) {
      requests.push(request);
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
