import { mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defineExpert,
  ContextSystem,
  Expert,
  HOST_CONTEXT_NAMESPACE,
  createInMemoryContextStore,
  withExecutionRunScope,
  type RuntimeStreamEvent,
} from "@pragma/core";
import { MemorySystem, createMemoryPluginEntry, errorMemory } from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("memory plugin unified memory context", () => {
  it("registers memory context when the plugin is enabled", async () => {
    const workspace = await createWorkspaceDir();
    const memoryDir = await createMemoryDir();
    const agent = await createAgent({ workspace, memoryDir });

    await agent.addContext({
      namespace: "memory",
      id: "skills/plugin-design.md",
      content: "# Skill Card\n\n## Skill Scope\nPlugin design\n",
    });

    const summary = await agent.readContext({
      namespace: "memory",
      id: "summary.md",
    });

    const listed = await agent.listContext();
    const summaryFile = await stat(join(memoryDir, "memory-agent", "summary.md"));
    const skillFile = await stat(
      join(memoryDir, "memory-agent", "skill-memory", "skills", "plugin-design.md"),
    );

    expect(listed).toMatchObject({
      ok: true,
      value: {
        items: expect.arrayContaining([
          expect.objectContaining({
            namespace: "memory",
            id: "skills/plugin-design.md",
          }),
        ]),
      },
    });
    expect(summary).toEqual(expect.objectContaining({ ok: true }));
    expect(summaryFile.isFile()).toBe(true);
    expect(skillFile.isFile()).toBe(true);
  });

  it("can disable memory context through plugin config", async () => {
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
      value: {
        items: expect.not.arrayContaining([expect.objectContaining({ namespace: "memory" })]),
      },
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
      query: "Debug plugin memory design for repeated session executions.",
      output: "Established a stable plugin memory design for repeated session executions.",
    });
    await destroySessionHook(agent);

    const contextResult = await agent.readContext({
      namespace: "memory",
      id: "tasks/executions/execution-1/run-1.md",
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
          id: expect.stringContaining("plugin-memory-design"),
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

  it("assembles a navigation-oriented always-on memory guide", async () => {
    const workspace = await createWorkspaceDir();
    const memoryDir = await createMemoryDir();
    const memorySystem = new MemorySystem();
    const agent = await createAgent({
      workspace,
      memoryDir,
      memorySystem,
    });

    await memorySystem.appendTaskMemory({
      actorAgentId: agent.id,
      record: {
        type: "task",
        scope: "session",
        visibility: "shared",
        executionId: "wf-1",
        runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
        kind: "progress",
        content:
          "Implemented the unified summary assembler and still need to wire runtime refresh.",
        status: "active",
        title: "Memory summary refactor",
      },
    });
    await memorySystem.recordEvidence(
      {
        record: {
          id: "summary-session",
          type: "evidence",
          kind: "execution",
          agentId: agent.id,
          scope: "workspace",
          executionId: "summary-execution",
          payload: {
            executionId: "summary-execution",
            runtimeSessions: [{ type: "cloud-pi-agent", id: "runtime-session-1" }],
            runIds: ["run-1"],
            externalContext: false,
            runs: [
              {
                query: "Assemble memory summary",
                status: "succeeded",
                outputExcerpt:
                  "The user prefers compact always-on memory that includes current task progress. Recommended approach: rebuild the summary after every relevant memory mutation.",
                lessons: ["Prefer compact always-on memory."],
                tools: [
                  {
                    toolName: "read_context",
                    status: "completed",
                  },
                ],
              },
            ],
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          provenance: {
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            evidence: [{ type: "execution", id: "summary-execution" }],
          },
        },
      },
      { waitUntilProcessed: true },
    );
    await agent.addContext({
      namespace: "memory",
      id: "skills/summary-assembly.md",
      content: [
        "# Skill Card",
        "",
        "## Skill Scope",
        "memory summary assembly",
        "",
        "## Recommended Approach",
        "- Assemble always-on memory from typed summaries instead of raw documents.",
      ].join("\n"),
    });

    const summary = await agent.readContext({
      namespace: "memory",
      id: "summary.md",
    });
    expect(summary).toMatchObject({
      ok: true,
      value: {
        content: expect.stringContaining("Current Task State"),
      },
    });
    expect(summary.ok && summary.value.content).toContain("Active Constraints And Preferences");
    expect(summary.ok && summary.value.content).toContain("Skill Entry Points");
    expect(summary.ok && summary.value.content).toContain("Memory Search Guide");
    expect(summary.ok && summary.value.content).toContain("Searchable Domains");
    expect(summary.ok && summary.value.content).toContain("Memory summary refactor");
    expect(summary.ok && summary.value.content).toContain("user prefers compact always-on memory");
    expect(summary.ok && summary.value.content).toContain("Searchable Skill Domains");
    expect(summary.ok && summary.value.content).toContain("Recent Experience Entry Points");
  });

  it("refreshes the always-on summary only once for skill context writes", async () => {
    const workspace = await createWorkspaceDir();
    const memoryDir = await createMemoryDir();
    const memorySystem = new MemorySystem();
    const agent = await createAgent({
      workspace,
      memoryDir,
      memorySystem,
    });

    const summarySpy = vi.spyOn(memorySystem, "buildAlwaysOnSummary");

    const written = await memorySystem.buildAlwaysOnSummary({ agentId: "memory-test-agent" });
    summarySpy.mockClear();
    const contextWrite = await agent.addContext({
      namespace: "memory",
      id: "skills/single-refresh-skill.md",
      content: "# Skill Card\n\n## Skill Scope\nsingle refresh validation\n",
    });

    expect(written).toEqual(expect.objectContaining({ ok: true }));
    expect(contextWrite).toEqual(expect.objectContaining({ ok: true }));
    expect(summarySpy).toHaveBeenCalledTimes(1);
  });

  it("serves the last written summary when regeneration fails during reads", async () => {
    const workspace = await createWorkspaceDir();
    const memoryDir = await createMemoryDir();
    const memorySystem = new MemorySystem();
    const agent = await createAgent({
      workspace,
      memoryDir,
      memorySystem,
    });

    await memorySystem.appendTaskMemory({
      actorAgentId: agent.id,
      record: {
        type: "task",
        scope: "session",
        visibility: "shared",
        executionId: "wf-stale-summary",
        runtimeSession: { type: "cloud-pi-agent", id: "session-1" },
        kind: "progress",
        content: "Keep serving the previous summary when regeneration breaks.",
        status: "active",
        title: "Stale summary fallback",
      },
    });

    const beforeFailure = await agent.readContext({
      namespace: "memory",
      id: "summary.md",
    });
    expect(beforeFailure).toEqual(expect.objectContaining({ ok: true }));

    vi.spyOn(memorySystem, "buildAlwaysOnSummary").mockResolvedValueOnce(
      errorMemory("store_error", "summary rebuild failed"),
    );

    const afterFailure = await agent.readContext({
      namespace: "memory",
      id: "summary.md",
    });

    expect(afterFailure).toEqual(expect.objectContaining({ ok: true }));
    if (!beforeFailure.ok || !afterFailure.ok) {
      return;
    }

    expect(afterFailure.value.content).toBe(beforeFailure.value.content);
    expect(afterFailure.value.content).toContain("Stale summary fallback");
  });

  it("keeps skill context writes successful when summary regeneration fails", async () => {
    const workspace = await createWorkspaceDir();
    const memoryDir = await createMemoryDir();
    const memorySystem = new MemorySystem();
    const agent = await createAgent({
      workspace,
      memoryDir,
      memorySystem,
    });

    vi.spyOn(memorySystem, "buildAlwaysOnSummary").mockResolvedValueOnce(
      errorMemory("store_error", "summary rebuild failed"),
    );

    const added = await agent.addContext({
      namespace: "memory",
      id: "skills/summary-retry.md",
      content: "# Skill Card\n\n## Skill Scope\nSummary retry\n",
    });

    expect(added).toEqual(expect.objectContaining({ ok: true }));

    const written = await agent.readContext({
      namespace: "memory",
      id: "skills/summary-retry.md",
    });
    expect(written).toEqual(expect.objectContaining({ ok: true }));
  });

  it("reads host config from memory-config.json", async () => {
    const workspace = await createWorkspaceDir();
    const memoryDir = await createMemoryDir();
    const contextSystem = new ContextSystem();
    contextSystem.register({
      namespace: HOST_CONTEXT_NAMESPACE,
      store: createInMemoryContextStore({
        context: [
          {
            id: "memory-config.json",
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
      value: {
        items: expect.not.arrayContaining([expect.objectContaining({ namespace: "memory" })]),
      },
    });
  });
});

async function createAgent(options: {
  readonly workspace: string;
  readonly memoryDir: string;
  readonly contextSystem?: ContextSystem | undefined;
  readonly memorySystem?: MemorySystem | undefined;
  readonly pluginConfig?:
    | {
        readonly experience?:
          | {
              readonly enabled?: boolean | undefined;
              readonly filePath?: string | undefined;
            }
          | undefined;
        readonly task?:
          | {
              readonly enabled?: boolean | undefined;
              readonly rootDir?: string | undefined;
              readonly filePath?: string | undefined;
            }
          | undefined;
        readonly fact?:
          | {
              readonly enabled?: boolean | undefined;
              readonly filePath?: string | undefined;
            }
          | undefined;
        readonly skill?:
          | {
              readonly enabled?: boolean | undefined;
              readonly useMemories?: boolean | undefined;
              readonly generateMemories?: boolean | undefined;
              readonly memoryRoot?: string | undefined;
            }
          | undefined;
      }
    | undefined;
}): Promise<Expert> {
  return await defineExpert({
    schemaVersion: "pragma.expert/v1",
    id: "memory-agent",
    name: "Memory Agent",
    description: "Test agent",
    tags: ["test"],
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
        userConfig: {
          task: {
            rootDir: options.memoryDir,
            ...(options.pluginConfig?.task ?? {}),
          },
          experience: {
            filePath: join(options.memoryDir, "memory-agent", "experience-memory", "records.json"),
            ...(options.pluginConfig?.experience ?? {}),
          },
          fact: {
            filePath: join(options.memoryDir, "memory-agent", "fact-memory", "records.json"),
            ...(options.pluginConfig?.fact ?? {}),
          },
          skill: {
            memoryRoot: options.memoryDir,
            ...(options.pluginConfig?.skill ?? {}),
          },
        },
      },
    ],
    ...(options.contextSystem === undefined ? {} : { contextSystem: options.contextSystem }),
  });
}

async function emitStreamEvent(
  agent: Expert,
  options: {
    readonly runId: string;
    readonly event: RuntimeStreamEvent;
    readonly executionId?: string | undefined;
  },
): Promise<void> {
  await agent.hooks?.onStreamEvent?.({
    agent,
    session: createSessionInfo({}),
    runId: options.runId,
    event: options.event,
    context: withExecutionRunScope(
      {
        source: { type: "test" },
        attributes: {},
      },
      { executionId: options.executionId ?? "execution-1" },
    ),
  });
}

async function submitTaskHook(
  agent: Expert,
  options: {
    readonly runId: string;
    readonly executionId?: string | undefined;
    readonly systemSessionId?: string | undefined;
    readonly runtimeSessionId?: string | undefined;
    readonly query?: string | undefined;
    readonly output?: string | undefined;
  },
): Promise<void> {
  await agent.hooks?.afterTaskSubmit?.({
    agent,
    session: createSessionInfo({
      systemSessionId: options.systemSessionId,
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
    context: withExecutionRunScope(
      {
        source: { type: "test" },
        attributes: {},
      },
      { executionId: options.executionId ?? "execution-1" },
    ),
  });
}

async function destroySessionHook(
  agent: Expert,
  options: {
    readonly systemSessionId?: string | undefined;
    readonly runtimeSessionId?: string | undefined;
  } = {},
): Promise<void> {
  await agent.hooks?.afterSessionDestroy?.({
    agent,
    session: createSessionInfo({
      systemSessionId: options.systemSessionId,
      runtimeSessionId: options.runtimeSessionId,
      runState: "succeeded",
    }),
  });
}

function createSessionInfo(options: {
  readonly systemSessionId?: string | undefined;
  readonly runtimeSessionId?: string | undefined;
  readonly runState?: "succeeded" | "failed" | "cancelled" | undefined;
}) {
  return {
    systemSessionId: options.systemSessionId ?? "system-session-1",
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
