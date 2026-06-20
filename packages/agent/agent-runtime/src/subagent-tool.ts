import type { ExpertAgent, SubAgentDefinition } from "@expertmesh/agent-core";
import { resolveSubAgentSystemPrompt } from "@expertmesh/agent-core";

export interface SubAgentManagedTool {
  readonly name: "launch_subagent";
  readonly description: string;
  readonly inputSchema: unknown;
  readonly call: (
    args: unknown,
    signal: AbortSignal | undefined
  ) => Promise<SubAgentToolCallResult>;
}

export interface SubAgentToolCallResult {
  readonly text: string;
  readonly isError?: boolean;
  readonly details?: unknown;
}

export interface SubAgentRuntimeLaunchRequest {
  readonly agentType: string;
  readonly task: string;
  readonly definition: SubAgentDefinition;
  readonly parentSystemPrompt: string;
  readonly systemPrompt: string;
  readonly signal?: AbortSignal | undefined;
}

export type SubAgentRuntimeLauncher = (
  request: SubAgentRuntimeLaunchRequest
) => Promise<SubAgentToolCallResult>;

export interface CreateSubAgentToolOptions {
  readonly agent: ExpertAgent;
  readonly parentSystemPrompt: string;
  readonly launch: SubAgentRuntimeLauncher;
}

export const subAgentInputSchema = {
  type: "object",
  properties: {
    agentType: {
      type: "string",
      description: "The subAgent agentType to launch."
    },
    task: {
      type: "string",
      description: "The task to delegate to the selected subAgent."
    }
  },
  required: ["agentType", "task"],
  additionalProperties: false
};

export function createSubAgentTool(
  options: CreateSubAgentToolOptions
): SubAgentManagedTool | undefined {
  const subAgents = options.agent.subAgents?.agents ?? [];

  if (subAgents.length === 0) {
    return undefined;
  }

  return {
    name: "launch_subagent",
    description: [
      "Launch a specialized ExpertMesh subAgent.",
      "Use this when a listed subAgent is better suited for a focused task.",
      "",
      "Available subAgents:",
      ...subAgents.map((subAgent) => `- ${subAgent.agentType}: ${subAgent.whenToUse}`)
    ].join("\n"),
    inputSchema: subAgentInputSchema,
    async call(args, signal) {
      const agentType = readStringParam(args, "agentType");
      const task = readStringParam(args, "task");
      const definition = subAgents.find((subAgent) => subAgent.agentType === agentType);

      if (definition === undefined) {
        return {
          text: `Unknown subAgent: ${agentType}`,
          isError: true,
          details: {
            agentType,
            availableAgentTypes: subAgents.map((subAgent) => subAgent.agentType)
          }
        };
      }

      const systemPrompt = resolveSubAgentSystemPrompt(definition, {
        parentAgentId: options.agent.id,
        parentDisplayName: options.agent.displayName,
        subAgentType: definition.agentType
      });

      return options.launch({
        agentType,
        task,
        definition,
        parentSystemPrompt: options.parentSystemPrompt,
        systemPrompt,
        signal
      });
    }
  };
}

function readStringParam(params: unknown, key: string): string {
  if (typeof params === "object" && params !== null && key in params) {
    const value = (params as Record<string, unknown>)[key];

    if (typeof value === "string") {
      return value;
    }
  }

  throw new Error(`launch_subagent requires string parameter "${key}".`);
}
