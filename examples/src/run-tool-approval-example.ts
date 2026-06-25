import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { ExpertAgent } from "@expertmesh/agent-core";
import { createCloudPiRuntimeAdapter } from "@expertmesh/agent-runtime";

import { printRunHeader, printRunResult } from "./harness/expert-agent-example-utils.ts";
import {
  createExpertAgentModelsConfig,
  formatModelConfig,
  readExampleModelConfig,
} from "./harness/model-config.ts";
import { readBasicExampleCli } from "./harness/cli.ts";
import {
  defaultWorkspaceRoot,
  ensureWorkspaceDir,
  loadExamplesEnv,
  resolveExamplePath,
} from "./harness/paths.ts";
import { printRunStream } from "./harness/stream-output.ts";

const defaultQuery = "先调用 askUserQuestion 问我是否继续，然后再执行一个需要确认的工具。";

loadExamplesEnv();

const cli = readBasicExampleCli(defaultQuery);
const workspace = defaultWorkspaceRoot;

await ensureWorkspaceDir(workspace);

const modelConfig = readExampleModelConfig();
const agent = await ExpertAgent.create({
  schemaVersion: "expertmesh.expert/v1",
  id: "tool-approval-example-expert",
  displayName: "Tool Approval Example Expert",
  description: "Demonstrates approval-required tools and askUserQuestion.",
  tags: ["example", "approval"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  models: createExpertAgentModelsConfig(modelConfig),
  tools: [
    {
      name: "delete_workspace_note",
      description: "Delete a workspace note after explicit confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      call: async (args) => ({
        text: `Deleted workspace note at ${(args as { path?: string }).path ?? "<unknown>"}`,
      }),
    },
  ],
  plugins: [resolveExamplePath("plugins/tool-approval-policy")],
});

const runtime = createCloudPiRuntimeAdapter();
const session = await runtime.createSession({
  agent,
  context: {
    attributes: {
      toolApprovalHandler: createCliApprovalHandler(),
    },
  },
});

try {
  console.log("Approval example:");
  console.log(`- tools: ${agent.tools?.map((tool) => tool.name).join(", ") ?? "<none>"}`);
  console.log("");

  for (const [index, query] of cli.turns.entries()) {
    console.log(`Turn ${index + 1}/${cli.turns.length}`);
    printRunHeader(agent, formatModelConfig(modelConfig), query);
    const run = session.submit({ query });
    await printRunStream(run);
    const result = await run.result;
    printRunResult(result.runId);
    console.log("");
  }
} finally {
  await session.abort();
}

function createCliApprovalHandler() {
  const rl = createInterface({ input, output });

  return async ({
    toolName,
    reason,
    input: toolInput,
  }: {
    readonly toolName: string;
    readonly reason?: string | undefined;
    readonly input: unknown;
  }) => {
    console.log("");
    console.log(`[approval] ${toolName}`);
    if (reason !== undefined) {
      console.log(reason);
    }
    console.log(JSON.stringify(toolInput, null, 2));
    const answer = (await rl.question("Approve? [y/N] ")).trim().toLowerCase();

    if (answer !== "y" && answer !== "yes") {
      return { approved: false, reason: "User denied approval." };
    }

    if (toolName === "askUserQuestion") {
      const response = (await rl.question("Answer JSON: ")).trim();

      return {
        approved: true,
        updatedInput: response.length === 0 ? { answered: true } : JSON.parse(response),
      };
    }

    return { approved: true };
  };
}
