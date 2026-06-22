import {
  AGENTS_DOCUMENT_ID,
  ExpertAgent,
  FileSystemDocumentStore,
  createInMemoryDocumentStore,
} from "@expertmesh/agent-core";
import type { ExpertAgentDocumentStore } from "@expertmesh/agent-core";
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
import { readWorkspaceDocumentsExampleCli } from "./harness/cli.ts";
import {
  defaultWorkspaceRoot,
  ensureWorkspaceDir,
  loadExamplesEnv,
  resolveExamplePath,
} from "./harness/paths.ts";

const defaultQuery = [
  "测试 ExpertMesh workspace + document 能力：",
  "1. 先基于 always-on AGENTS.md 说明本仓库最重要的边界约束。",
  "2. 再使用 document 工具查找 workspace-overview.md，确认 Phase 0 的当前入口。",
  "3. 最后结合 workspace 中的 package.json 或 examples/package.json，给出后续示例应该如何运行。",
].join("\n");

loadExamplesEnv();

const cli = readWorkspaceDocumentsExampleCli(defaultQuery);
const workspace =
  cli.workspace === undefined ? defaultWorkspaceRoot : resolveExamplePath(cli.workspace);
const documentsDir = cli.documents === undefined ? undefined : resolveExamplePath(cli.documents);
const documentStore = createExampleDocumentStore(documentsDir);

await ensureWorkspaceDir(workspace);

const modelConfig = readExampleModelConfig();
const agent = new ExpertAgent({
  schemaVersion: "expertmesh.expert/v1",
  id: "workspace-document-test-expert",
  displayName: "Workspace Document Test Expert",
  description:
    "A test ExpertAgent that exercises workspace access, always-on AGENTS.md context, and memory-backed document tools.",
  tags: ["example", "workspace", "documents"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  documents: documentStore,
  models: createExpertAgentModelsConfig(modelConfig),
});

const runtime = createCloudPiRuntimeAdapter();

printExampleConfig(workspace, documentsDir);
await printAgentContextSummary(agent);

const session = await runtime.createSession({ agent });

try {
  printRunHeader(agent, formatModelConfig(modelConfig), cli.query);
  const run = session.submit({
    query: cli.query,
  });

  for await (const event of run.events) {
    if (event.type === "message.delta") {
      process.stdout.write(event.payload.delta);
    }
  }

  const result = await run.result;
  printRunResult(result.runId);
} finally {
  await session.abort();
}

function createExampleDocumentStore(documentsDir: string | undefined): ExpertAgentDocumentStore {
  if (documentsDir !== undefined) {
    return new FileSystemDocumentStore({ rootDir: documentsDir });
  }

  return createInMemoryDocumentStore({
    documents: [
      {
        id: AGENTS_DOCUMENT_ID,
        content: [
          "# Example AGENTS.md",
          "",
          "This always-on mock document is used when --documents is not provided.",
          "It keeps the example runnable without requiring a prepared document directory.",
        ].join("\n"),
      },
      {
        id: "workspace-overview.md",
        content: [
          "# ExpertMesh Workspace Overview",
          "",
          "ExpertMesh is currently in Phase 0 Harness.",
          "The active app entry points are apps/web, apps/server, and apps/worker.",
          "The examples workspace package shows how to instantiate and run ExpertAgent.",
          "Agent documents should be exposed through the ExpertAgent document store.",
          "Cross-package code must use @expertmesh/* package imports instead of relative paths.",
        ].join("\n"),
        metadata: {
          description:
            "ExpertMesh Phase 0 workspace overview for runtime document retrieval tests.",
          trigger: "model_decision",
          trustLevel: "workspace",
          sensitivity: "internal",
        },
      },
    ],
  });
}

function printExampleConfig(workspace: string, documentsDir: string | undefined): void {
  console.log("Example config:");
  console.log(`- workspace: ${workspace}`);
  console.log(`- documents: ${documentsDir ?? "in-memory mock"}`);
  console.log("");
}
