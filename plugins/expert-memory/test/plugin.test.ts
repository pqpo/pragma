import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  ContextSystem,
  ExpertAgent,
  HOST_CONTEXT_NAMESPACE,
  createInMemoryContextStore,
  readExpertAgentPluginManifest,
} from "@expertmesh/agent-core";
import type { ExpertAgentPluginUse } from "@expertmesh/agent-core";

import expertMemoryPlugin, { parseMemoryPluginConfig } from "../src/index.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
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
    expect(expertMemoryPlugin.manifest).toEqual(manifest);
  });

  it("registers expert-memory by default and exposes memory.md as model-decision context", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });

    await expect(
      agent.addContext({
        namespace: "expert-memory",
        id: "memory.md",
        content: "# Expert Memory\n\n## Preferences\n\n- Prefer pnpm for JavaScript tasks.\n",
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
          id: "memory.md",
          metadata: expect.objectContaining({ trigger: "model_decision" }),
        }),
      ]),
    });
  });

  it("injects summary.md as always-on without injecting full memory.md", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });
    await agent.addContext({
      namespace: "expert-memory",
      id: "memory.md",
      content: "# Expert Memory\n\n## Pitfalls\n\n- Do not create apps/local-runner.\n",
    });

    const context = await agent.buildContext();

    expect(context.systemPrompt).toContain("Expert Memory Summary");
    expect(context.systemPrompt).toContain("Do not create apps/local-runner.");
    expect(context.systemPrompt).toContain("Available context");
    expect(context.systemPrompt).toContain("expert-memory/memory.md");
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

  it("keeps restricted memory out of generated summary.md", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });
    await agent.addContext({
      namespace: "expert-memory",
      id: "memory.md",
      content: "# Expert Memory\n\n- confidential detail\n",
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

  it("returns context_not_found when deleting missing memory", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });

    await expect(
      agent.deleteContext({
        namespace: "expert-memory",
        id: "memory.md",
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
        EXPERTMESH_PLUGIN_EXPERT_MEMORY_ENABLED: "true",
      },
    });

    await expect(agent.listContext()).resolves.toMatchObject({
      ok: true,
      value: expect.not.arrayContaining([
        expect.objectContaining({ namespace: "expert-memory" }),
      ]),
    });
  });

  it("searches memory case-insensitively by default", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });
    await agent.addContext({
      namespace: "expert-memory",
      id: "memory.md",
      content: "# Expert Memory\n\n- Prefer PNPM for JavaScript tasks.\n",
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
          id: "memory.md",
          line: expect.stringContaining("PNPM"),
        }),
      ]),
    });
  });

  it("creates pending run evidence from eligible afterTaskSubmit hooks", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });
    const output = [
      "The user prefers implementation plans that avoid duplicate memory tools.",
      "Future work should use the expert-memory namespace through context tools.",
      "This stable workflow preference is long enough to pass the default threshold.",
      "It should be reviewed before merging into memory.md.",
    ].join(" ");

    await submitTaskHook(agent, {
      runId: "run-1",
      output,
    });

    await expect(
      agent.readContext({
        namespace: "expert-memory",
        id: "pending/run-1.md",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        metadata: expect.objectContaining({ trigger: "manual" }),
        content: expect.stringContaining("Pending Memory Candidate run-1"),
      },
    });
  });

  it("skips pending run evidence for ineligible afterTaskSubmit hooks", async () => {
    const workspace = await createWorkspaceDir();
    const agent = await createAgent({ workspace, plugins: [await createLoadablePluginSource()] });
    const eligibleLengthOutput = [
      "This output is intentionally long enough to pass the default memory threshold.",
      "It describes a stable workflow preference that would otherwise become a candidate.",
      "The hook should skip it when other eligibility checks fail before writing context.",
      "This gives the test enough text to exceed the configured minimum output length.",
    ].join(" ");

    await submitTaskHook(agent, {
      runId: "failed-run",
      error: new Error("failed"),
    });
    await submitTaskHook(agent, {
      runId: "external-run",
      output: eligibleLengthOutput,
      externalContext: true,
    });
    await submitTaskHook(agent, {
      runId: "short-run",
      output: "too short",
    });
    await submitTaskHook(agent, {
      runId: "sensitive-run",
      output: `${eligibleLengthOutput} token = abc123`,
    });

    for (const runId of ["failed-run", "external-run", "short-run", "sensitive-run"]) {
      await expect(
        agent.readContext({
          namespace: "expert-memory",
          id: `pending/${runId}.md`,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: expect.objectContaining({ code: "context_not_found" }),
      });
    }
  });

  it("uses configured memory defaults", () => {
    expect(parseMemoryPluginConfig({})).toMatchObject({
      enabled: true,
      useMemories: true,
      generateMemories: true,
      disableOnExternalContext: true,
      minRunOutputChars: 200,
      summaryMaxBytes: 8192,
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

async function submitTaskHook(
  agent: ExpertAgent,
  options: {
    readonly runId: string;
    readonly output?: string | undefined;
    readonly error?: unknown;
    readonly externalContext?: boolean | undefined;
  },
): Promise<void> {
  await agent.hooks?.afterTaskSubmit?.({
    agent,
    session: {
      systemSessionId: "session-1",
      runtimeSession: {
        type: "test-runtime",
        id: "runtime-session-1",
      },
      agentId: agent.id,
      runtime: {
        id: "test-runtime",
        kind: "test-runtime",
        displayName: "Test Runtime",
      },
      sessionState: "active",
      runState: options.error === undefined ? "succeeded" : "failed",
    },
    runId: options.runId,
    submission: {
      query: "Remember the preferred memory design.",
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

async function createAgent(options: {
  readonly workspace: string;
  readonly plugins: readonly ExpertAgentPluginUse[];
  readonly contextSystem?: ContextSystem | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): Promise<ExpertAgent> {
  return await ExpertAgent.create({
    schemaVersion: "expertmesh.expert/v1",
    id: "memory-agent",
    displayName: "Memory Agent",
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

async function createLoadablePluginSource(): Promise<string> {
  const sourceDir = await createTempDir(repoRoot, "source");
  await cp(packageRoot, sourceDir, {
    recursive: true,
    filter: (source) =>
      !source.includes("/node_modules/") &&
      !source.includes("/dist/") &&
      !source.includes("/.turbo/"),
  });

  const manifestPath = resolve(sourceDir, "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    runtime: {
      entry: string;
    };
  };
  manifest.runtime.entry = "./src/index.ts";
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return sourceDir;
}

async function createWorkspaceDir(): Promise<string> {
  return await createTempDir(packageRoot, "workspace");
}

async function createTempDir(baseDir: string, kind: string): Promise<string> {
  const dir = await mkdtemp(resolve(baseDir, `.expertmesh-memory-${kind}-`));
  tempDirs.push(dir);
  return dir;
}
