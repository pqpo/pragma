import { ExpertAgent } from "@expertmesh/agent-core";
import type {
  ExpertAgentOptions,
  RuntimeAgentSession,
  RuntimeAdapter,
} from "@expertmesh/agent-core";
import { createCloudPiRuntimeAdapter } from "@expertmesh/agent-runtime";

import {
  createExpertAgentModelsConfig,
  formatModelConfig,
  readTestModelConfig,
} from "./model-config.ts";

export interface ExpertAgentTestHarnessOptions {
  readonly agent: ExpertAgent;
  readonly defaultQuery: string;
  readonly query?: string | undefined;
  readonly runtime?: RuntimeAdapter | undefined;
  readonly inspectContext?: boolean | undefined;
}

export class ExpertAgentTestHarness {
  readonly agent: ExpertAgent;
  readonly defaultQuery: string;
  readonly query: string | undefined;
  readonly runtime: RuntimeAdapter;
  readonly inspectContext: boolean;

  constructor(options: ExpertAgentTestHarnessOptions) {
    this.agent = options.agent;
    this.defaultQuery = options.defaultQuery;
    this.query = options.query;
    this.runtime = options.runtime ?? createCloudPiRuntimeAdapter();
    this.inspectContext = options.inspectContext ?? false;
  }

  async run(): Promise<void> {
    const modelConfig = readTestModelConfig();
    const agent = createAgentWithModels(this.agent, createExpertAgentModelsConfig(modelConfig));
    const query = this.query ?? this.defaultQuery;

    if (this.inspectContext) {
      await printAgentContextSummary(agent);
    }

    const session = await this.runtime.createSession({ agent });

    try {
      printRunHeader(agent, formatModelConfig(modelConfig), query);
      const result = await submitAndStream(session, query);

      console.log("");
      console.log("");
      console.log(`Run ID: ${result.runId}`);
    } finally {
      await session.abort();
    }
  }
}

function createAgentWithModels(
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

async function submitAndStream(
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

async function printAgentContextSummary(agent: ExpertAgent): Promise<void> {
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

function printRunHeader(agent: ExpertAgent, model: string, query: string): void {
  console.log(`Running ${agent.displayName} with ${model}`);
  console.log(`Workspace: ${agent.workspace}`);
  console.log(`Task: ${query}`);
  console.log("");
}
