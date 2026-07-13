import type { Expert } from "./expert-agent.ts";
import type { ExpertTeam } from "./expert-team.ts";
import type { ExpertAgentManagedTool, ExpertAgentToolCallResult } from "../tools/managed-tool.ts";

export type DelegationContextPolicy = "fresh" | "reuse";

export interface CreateAgentLauncherOptions {
  readonly experts: readonly Expert[];
  readonly context?: DelegationContextPolicy | undefined;
  readonly maxConcurrency?: number | undefined;
  readonly maxDepth?: number | undefined;
}

export interface AgentLauncher {
  readonly tool: ExpertAgentManagedTool<"delegate_expert", ExpertAgentToolCallResult>;
}

export interface AgentDelegationDefinition {
  readonly experts: readonly Expert[];
  readonly context: DelegationContextPolicy;
  readonly maxConcurrency: number;
  readonly maxDepth: number;
}

const agentDelegationDefinition = Symbol("pragma.agent-delegation-definition");

type AgentDelegationTool = ExpertAgentManagedTool<"delegate_expert", ExpertAgentToolCallResult> & {
  readonly [agentDelegationDefinition]: AgentDelegationDefinition;
};

export function createAgentLauncher(options: CreateAgentLauncherOptions): AgentLauncher {
  const experts = readUniqueExperts(options.experts, "AgentLauncher");
  if (experts.length === 0) throw new Error("AgentLauncher requires at least one Expert.");

  return Object.freeze({
    tool: createDelegationTool({
      experts,
      context: readContextPolicy(options.context),
      maxConcurrency: readPositiveInteger(options.maxConcurrency ?? 4, "maxConcurrency"),
      maxDepth: readPositiveInteger(options.maxDepth ?? 3, "maxDepth"),
      description: "Delegate a focused task to another Expert.",
    }),
  });
}

export function createTeamDelegationTool(
  team: ExpertTeam,
  sourceExpertId: string,
): ExpertAgentManagedTool<"delegate_expert", ExpertAgentToolCallResult> | undefined {
  const allowed = team.delegation.allow.get(sourceExpertId);
  if (allowed === undefined || allowed.size === 0) return undefined;

  const experts = [team.coordinator, ...team.members].filter((expert) => allowed.has(expert.id));
  if (experts.length === 0) return undefined;

  return createDelegationTool({
    experts,
    context: team.delegation.context,
    maxConcurrency: team.delegation.maxConcurrency,
    maxDepth: team.delegation.maxDepth,
    description: `Delegate a focused task to an Expert in team ${team.name}.`,
  });
}

export function readAgentDelegationDefinition(
  tool: ExpertAgentManagedTool<string, ExpertAgentToolCallResult>,
): AgentDelegationDefinition | undefined {
  return (tool as Partial<AgentDelegationTool>)[agentDelegationDefinition];
}

export function isAgentDelegationTool(
  tool: ExpertAgentManagedTool<string, ExpertAgentToolCallResult>,
): boolean {
  return readAgentDelegationDefinition(tool) !== undefined;
}

function createDelegationTool(
  options: AgentDelegationDefinition & { readonly description: string },
): AgentDelegationTool {
  const definition = Object.freeze({
    experts: Object.freeze([...options.experts]),
    context: options.context,
    maxConcurrency: options.maxConcurrency,
    maxDepth: options.maxDepth,
  });
  const tool: AgentDelegationTool = {
    [agentDelegationDefinition]: definition,
    name: "delegate_expert",
    description: [
      options.description,
      "Available Experts:",
      ...definition.experts.map(
        (expert) => `- ${expert.id}: ${expert.name}. ${expert.description}`,
      ),
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        expertId: { type: "string" },
        prompt: { type: "string" },
        context: { type: "string", enum: ["fresh", "reuse"] },
        runtime: { type: "string" },
      },
      required: ["expertId", "prompt"],
      additionalProperties: false,
    },
    async call(args, signal, context) {
      if (signal?.aborted) return failure("delegation_cancelled", "Delegation was cancelled.");
      const execution = context?.execution;
      if (execution?.delegate === undefined) {
        return failure(
          "missing_execution",
          "Delegation requires an active Expert delegation Turn.",
        );
      }
      const input = readInput(args);
      try {
        const result = await execution.delegate(input);
        return {
          text: formatOutput(result.output),
          details: { expertId: input.expertId, invocationId: result.invocationId },
        };
      } catch (error) {
        return failure("delegation_failed", error instanceof Error ? error.message : String(error));
      }
    },
  };
  return tool;
}

function readUniqueExperts(experts: readonly Expert[], owner: string): readonly Expert[] {
  const ids = experts.map((expert) => expert.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${owner} contains duplicate Expert ids.`);
  }
  return Object.freeze([...experts]);
}

function readContextPolicy(value: DelegationContextPolicy | undefined): DelegationContextPolicy {
  if (value === undefined) return "fresh";
  if (value !== "fresh" && value !== "reuse") {
    throw new Error('AgentLauncher context must be "fresh" or "reuse".');
  }
  return value;
}

function readPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`AgentLauncher ${field} must be a positive integer.`);
  }
  return value;
}

function readInput(value: unknown): {
  readonly expertId: string;
  readonly prompt: string;
  readonly context?: DelegationContextPolicy;
  readonly runtime?: string;
} {
  if (typeof value !== "object" || value === null)
    throw new Error("Delegation input must be an object.");
  const record = value as Record<string, unknown>;
  const expertId = readString(record["expertId"], "expertId");
  const prompt = readString(record["prompt"], "prompt");
  const policy = record["context"];
  if (policy !== undefined && policy !== "fresh" && policy !== "reuse") {
    throw new Error('Delegation context must be "fresh" or "reuse".');
  }
  const runtime = record["runtime"];
  if (runtime !== undefined && (typeof runtime !== "string" || runtime.trim() === "")) {
    throw new Error("Delegation runtime must be a non-empty string.");
  }
  return {
    expertId,
    prompt,
    ...(policy === undefined ? {} : { context: policy }),
    ...(runtime === undefined ? {} : { runtime }),
  };
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Delegation ${name} must be a non-empty string.`);
  }
  return value;
}

function failure(code: string, text: string): ExpertAgentToolCallResult {
  return { text, isError: true, details: { code } };
}

function formatOutput(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
}
