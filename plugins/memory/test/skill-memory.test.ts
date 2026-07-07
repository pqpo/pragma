import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  ContextSystem,
  ExpertAgent,
  HOST_CONTEXT_NAMESPACE,
  createInMemoryContextStore,
  type RuntimeStreamEvent,
} from "@pragma/core";
import { MemorySystem, createMemoryPluginEntry } from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("memory plugin skill-memory", () => {
  it("registers skill-memory context when the plugin is enabled", async () => {
    const workspace = await createWorkspaceDir();
    const memoryDir = await createMemoryDir();
    const agent = await createAgent({ workspace, memoryDir });

    await agent.addContext({
      namespace: "skill-memory",
      id: "skills/plugin-design.md",
      content: "# Skill Card\n\n## Skill Scope\nPlugin design\n",
    });

    const listed = await agent.listContext();
    expect(listed).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({
          namespace: "skill-memory",
          id: "summary.md",
        }),
        expect.objectContaining({
          namespace: "skill-memory",
          id: "skills/plugin-design.md",
        }),
      ]),
    });
  });

  it("can disable skill-memory through plugin config", async () => {
    const workspace = await createWorkspaceDir();
    const memoryDir = await createMemoryDir();
    const memorySystem = new MemorySystem();
    const agent = await createAgent({
      workspace,
      memoryDir,
      memorySystem,
      pluginConfig: {
        skill: {
          enabled: false,
        },
      },
    });

    const listed = await agent.listContext();
    expect(listed).toMatchObject({
      ok: true,
      value: expect.not.arrayContaining([
        expect.objectContaining({ namespace: "skill-memory" }),
      ]),
    });

    const retrieved = await memorySystem.retrieveForRuntime({
      request: {
        agentId: agent.id,
        query: "plugin design",
      },
    });
    expect(retrieved).toMatchObject({
      ok: true,
      value: {
        skills: [],
      },
    });
  });

  it("writes summaries and registers derived skills into typed skill memory", async () => {
    const workspace = await createWorkspaceDir();
    const memoryDir = await createMemoryDir();
    const memorySystem = new MemorySystem();
    const agent = await createAgent({
      workspace,
      memoryDir,
      memorySystem,
    });

    await emitStreamEvent(agent, {
      runId: "run-1",
      event: {
        schemaVersion: "pragma.stream/v1",
        eventId: "event-1",
        sequence: 0,
        emittedAt: new Date().toISOString(),
        runId: "run-1",
        source: { kind: "agent", runId: "run-1", path: [] },
        type: "tool.failed",
        payload: {
          toolCallId: "tool-1",
          toolName: "read_context",
          kind: "tool",
          message: "wrong file path",
        },
      },
    });
    await submitTaskHook(agent, {
      runId: "run-1",
      query: "Debug plugin memory design for repeated session workflows.",
      output: "Established a stable plugin memory design for repeated session workflows.",
    });
    await destroySessionHook(agent);

    const contextResult = await agent.readContext({
      namespace: "skill-memory",
      id: "tasks/session-1/run-1.md",
    });
    expect(contextResult).toMatchObject({
      ok: true,
      value: {
        content: expect.stringContaining("Recommended Fix Next Time"),
      },
    });

    const skills = await memorySystem.listSkills({});
    expect(skills).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({
          type: "skill",
          problemClass: expect.stringContaining("plugin memory design"),
        }),
      ]),
    });

    const runtime = await memorySystem.retrieveForRuntime({
      request: {
        agentId: agent.id,
        query: "plugin memory design",
      },
    });
    expect(runtime).toMatchObject({
      ok: true,
      value: {
        skills: expect.arrayContaining([
          expect.objectContaining({
            type: "skill",
          }),
        ]),
      },
    });
  });

  it("reads host config from skill-memory-config.json", async () => {
    const workspace = await createWorkspaceDir();
    const memoryDir = await createMemoryDir();
    const contextSystem = new ContextSystem();
    contextSystem.register({
      namespace: HOST_CONTEXT_NAMESPACE,
      store: createInMemoryContextStore({
        context: [
          {
            id: "skill-memory-config.json",
            content: JSON.stringify({ enabled: false }),
            metadata: { trigger: "manual" },
          },
        ],
      }),
    });
    const agent = await createAgent({
      workspace,
      memoryDir,
      contextSystem,
    });

    const listed = await agent.listContext();
    expect(listed).toMatchObject({
      ok: true,
      value: expect.not.arrayContaining([
        expect.objectContaining({ namespace: "skill-memory" }),
      ]),
    });
  });
});

