import { ExpertAgent, createPragma, createRuntimeRegistry } from "@pragma/core";
import { createPiRuntime } from "@pragma/runtime-pi";

import { printRunHeader, printRunResult } from "./harness/expert-agent-example-utils.ts";
import { createExampleLoggerProvider } from "./harness/logger.ts";
import {
  createExpertAgentModelsConfig,
  formatModelConfig,
  readExampleModelConfig,
} from "./harness/model-config.ts";
import { readBasicExampleCli } from "./harness/cli.ts";
import { defaultWorkspaceRoot, ensureWorkspaceDir, loadExamplesEnv } from "./harness/paths.ts";
import { exitIfRuntimeUnavailable } from "./harness/runtime-availability.ts";
import { printPragmaRunStream } from "./harness/stream-output.ts";

const defaultQuery = "用一句话介绍 Pragma 的多专家 Agent 编排架构是什么。";

loadExamplesEnv();

const cli = readBasicExampleCli(defaultQuery);
const workspace = defaultWorkspaceRoot;

await ensureWorkspaceDir(workspace);

const modelConfig = readExampleModelConfig();
const loggerProvider = createExampleLoggerProvider();
const agent = await ExpertAgent.create({
  id: "basic-example-expert",
  name: "Basic Example Expert",
  description: "A minimal ExpertAgent instance used by the examples package.",
  tags: ["example"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  loggerProvider,
  models: createExpertAgentModelsConfig(modelConfig),
});

const runtime = createPiRuntime({ loggerProvider });
await exitIfRuntimeUnavailable(runtime);
const app = createPragma({
  runtimes: createRuntimeRegistry({
    defaultRuntime: runtime.descriptor.id,
    runtimes: [runtime],
  }),
});

for (const [index, query] of cli.turns.entries()) {
  console.log(`Run ${index + 1}/${cli.turns.length}`);
  printRunHeader(agent, formatModelConfig(modelConfig), query);
  const handle = await app.start(agent, { input: { prompt: query } });
  await printPragmaRunStream(handle.events);
  const result = await handle.result;
  printRunResult(result.workflowRunId);
  console.log(`- systemSessionId: ${result.systemSessionId ?? "<none>"}`);
  console.log("");
}
