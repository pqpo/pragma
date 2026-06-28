import { ExpertAgent } from "@expertmesh/core";

export async function printAgentContextSummary(agent: ExpertAgent): Promise<void> {
  const context = await agent.buildContext();
  const alwaysOnContexts = context.context.filter(
    (context) => context.metadata.trigger === "always_on",
  );
  const modelDecisionContexts = context.context.filter(
    (context) => context.metadata.trigger === "model_decision",
  );

  console.log("Context preflight:");
  console.log(`- context: ${context.context.length}`);
  console.log(`- always_on: ${alwaysOnContexts.map((context) => context.id).join(", ") || "none"}`);
  console.log(
    `- model_decision: ${modelDecisionContexts.map((context) => context.id).join(", ") || "none"}`,
  );
  console.log(`- retrievedChunks: ${context.snapshot.retrievedChunks.length}`);
  console.log("");
}

export function printRunHeader(agent: ExpertAgent, model: string, query: string): void {
  console.log(`Running ${agent.name} with ${model}`);
  console.log(`Workspace: ${agent.workspace}`);
  console.log(`Task: ${query}`);
  console.log("");
}

export function printPluginLoadIssues(agent: ExpertAgent): void {
  if (agent.pluginLoadIssues === undefined || agent.pluginLoadIssues.length === 0) {
    return;
  }

  console.log("Plugin load issues:");
  for (const issue of agent.pluginLoadIssues) {
    const plugin = issue.pluginId === undefined ? "" : ` plugin=${issue.pluginId}`;
    console.log(`- ${issue.code}${plugin} source=${issue.source}`);
    console.log(`  ${issue.message}`);
  }
  console.log("");
}

export function printRunResult(runId: string): void {
  console.log("");
  console.log("");
  console.log(`Run ID: ${runId}`);
}
