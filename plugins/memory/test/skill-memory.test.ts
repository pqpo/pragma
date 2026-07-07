import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ContextSystem,
  ExpertAgent,
  HOST_CONTEXT_NAMESPACE,
  createInMemoryContextStore,
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
    expect(listed).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({
          namespace: "memory",
          id: "skills/plugin-design.md",
        }),
      ]),
    });
    expect(summary).toEqual(expect.objectContaining({ ok: true }));
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
      value: expect.not.arrayContaining([
        expect.objectContaining({ namespace: "memory" }),
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
      namespace: "memory",
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
        workflowRunId: "wf-1",
        kind: "progress",
        content: "Implemented the unified summary assembler and still need to wire runtime refresh.",
        status: "active",
        title: "Memory summary refactor",
      },
    });
    await memorySystem.recordEvidence(
      {
        record: {
          id: "summary-session",
          type: "evidence",
          kind: "session",
          agentId: agent.id,
          scope: "workspace",
          payload: {
            sessionId: "summary-session",
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
            evidence: [{ type: "session", id: "summary-session" }],
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
        workflowRunId: "wf-stale-summary",
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
      value: expect.not.arrayContaining([
        expect.objectContaining({ namespace: "memory" }),
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
            memoryRoot: join(options.memoryDir, "memory"),
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
