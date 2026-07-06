import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  ContextSystem,
  ExpertAgent,
  HOST_CONTEXT_NAMESPACE,
  createInMemoryContextStore,
  readExpertAgentPluginManifest,
} from "@pragma/core";
import type {
  ExpertAgentPluginSetupContext,
  ExpertAgentPluginUse,
  RuntimeStreamEvent,
} from "@pragma/core";

import expertMemoryPlugin, { parseMemoryPluginConfig } from "../src/index.ts";
import { ExpertMemoryManager } from "../src/manager.ts";

interface SerializedMutationHarness {
  withSerializedMutation<T>(
    lockMap: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T>;
}

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Expert Memory plugin", () => {
  it("reads plugin metadata from plugin.json at runtime", () => {
    const manifest = readExpertAgentPluginManifest(new URL("../plugin.json", import.meta.url));

    expect(expertMemoryPlugin).toMatchObject({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      tags: manifest.tags,
    });
    expect(manifest.configuration.properties.map((property) => property.name)).toEqual([
      "enabled",
      "useMemories",
      "generateMemories",
      "disableOnExternalContext",
      "minRunOutputChars",
      "summaryMaxBytes",
      "maxOutputExcerptChars",
      "maxToolExcerptChars",
      "taskSummaryModel",
      "sessionSummaryModel",
      "skillMergeModel",
      "summaryModel",
      "memoryRoot",
    ]);
    expect(expertMemoryPlugin.manifest).toEqual(manifest);
  });

