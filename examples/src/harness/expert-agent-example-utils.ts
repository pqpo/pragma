import { ExpertAgent } from "@expertmesh/agent-core";

export async function printAgentContextSummary(agent: ExpertAgent): Promise<void> {
  const context = await agent.buildContext();
  const alwaysOnDocuments = context.documents.filter(
    (document) => document.metadata.trigger === "always_on",
  );
  const modelDecisionDocuments = context.documents.filter(
    (document) => document.metadata.trigger === "model_decision",
  );

  console.log("Context preflight:");
  console.log(`- documents: ${context.documents.length}`);
  console.log(
    `- always_on: ${alwaysOnDocuments.map((document) => document.id).join(", ") || "none"}`,
  );
  console.log(
    `- model_decision: ${
      modelDecisionDocuments.map((document) => document.id).join(", ") || "none"
    }`,
  );
  console.log(`- retrievedChunks: ${context.snapshot.retrievedChunks.length}`);
  console.log("");
}

export function printRunHeader(agent: ExpertAgent, model: string, query: string): void {
  console.log(`Running ${agent.displayName} with ${model}`);
  console.log(`Workspace: ${agent.workspace}`);
  console.log(`Task: ${query}`);
  console.log("");
}

export function printRunResult(runId: string): void {
  console.log("");
  console.log("");
  console.log(`Run ID: ${runId}`);
}
