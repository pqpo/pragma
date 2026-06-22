import { ExpertAgent } from "@expertmesh/agent-core";
import type { RuntimeSessionRef } from "@expertmesh/agent-core";
import { createCloudPiRuntimeAdapter } from "@expertmesh/agent-runtime";

import { printRunHeader, printRunResult } from "./harness/expert-agent-example-utils.ts";
import {
  createExpertAgentModelsConfig,
  formatModelConfig,
  readExampleModelConfig,
} from "./harness/model-config.ts";
import { readBasicExampleCli } from "./harness/cli.ts";
import { defaultWorkspaceRoot, ensureWorkspaceDir, loadExamplesEnv } from "./harness/paths.ts";

const defaultQuery = "用一句话介绍 ExpertMesh 的 Phase 0 Harness 是什么。";

loadExamplesEnv();

const cli = readBasicExampleCli(defaultQuery);
const workspace = defaultWorkspaceRoot;

await ensureWorkspaceDir(workspace);

const modelConfig = readExampleModelConfig();
const agent = new ExpertAgent({
  schemaVersion: "expertmesh.expert/v1",
  id: "basic-example-expert",
  displayName: "Basic Example Expert",
  description: "A minimal ExpertAgent instance used by the examples package.",
  tags: ["example"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  models: createExpertAgentModelsConfig(modelConfig),
});

const runtime = createCloudPiRuntimeAdapter();
const runtimeSession = createRuntimeSessionRef(cli.runtimeSessionId);
const session = await runtime.createSession({
  agent,
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
    const result = await session.submit({
      query,
      onEvent(event) {
        if (event.type === "message.delta") {
          process.stdout.write(event.payload.delta);
        }
      },
    });
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
