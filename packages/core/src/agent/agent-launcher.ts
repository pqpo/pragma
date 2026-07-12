import type { ExpertAgent } from "./expert-agent.ts";
import type { ExpertAgentManagedTool, ExpertAgentToolCallResult } from "../tools/managed-tool.ts";

// `reuse_by_agent` is intentionally deferred until PragmaApp.resume() can resume the original
// child Workflow. See ADR 005; never implement it by attaching an old Session to a new Workflow.
export type AgentLaunchSessionPolicy = "fresh";

export interface CreateAgentLauncherOptions {
  readonly agents: readonly ExpertAgent[];
  readonly defaultSessionPolicy?: AgentLaunchSessionPolicy | undefined;
}

export interface AgentLauncher {
  readonly tool: ExpertAgentManagedTool<"launch_agent", ExpertAgentToolCallResult>;
  readonly dispose: () => void;
}

interface LaunchAgentInput {
  readonly agentId: string;
  readonly task: string;
  readonly sessionPolicy?: AgentLaunchSessionPolicy | undefined;
  readonly runtime?: string | undefined;
  readonly modelName?: string | undefined;
  readonly thinkingLevel?: string | undefined;
}

const launchAgentInputSchema = {
  type: "object",
  properties: {
    agentId: {
      type: "string",
      description: "The ExpertAgent id to launch.",
    },
    task: {
      type: "string",
      description: "A self-contained task for the launched ExpertAgent.",
    },
    sessionPolicy: {
      type: "string",
      enum: ["fresh"],
      description: "Each delegated child Workflow starts a fresh runtime session.",
    },
    runtime: {
      type: "string",
      description:
        "Optional runtime id for the delegated ExpertAgent. Defaults to the parent workflow runtime.",
    },
    modelName: {
      type: "string",
      description: "Optional model name for the delegated ExpertAgent run.",
    },
    thinkingLevel: {
      type: "string",
      description: "Optional runtime-native thinking level for the delegated ExpertAgent run.",
    },
  },
  required: ["agentId", "task"],
  additionalProperties: false,
};

export function createAgentLauncher(options: CreateAgentLauncherOptions): AgentLauncher {
  const agentsById = new Map(options.agents.map((agent) => [agent.id, agent]));
  const defaultSessionPolicy = options.defaultSessionPolicy ?? "fresh";

  return {
    tool: {
      name: "launch_agent",
      description: [
        "Launch another Pragma ExpertAgent through the workflow orchestrator.",
        "Use this when a listed ExpertAgent is better suited for a focused delegated task.",
        "Each launch creates a child workflow run that is tracked by the same StateManager.",
        "",
        "Available ExpertAgents:",
        ...options.agents.map((agent) => `- ${agent.id}: ${agent.name}. ${agent.description}`),
      ].join("\n"),
      inputSchema: launchAgentInputSchema,
      async call(args, signal, context) {
        if (signal?.aborted) {
          return {
            text: "launch_agent was cancelled before the delegated run started.",
            isError: true,
            details: {
              code: "agent_launch_cancelled",
            },
          };
        }

        const input = readLaunchAgentInput(args, defaultSessionPolicy);
        const workflowExecution = context?.workflowExecution;

        if (workflowExecution === undefined) {
          return {
            text: "launch_agent requires a workflow execution context. Run the parent ExpertAgent through createPragma().run() or agent.run().",
            isError: true,
            details: {
              code: "missing_workflow_execution",
            },
          };
        }

        const agent = agentsById.get(input.agentId);

        if (agent === undefined) {
          return {
            text: `Unknown ExpertAgent: ${input.agentId}`,
            isError: true,
            details: {
              code: "unknown_agent",
              agentId: input.agentId,
              availableAgentIds: [...agentsById.keys()],
            },
          };
        }

        const runtime = input.runtime ?? workflowExecution.runtimeId;
        try {
          const result = await workflowExecution.runDirective(agent, {
            input: input.task,
            modelName: input.modelName,
            thinkingLevel: input.thinkingLevel,
            runtime,
            execution: workflowExecution,
          });

          return {
            text: formatAgentOutput(result.output),
            details: {
              agentId: agent.id,
              workflowRunId: result.workflowRunId,
              sessionPolicy: input.sessionPolicy,
              runtimeSession: result.runtimeSession,
            },
          };
        } catch (error) {
          return {
            text: error instanceof Error ? error.message : String(error),
            isError: true,
            details: {
              code: "agent_launch_failed",
              agentId: agent.id,
            },
          };
        }
      },
    },
    dispose() {},
  };
}

function readLaunchAgentInput(
  args: unknown,
  defaultSessionPolicy: AgentLaunchSessionPolicy,
): LaunchAgentInput {
  if (typeof args !== "object" || args === null) {
    throw new Error("launch_agent requires an object input.");
  }

  const record = args as Record<string, unknown>;
  const agentId = readRequiredString(record, "agentId");
  const task = readRequiredString(record, "task");
  const sessionPolicy = readSessionPolicy(record["sessionPolicy"], defaultSessionPolicy);
  const runtime = readOptionalString(record, "runtime");
  const modelName = readOptionalString(record, "modelName");
  const thinkingLevel = readOptionalString(record, "thinkingLevel");

  return {
    agentId,
    task,
    sessionPolicy,
    ...(runtime === undefined ? {} : { runtime }),
    ...(modelName === undefined ? {} : { modelName }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = readOptionalString(record, key);

  if (value === undefined) {
    throw new Error(`launch_agent requires string parameter "${key}".`);
  }

  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];

  if (value === undefined) {
    return undefined;
  }

  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readSessionPolicy(
  value: unknown,
  fallback: AgentLaunchSessionPolicy,
): AgentLaunchSessionPolicy {
  if (value === undefined) {
    return fallback;
  }

  if (value === "fresh") {
    return value;
  }

  throw new Error('launch_agent sessionPolicy must be "fresh".');
}

function formatAgentOutput(output: unknown): string {
  if (output === undefined) {
    return "";
  }

  if (typeof output === "string") {
    return output;
  }

  return JSON.stringify(output, null, 2) ?? String(output);
}
