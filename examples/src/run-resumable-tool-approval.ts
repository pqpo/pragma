import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { createPragma, createRuntimeRegistry, defineAgent } from "@pragma/core";
import type { HumanInteractionRecord } from "@pragma/core";
import { createPiRuntime } from "@pragma/runtime-pi";

import toolApprovalPolicyPlugin from "../plugins/tool-approval-policy/src/plugin.ts";
import { createExpertAgentModelsConfig, readExampleModelConfig } from "./harness/model-config.ts";
import { defaultWorkspaceRoot, loadExamplesEnv } from "./harness/paths.ts";

loadExamplesEnv();
const workflowRunId = readOption("--workflow-run-id");
const query =
  readOption("--query") ?? "调用 delete_workspace_note 删除 notes/resumable.md，并报告结果。";
const runtime = createPiRuntime();
const app = createPragma({
  runtimes: createRuntimeRegistry({ defaultRuntime: "pi", runtimes: [runtime] }),
});
const agent = await defineAgent({
  id: "resumable-approval-example",
  name: "Resumable Approval Example",
  description: "Resumes Runtime approval through a durable Root Workflow.",
  tags: ["example", "approval", "resume"],
  version: "1.0.0",
  scope: "local-test",
  workspace: defaultWorkspaceRoot,
  models: createExpertAgentModelsConfig(readExampleModelConfig()),
  tools: [createApprovalTool()],
  plugins: [{ entry: toolApprovalPolicyPlugin }],
});
const handle =
  workflowRunId === undefined
    ? await app.start(agent, { input: query, runtime: "pi" })
    : await app.resume(agent, { workflowRunId });
const rl = createInterface({ input: stdin, output: stdout });

console.log(`Workflow: ${handle.workflowRunId}`);
console.log(`Resume with: --workflow-run-id ${handle.workflowRunId}`);

try {
  const pending = (await app.stateManager.listHumanInteractions(handle.workflowRunId)).filter(
    (interaction) => interaction.status === "pending",
  );
  for (const interaction of pending) await respond(interaction);

  const consume = (async () => {
    for await (const event of handle.events) {
      if (event.sourceType !== "human.requested") continue;
      const interaction = readInteraction(event.payload);
      if (interaction.status === "pending") await respond(interaction);
    }
  })();
  const result = await handle.result;
  await consume;
  console.log(result.output);
} finally {
  rl.close();
}

async function respond(interaction: HumanInteractionRecord): Promise<void> {
  const answer = (await rl.question(`${interaction.request.title ?? "Approve"}? [y/N] `))
    .trim()
    .toLowerCase();
  await app.taskManager.respondToHumanInteraction({
    interactionId: interaction.id,
    response: { approved: answer === "y" || answer === "yes" },
  });
}

function readInteraction(payload: unknown): HumanInteractionRecord {
  if (typeof payload === "object" && payload !== null && "interaction" in payload) {
    return (payload as { interaction: HumanInteractionRecord }).interaction;
  }
  throw new Error("human.requested did not contain an interaction.");
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
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
