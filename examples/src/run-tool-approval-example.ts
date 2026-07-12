import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { createPragma, createRuntimeRegistry, defineAgent } from "@pragma/core";
import { createPiRuntime } from "@pragma/runtime-pi";

import toolApprovalPolicyPlugin from "../plugins/tool-approval-policy/src/plugin.ts";
import { createExpertAgentModelsConfig, readExampleModelConfig } from "./harness/model-config.ts";
import { defaultWorkspaceRoot, loadExamplesEnv } from "./harness/paths.ts";

loadExamplesEnv();
const runtime = createPiRuntime();
const app = createPragma({
  runtimes: createRuntimeRegistry({ defaultRuntime: "pi", runtimes: [runtime] }),
});
const agent = await defineAgent({
  id: "tool-approval-example",
  name: "Tool Approval Example",
  description: "Uses the PragmaApp Human Interaction protocol for tool approval.",
  tags: ["example", "approval"],
  version: "1.0.0",
  scope: "local-test",
  workspace: defaultWorkspaceRoot,
  models: createExpertAgentModelsConfig(readExampleModelConfig()),
  tools: [createApprovalTool()],
  plugins: [{ entry: toolApprovalPolicyPlugin }],
});
const handle = await app.start(agent, {
  input: "调用 delete_workspace_note 删除 notes/example.md，并说明结果。",
  runtime: "pi",
});
const rl = createInterface({ input: stdin, output: stdout });

try {
  for await (const event of handle.events) {
    if (event.sourceType !== "human.requested") continue;
    const interaction = readInteraction(event.payload);
    const answer = (await rl.question("Approve? [y/N] ")).trim().toLowerCase();
    await app.taskManager.respondToHumanInteraction({
      interactionId: interaction.id,
      response: { approved: answer === "y" || answer === "yes" },
    });
  }
  console.log((await handle.result).output);
} finally {
  rl.close();
}

function readInteraction(payload: unknown): { readonly id: string } {
  if (typeof payload === "object" && payload !== null && "interaction" in payload) {
    const interaction = (payload as { interaction: unknown }).interaction;
    if (typeof interaction === "object" && interaction !== null && "id" in interaction) {
      return { id: String((interaction as { id: unknown }).id) };
    }
  }
  throw new Error("human.requested did not contain an interaction.");
}

function createApprovalTool() {
  return {
    name: "delete_workspace_note" as const,
    description: "Delete a markdown note after explicit Human approval.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    call: async (args: unknown) => ({
      text: `Approved deletion: ${String((args as { path?: unknown }).path ?? "<unknown>")}`,
    }),
  };
}
