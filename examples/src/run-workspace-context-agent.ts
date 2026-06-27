import {
  AGENTS_CONTEXT_ID,
  ContextSystem,
  ExpertAgent,
  FileSystemContextStore,
  HOST_CONTEXT_NAMESPACE,
  createInMemoryContextStore,
} from "@expertmesh/agent-core";
import type { ExpertAgentContextStore } from "@expertmesh/agent-core";
import { createCloudPiRuntimeAdapter } from "@expertmesh/agent-runtime";

import {
  printAgentContextSummary,
  printRunHeader,
  printRunResult,
} from "./harness/expert-agent-example-utils.ts";
import {
  createExpertAgentModelsConfig,
  formatModelConfig,
  readExampleModelConfig,
} from "./harness/model-config.ts";
import { readWorkspaceContextsExampleCli } from "./harness/cli.ts";
import {
  defaultWorkspaceRoot,
  ensureWorkspaceDir,
  loadExamplesEnv,
  resolveExamplePath,
} from "./harness/paths.ts";
import { printRunStream } from "./harness/stream-output.ts";

const defaultQuery = [
  "测试 ExpertMesh workspace + context 能力：",
  "1. 先基于 always-on AGENTS.md 说明本仓库最重要的边界约束。",
  "2. 再使用 context 工具查找 workspace-overview.md，确认当前核心应用入口。",
  "3. 最后结合 workspace 中的 package.json 或 examples/package.json，给出后续示例应该如何运行。",
].join("\n");

loadExamplesEnv();

const cli = readWorkspaceContextsExampleCli(defaultQuery);
const workspace =
  cli.workspace === undefined ? defaultWorkspaceRoot : resolveExamplePath(cli.workspace);
const contextDir = cli.context === undefined ? undefined : resolveExamplePath(cli.context);
const contextStore = createExampleContextStore(contextDir);
const contextSystem = new ContextSystem();
contextSystem.register({
  namespace: HOST_CONTEXT_NAMESPACE,
  store: contextStore,
});

await ensureWorkspaceDir(workspace);

const modelConfig = readExampleModelConfig();
const agent = await ExpertAgent.create({
  schemaVersion: "expertmesh.expert/v1",
  id: "workspace-context-test-expert",
  displayName: "Workspace Context Test Expert",
  description:
    "A test ExpertAgent that exercises workspace access, always-on AGENTS.md context, and memory-backed context tools.",
  tags: ["example", "workspace", "context"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  contextSystem,
  models: createExpertAgentModelsConfig(modelConfig),
});

const runtime = createCloudPiRuntimeAdapter();

printExampleConfig(workspace, contextDir);
await printAgentContextSummary(agent);

const session = await runtime.createSession({ agent });

try {
  printRunHeader(agent, formatModelConfig(modelConfig), cli.query);
  const run = session.submit({
    query: cli.query,
  });

  await printRunStream(run);

  const result = await run.result;
  printRunResult(result.runId);
} finally {
  await session.abort();
}

function createExampleContextStore(contextDir: string | undefined): ExpertAgentContextStore {
  if (contextDir !== undefined) {
    return new FileSystemContextStore({ rootDir: contextDir });
  }

  return createInMemoryContextStore({
    context: [
      {
        id: AGENTS_CONTEXT_ID,
        content: [
          "# Example AGENTS.md",
          "",
          "This always-on mock context is used when --context is not provided.",
          "It keeps the example runnable without requiring a prepared context directory.",
        ].join("\n"),
      },
      {
        id: "workspace-overview.md",
        content: [
          "# ExpertMesh Workspace Overview",
          "",
          "ExpertMesh is a multi-expert Agent orchestration platform.",
          "The active app entry points are apps/web, apps/server, and apps/worker.",
          "The examples workspace package shows how to instantiate and run ExpertAgent.",
          "Agent context should be exposed through the ExpertAgent context store.",
          "Cross-package code must use @expertmesh/* package imports instead of relative paths.",
        ].join("\n"),
        metadata: {
          description: "ExpertMesh workspace overview for runtime context retrieval tests.",
          trigger: "model_decision",
          trustLevel: "workspace",
          sensitivity: "internal",
        },
      },
    ],
  });
}

function printExampleConfig(workspace: string, contextDir: string | undefined): void {
  console.log("Example config:");
  console.log(`- workspace: ${workspace}`);
  console.log(`- context: ${contextDir ?? "in-memory mock"}`);
  console.log("");
}