  it("registers expert-memory by default and exposes skills as model-decision context", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });

    await expect(
      agent.addContext({
        namespace: "expert-memory",
        id: "skills/plugin-design.md",
        content: "# Skill Card\n\n## Skill Scope\n\nPlugin design\n",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        metadata: expect.objectContaining({ trigger: "model_decision" }),
      },
    });

    await expect(agent.listContext()).resolves.toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({
          namespace: "expert-memory",
          id: "summary.md",
          metadata: expect.objectContaining({ trigger: "always_on" }),
        }),
        expect.objectContaining({
          namespace: "expert-memory",
          id: "skills/plugin-design.md",
          metadata: expect.objectContaining({ trigger: "model_decision" }),
        }),
      ]),
    });
  });

  it("injects summary.md as always-on without injecting full skill content", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });
    await agent.addContext({
      namespace: "expert-memory",
      id: "skills/plugin-design.md",
      content: [
        "# Skill Card",
        "",
        "## Skill Scope",
        "Plugin design",
        "",
        "## Common Failure Modes",
        "- Do not create apps/local-runner.",
        "",
      ].join("\n"),
    });

    const context = await agent.buildContext();

    expect(context.systemPrompt).toContain("id: skills/plugin-design.md");
    expect(context.systemPrompt).not.toContain("Do not create apps/local-runner.");
    expect(context.startupMessages[0]?.content).toContain("Memory Index");
    expect(context.startupMessages[0]?.content).toContain("skills/plugin-design.md");
  });

  it("rejects direct writes to generated summary.md", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });

    await expect(
      agent.addContext({
        namespace: "expert-memory",
        id: "summary.md",
        content: "manual summary",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.objectContaining({ code: "permission_denied" }),
    });
  });

  it("rejects memory roots outside the workspace", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({
      workspace,
      contextSystem: createContextSystemWithMemoryConfig({
        memoryRoot: "../outside-workspace-memory",
      }),
      plugins: [await createLoadablePluginSource()],
    });

    await expect(agent.listContext()).resolves.toMatchObject({
      ok: false,
      error: expect.objectContaining({
        code: "store_error",
        details: expect.objectContaining({
          message: expect.stringContaining("Invalid expert memory root"),
        }),
      }),
    });
  });

  it("keeps restricted skills out of generated summary.md", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });
    await agent.addContext({
      namespace: "expert-memory",
      id: "skills/restricted-skill.md",
      content: "# Skill Card\n\n## Common Failure Modes\n\n- confidential detail\n",
      metadata: {
        sensitivity: "restricted",
      },
    });

    await expect(
      agent.readContext({
        namespace: "expert-memory",
        id: "summary.md",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        content: expect.not.stringContaining("confidential detail"),
      },
    });
  });

  it("returns context_not_found when deleting missing skill", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });

    await expect(
      agent.deleteContext({
        namespace: "expert-memory",
        id: "skills/missing.md",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.objectContaining({ code: "context_not_found" }),
    });
  });

  it("can disable memory through host memory-config.json", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({
      workspace,
      contextSystem: createContextSystemWithMemoryConfig({ enabled: false }),
      plugins: [await createLoadablePluginSource()],
    });

    await expect(agent.listContext()).resolves.toMatchObject({
      ok: true,
      value: expect.not.arrayContaining([
        expect.objectContaining({ namespace: "expert-memory" }),
      ]),
    });
  });

  it("can disable memory through source dependency plugin config", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({
      workspace,
      plugins: [
        {
          entry: expertMemoryPlugin,
          config: {
            enabled: false,
          },
        },
      ],
    });

    await expect(agent.listContext()).resolves.toMatchObject({
      ok: true,
      value: expect.not.arrayContaining([
        expect.objectContaining({ namespace: "expert-memory" }),
      ]),
    });
  });

  it("prefers explicit plugin config over environment config", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({
      workspace,
      plugins: [
        {
          entry: expertMemoryPlugin,
          config: {
            enabled: false,
          },
        },
      ],
      env: {
        PRAGMA_PLUGIN_EXPERT_MEMORY_ENABLED: "true",
      },
    });

    await expect(agent.listContext()).resolves.toMatchObject({
      ok: true,
      value: expect.not.arrayContaining([
        expect.objectContaining({ namespace: "expert-memory" }),
      ]),
    });
  });

  it("searches skills case-insensitively by default", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });
    await agent.addContext({
      namespace: "expert-memory",
      id: "skills/workspace-debugging.md",
      content: "# Skill Card\n\n## Recommended Approach\n\n- Prefer PNPM for JavaScript tasks.\n",
    });

    await expect(
      agent.searchContext({
        namespace: "expert-memory",
        query: "pnpm",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({
          id: "skills/workspace-debugging.md",
          line: expect.stringContaining("PNPM"),
        }),
      ]),
    });
  });

  it("creates task summary and evidence from task hooks", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });

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
      output: "Implemented the preferred path after fixing the file lookup problem.",
    });

    await expect(
      agent.readContext({
        namespace: "expert-memory",
        id: "tasks/session-1/run-1.md",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        metadata: expect.objectContaining({ trigger: "manual" }),
        content: expect.stringContaining("## Recommended Fix Next Time"),
      },
    });

    await expect(
      agent.readContext({
        namespace: "expert-memory",
        id: "evidence/runs/run-1.json",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        content: expect.stringContaining("\"runId\": \"run-1\""),
      },
    });
  });

  it("builds session summary and skill card on session destroy", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });

    await submitTaskHook(agent, {
      runId: "run-1",
      query: "Debug plugin memory design for repeated session workflows.",
      output: "Established a stable plugin memory design for repeated session workflows.",
    });
    await submitTaskHook(agent, {
      runId: "run-2",
      query: "Debug plugin memory design for repeated session workflows.",
      error: new Error("first attempt failed"),
    });
    await destroySessionHook(agent);

    await expect(
      agent.readContext({
        namespace: "expert-memory",
        id: "tasks/session-1/session.md",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        content: expect.stringContaining("## Candidate Skill Updates"),
      },
    });

    const listed = await agent.listContext();
    expect(listed).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({
          namespace: "expert-memory",
          id: expect.stringMatching(/^skills\/.+\.md$/),
        }),
      ]),
    });
  });

  it("does not persist derived lessons for sensitive failure messages", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });

    await submitTaskHook(agent, {
      runId: "run-sensitive-error",
      error: new Error("token: super-secret"),
    });

    await expect(
      agent.readContext({
        namespace: "expert-memory",
        id: "evidence/runs/run-sensitive-error.json",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        content: expect.stringContaining("\"lessons\": []"),
      },
    });
  });

  it("serializes run mutations for the same key", async () => {
    const manager = new ExpertMemoryManager({
      agent: { id: "memory-agent" },
    } as ExpertAgentPluginSetupContext);
    const harness = manager as unknown as SerializedMutationHarness;
    const lockMap = new Map<string, Promise<void>>();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstMutation = harness.withSerializedMutation(
      lockMap,
      "run-1",
      async () => {
        order.push("first:start");
        await firstBarrier;
        order.push("first:end");
      },
    );
    const secondMutation = harness.withSerializedMutation(
      lockMap,
      "run-1",
      async () => {
        order.push("second");
      },
    );

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseFirst?.();
    await Promise.all([firstMutation, secondMutation]);

    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("reuses the same skill card across sessions with the same theme", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });

    await submitTaskHook(agent, {
      runId: "run-1",
      query: "Debug plugin memory design for repeated session workflows.",
      output: "Established a stable plugin memory design for repeated session workflows.",
    });
    await destroySessionHook(agent);

    const firstList = await agent.listContext();
    const firstSkillId = firstList.ok
      ? firstList.value.find((item) => item.id.startsWith("skills/"))?.id
      : undefined;

    await submitTaskHook(agent, {
      runId: "run-2",
      sessionId: "session-2",
      runtimeSessionId: "runtime-session-2",
      query: "Debug plugin memory design for repeated session workflows.",
      output: "Reused the same plugin memory design after avoiding the old mistake.",
    });
    await destroySessionHook(agent, {
      sessionId: "session-2",
      runtimeSessionId: "runtime-session-2",
    });

    const secondList = await agent.listContext();
    const skillIds =
      secondList.ok === true ? secondList.value.filter((item) => item.id.startsWith("skills/")) : [];

    expect(firstSkillId).toBeDefined();
    expect(skillIds).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: firstSkillId })]),
    );
    expect(skillIds).toHaveLength(1);
  });

  it("keeps external-context tasks out of skill cards while still writing task summaries", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });

    await submitTaskHook(agent, {
      runId: "external-run",
      externalContext: true,
      output: "Used external context and finished the task.",
    });
    await destroySessionHook(agent);

    await expect(
      agent.readContext({
        namespace: "expert-memory",
        id: "tasks/session-1/external-run.md",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        content: expect.stringContaining("Task Summary"),
      },
    });

    const listed = await agent.listContext();
    const skillIds =
      listed.ok === true ? listed.value.filter((item) => item.id.startsWith("skills/")) : [];
    expect(skillIds).toHaveLength(0);
  });

  it("uses configured memory defaults", () => {
    expect(parseMemoryPluginConfig({})).toMatchObject({
      enabled: true,
      useMemories: true,
      generateMemories: true,
      disableOnExternalContext: true,
      minRunOutputChars: 0,
      summaryMaxBytes: 8192,
      maxOutputExcerptChars: 1200,
      maxToolExcerptChars: 400,
    });
  });
});

