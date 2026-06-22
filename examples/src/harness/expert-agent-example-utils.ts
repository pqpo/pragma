import { ExpertAgent } from "@expertmesh/agent-core";
import type { ExpertAgentOptions, RuntimeAgentSession } from "@expertmesh/agent-core";

export function createAgentWithModels(
  agent: ExpertAgent,
  models: ExpertAgentOptions["models"],
): ExpertAgent {
  return new ExpertAgent({
    schemaVersion: agent.schemaVersion,
    id: agent.id,
    displayName: agent.displayName,
    description: agent.description,
    tags: agent.tags,
    version: agent.version,
    scope: agent.scope,
    workspace: agent.workspace,
    models,
    ...(agent.mcp === undefined ? {} : { mcp: agent.mcp }),
    ...(agent.skills === undefined ? {} : { skills: agent.skills }),
    ...(agent.documents === undefined ? {} : { documents: agent.documents }),
    ...(agent.subAgents === undefined ? {} : { subAgents: agent.subAgents }),
    ...(agent.tools === undefined ? {} : { tools: agent.tools }),
    ...(agent.hooks === undefined ? {} : { hooks: agent.hooks }),
    ...(agent.plugins === undefined ? {} : { plugins: agent.plugins }),
  });
}

export async function submitAndStream(
  session: RuntimeAgentSession,
  query: string,
): Promise<Awaited<ReturnType<RuntimeAgentSession["submit"]>>> {
  return await session.submit({
    query,
    onEvent(event) {
      if (event.type === "message.delta") {
        process.stdout.write(event.payload.delta);
      }
    },
  });
}

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
