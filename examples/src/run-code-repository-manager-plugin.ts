import {
  ContextSystem,
  ExpertAgent,
  HOST_CONTEXT_NAMESPACE,
  createInMemoryContextStore,
} from "@expertmesh/core";
import { createCloudPiRuntimeAdapter } from "@expertmesh/core";
import codeRepositoryManagerPlugin from "@expertmesh/plugin-code-repository-manager";

import {
  printPluginLoadIssues,
  printRunHeader,
  printRunResult,
} from "./harness/expert-agent-example-utils.ts";
import { createExampleLoggerProvider } from "./harness/logger.ts";
import {
  createExpertAgentModelsConfig,
  formatModelConfig,
  readExampleModelConfig,
} from "./harness/model-config.ts";
import {
  defaultWorkspaceRoot,
  ensureWorkspaceDir,
  loadExamplesEnv,
} from "./harness/paths.ts";
import { printRunStream } from "./harness/stream-output.ts";

const workspace = defaultWorkspaceRoot;
const defaultQuery = "Agent 管理了哪些仓库？";

loadExamplesEnv();

await ensureWorkspaceDir(workspace);
const modelConfig = readExampleModelConfig();
const loggerProvider = createExampleLoggerProvider();

const contextSystem = new ContextSystem();
contextSystem.register({
  namespace: HOST_CONTEXT_NAMESPACE,
  store: createInMemoryContextStore({
    context: [
      {
        id: "repositories.json",
        content: JSON.stringify(
          {
            repositories: [
              {
                id: "expert-mesh",
                name: "ExpertMesh",
                cloneUrl: "https://github.com/example/expert-mesh.git",
                defaultBranch: "main",
                provider: "github",
                description:
                  "Example repository entry showing how repository metadata is exposed to ExpertAgent context.",
                allowedBranches: ["main"],
                shallowClone: true,
              },
            ],
          },
          null,
          2,
        ),
        metadata: {
          description: "Repositories available to the code repository manager plugin.",
          trigger: "manual",
          trustLevel: "workspace",
          sensitivity: "internal",
        },
      },
    ],
  }),
});

const agent = await ExpertAgent.create({
  schemaVersion: "expertmesh.expert/v1",
  id: "code-repository-plugin-example-agent",
  name: "Code Repository Plugin Example Agent",
  description: "Demonstrates how to attach the code repository manager plugin to ExpertAgent.",
  tags: ["example", "plugin", "repository"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  contextSystem,
  loggerProvider,
  models: createExpertAgentModelsConfig(modelConfig),
  plugins: [{ entry: codeRepositoryManagerPlugin }],
});

const contextItems = await agent.listContext();

printPluginLoadIssues(agent);

console.log("Plugin context:");
if (contextItems.ok) {
  for (const item of contextItems.value) {
    console.log(
      `- namespace=${item.namespace ?? "<none>"} id=${item.id} trigger=${item.metadata.trigger}`,
    );
  }
} else {
  console.log(`- error: ${contextItems.error.message}`);
}

const repositoryContext = await agent.readContext({
  namespace: "code-repository-manager",
  id: "code-repositories.md",
});

console.log("");
console.log("Repository context preview:");
if (repositoryContext.ok) {
  console.log(repositoryContext.value.content);
} else {
  console.log(`error: ${repositoryContext.error.message}`);
}

console.log("");
console.log("Plugin Git environment hook:");
console.log(
  agent.hooks?.beforeSessionCreate === undefined ? "- not configured" : "- beforeSessionCreate",
);

const runtime = createCloudPiRuntimeAdapter({ loggerProvider });
const session = await runtime.createSession({ agent });

try {
  console.log("");
  printRunHeader(agent, formatModelConfig(modelConfig), defaultQuery);
  const run = session.submit({
    query: defaultQuery,
  });

  await printRunStream(run);

  const result = await run.result;
  printRunResult(result.runId);
} finally {
  await session.abort();
}
