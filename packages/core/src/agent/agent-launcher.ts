import type { DelegationContextPolicy, ExpertTeam } from "./expert-team.ts";
import type { ExpertAgentManagedTool, ExpertAgentToolCallResult } from "../tools/managed-tool.ts";

export function createTeamDelegationTool(
  team: ExpertTeam,
): ExpertAgentManagedTool<"delegate_expert", ExpertAgentToolCallResult> {
  return {
    name: "delegate_expert",
    description: [
      `Delegate a focused task to an Expert in team ${team.name}.`,
      "Available Experts:",
      ...team.members.map((expert) => `- ${expert.id}: ${expert.name}. ${expert.description}`),
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
        return failure("missing_execution", "Delegation requires an active ExpertTeam Turn.");
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
