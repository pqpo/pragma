import { ExpertAgent } from "@pragma/core";
import type { RuntimeSessionRef } from "@pragma/core";
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
import { printRunStream } from "./harness/stream-output.ts";

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
const runtimeSession = createRuntimeSessionRef(cli.runtimeSessionId);
const session = await runtime.createSession({
  agent,
  owner: { workflowRunId: "expert-agent-runtime-example" },
  ...(cli.systemSessionId === undefined ? {} : { systemSessionId: cli.systemSessionId }),
  ...(runtimeSession === undefined ? {} : { runtimeSession }),
});

try {
  const sessionInfo = session.info();

  console.log("Session:");
  console.log(`- systemSessionId: ${sessionInfo.systemSessionId}`);
  console.log(`- runtimeSessionId: ${sessionInfo.runtimeSession.id}`);
  console.log("");

  for (const [index, query] of cli.turns.entries()) {
    console.log(`Turn ${index + 1}/${cli.turns.length}`);
    printRunHeader(agent, formatModelConfig(modelConfig), query);
    const run = session.submit({
      query,
    });

    await printRunStream(run);

    const result = await run.result;
    printRunResult(result.runId);
    console.log("");
  }
} finally {
  await session.abort();
}

function createRuntimeSessionRef(
  runtimeSessionId: string | undefined,
): RuntimeSessionRef | undefined {
  if (runtimeSessionId === undefined) {
    return undefined;
  }

  return {
    type: "cloud-pi-agent",
    id: runtimeSessionId,
  };
}