function createContextSystemWithMemoryConfig(config: Record<string, unknown>): ContextSystem {
  const contextSystem = new ContextSystem();
  contextSystem.register({
    namespace: HOST_CONTEXT_NAMESPACE,
    store: createInMemoryContextStore({
      context: [
        {
          id: "memory-config.json",
          content: JSON.stringify(config),
          metadata: { trigger: "manual" },
        },
      ],
    }),
  });

  return contextSystem;
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
    readonly error?: unknown;
    readonly externalContext?: boolean | undefined;
  },
): Promise<void> {
  await agent.hooks?.afterTaskSubmit?.({
    agent,
    session: createSessionInfo({
      sessionId: options.sessionId,
      runtimeSessionId: options.runtimeSessionId,
      runState: options.error === undefined ? "succeeded" : "failed",
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
    ...(options.error === undefined ? {} : { error: options.error }),
    context: {
      source: { type: "test" },
      attributes: {
        ...(options.externalContext === undefined
          ? {}
          : { externalContext: options.externalContext }),
      },
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

async function createAgent(options: {
  readonly workspace: string;
  readonly plugins: readonly ExpertAgentPluginUse[];
  readonly contextSystem?: ContextSystem | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
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
    ...(options.contextSystem === undefined ? {} : { contextSystem: options.contextSystem }),
    ...(options.env === undefined ? {} : { env: options.env }),
    plugins: options.plugins,
  });
}

async function createLoadablePluginSource(): Promise<ExpertAgentPluginUse> {
  return { entry: expertMemoryPlugin };
}

async function createWorkspaceDir(): Promise<string> {
  return await createTempDir(packageRoot, "workspace");
}

async function createTempDir(baseDir: string, kind: string): Promise<string> {
  const dir = await mkdtemp(resolve(baseDir, `.pragma-memory-${kind}-`));
  tempDirs.push(dir);
  return dir;
}