async function createAgent(options: {
  readonly workspace: string;
  readonly memoryDir: string;
  readonly contextSystem?: ContextSystem | undefined;
  readonly memorySystem?: MemorySystem | undefined;
  readonly pluginConfig?: {
    readonly experience?: {
      readonly enabled?: boolean | undefined;
      readonly filePath?: string | undefined;
    } | undefined;
    readonly fact?: {
      readonly enabled?: boolean | undefined;
      readonly filePath?: string | undefined;
    } | undefined;
    readonly skill?: {
      readonly enabled?: boolean | undefined;
      readonly useMemories?: boolean | undefined;
      readonly generateMemories?: boolean | undefined;
      readonly memoryRoot?: string | undefined;
    } | undefined;
  } | undefined;
}): Promise<ExpertAgent> {
  return await ExpertAgent.create({
    schemaVersion: "pragma.expert/v1",
    id: "memory-agent",
    name: "Memory Agent",
    description: "Test agent",
    tags: ["test"],
    version: "0.0.0",
    scope: "test",
    workspace: options.workspace,
    plugins: [
      {
        entry: createMemoryPluginEntry(
          options.memorySystem === undefined
            ? {}
            : {
                memorySystem: options.memorySystem,
              },
        ),
        config: {
          experience: {
            filePath: join(options.memoryDir, "experience.json"),
            ...(options.pluginConfig?.experience ?? {}),
          },
          fact: {
            filePath: join(options.memoryDir, "fact.json"),
            ...(options.pluginConfig?.fact ?? {}),
          },
          skill: {
            memoryRoot: join(options.memoryDir, "skill-memory"),
            ...(options.pluginConfig?.skill ?? {}),
          },
        },
      },
    ],
    ...(options.contextSystem === undefined ? {} : { contextSystem: options.contextSystem }),
  });
}

async function emitStreamEvent(
  agent: ExpertAgent,
  options: {
    readonly runId: string;
    readonly event: RuntimeStreamEvent;
  },
): Promise<void> {
  await agent.hooks?.onStreamEvent?.({
    agent,
    session: createSessionInfo({}),
    runId: options.runId,
    event: options.event,
    context: {
      source: { type: "test" },
      attributes: {},
    },
  });
}

async function submitTaskHook(
  agent: ExpertAgent,
  options: {
    readonly runId: string;
    readonly sessionId?: string | undefined;
    readonly runtimeSessionId?: string | undefined;
    readonly query?: string | undefined;
    readonly output?: string | undefined;
  },
): Promise<void> {
  await agent.hooks?.afterTaskSubmit?.({
    agent,
    session: createSessionInfo({
      sessionId: options.sessionId,
      runtimeSessionId: options.runtimeSessionId,
      runState: "succeeded",
    }),
    runId: options.runId,
    submission: {
      query: options.query ?? "Remember the preferred memory design.",
    },
    ...(options.output === undefined
      ? {}
      : {
          result: {
            runId: options.runId,
            result: {
              output: options.output,
            },
          },
        }),
    context: {
      source: { type: "test" },
      attributes: {},
    },
  });
}

async function destroySessionHook(
  agent: ExpertAgent,
  options: {
    readonly sessionId?: string | undefined;
    readonly runtimeSessionId?: string | undefined;
  } = {},
): Promise<void> {
  await agent.hooks?.afterSessionDestroy?.({
    agent,
    session: createSessionInfo({
      sessionId: options.sessionId,
      runtimeSessionId: options.runtimeSessionId,
      runState: "succeeded",
    }),
  });
}

function createSessionInfo(options: {
  readonly sessionId?: string | undefined;
  readonly runtimeSessionId?: string | undefined;
  readonly runState?: "succeeded" | "failed" | "cancelled" | undefined;
}) {
  return {
    systemSessionId: options.sessionId ?? "session-1",
    runtimeSession: {
      type: "test-runtime",
      id: options.runtimeSessionId ?? "runtime-session-1",
    },
    agentId: "memory-agent",
    runtime: {
      id: "test-runtime",
      kind: "test-runtime",
      displayName: "Test Runtime",
    },
    sessionState: "active" as const,
    runState: options.runState,
  };
}

async function createWorkspaceDir(): Promise<string> {
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const dir = await mkdtemp(resolve(packageRoot, ".pragma-skill-memory-workspace-"));
  tempDirs.push(dir);
  return dir;
}

async function createMemoryDir(): Promise<string> {
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const dir = await mkdtemp(resolve(packageRoot, ".pragma-memory-home-"));
  tempDirs.push(dir);
  return dir;
}
