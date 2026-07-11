import { ExpertAgent } from "@pragma/core";

export async function printAgentContextSummary(agent: ExpertAgent): Promise<void> {
  const context = await agent.buildContext();
  const available = await agent.listContext();

  console.log("Context preflight:");
  console.log(`- available: ${available.ok ? available.value.items.length : "unavailable"}`);
  console.log(
    `- preloaded: ${context.snapshot.loadedContexts?.map((item) => item.id).join(", ") || "none"}`,
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
