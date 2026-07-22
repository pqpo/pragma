import type { Expert } from "./expert-agent.ts";
import type { ExpertTeam } from "./expert-team.ts";
import {
  freshContextIdResolver,
  type ContextIdResolver,
} from "../execution/context-id-resolver.ts";
import type { ExpertAgentManagedTool, ExpertAgentToolCallResult } from "../tools/managed-tool.ts";

export type RuntimeByExpert = Readonly<Record<string, string>>;

export interface CreateAgentLauncherOptions {
  readonly experts: readonly Expert[];
  readonly maxConcurrency?: number | undefined;
  readonly maxDepth?: number | undefined;
  readonly contextId?: ContextIdResolver | undefined;
  readonly runtimeByExpert?: RuntimeByExpert | undefined;
}

export type ExpertLifecycleToolName =
  | "spawn_expert"
  | "wait_experts"
  | "list_experts"
  | "followup_expert"
  | "interrupt_expert";

export interface AgentLauncher {
  readonly tools: readonly ExpertAgentManagedTool<
    ExpertLifecycleToolName,
    ExpertAgentToolCallResult
  >[];
}

export interface AgentDelegationDefinition {
  readonly experts: readonly Expert[];
  readonly maxConcurrency: number;
  readonly maxDepth: number;
  readonly contextId: ContextIdResolver;
  readonly runtimeByExpert: ReadonlyMap<string, string>;
}

const agentDelegationDefinition = Symbol("pragma.agent-delegation-definition");

const MIN_WAIT_EXPERTS_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_EXPERTS_TIMEOUT_MS = 10 * 60_000;
const MAX_WAIT_EXPERTS_TIMEOUT_MS = 60 * 60_000;

type AgentLifecycleTool = ExpertAgentManagedTool<
  ExpertLifecycleToolName,
  ExpertAgentToolCallResult
> & {
  readonly [agentDelegationDefinition]: AgentDelegationDefinition;
};

export function createAgentLauncher(options: CreateAgentLauncherOptions): AgentLauncher {
  const experts = readUniqueExperts(options.experts, "AgentLauncher");
  if (experts.length === 0) throw new Error("AgentLauncher requires at least one Expert.");
  return Object.freeze({
    tools: createLifecycleTools({
      experts,
      maxConcurrency: readPositiveInteger(options.maxConcurrency ?? 4, "maxConcurrency"),
      maxDepth: readPositiveInteger(options.maxDepth ?? 3, "maxDepth"),
      contextId: options.contextId ?? freshContextIdResolver,
      runtimeByExpert: normalizeRuntimeByExpert(options.runtimeByExpert, experts, "AgentLauncher"),
    }),
  });
}

export function createTeamDelegationTools(
  team: ExpertTeam,
  sourceExpertId: string,
): readonly AgentLifecycleTool[] {
  const allowed = team.delegation.allow.get(sourceExpertId);
  if (allowed === undefined || allowed.size === 0) return [];
  const experts = [team.coordinator, ...team.members].filter((expert) => allowed.has(expert.id));
  if (experts.length === 0) return [];
  return createLifecycleTools({
    experts,
    maxConcurrency: team.delegation.maxConcurrency,
    maxDepth: team.delegation.maxDepth,
    contextId: team.delegation.contextId,
    runtimeByExpert: new Map(
      [...team.delegation.runtimeByExpert].filter(([expertId]) => allowed.has(expertId)),
    ),
  });
}

export function readAgentDelegationDefinition(
  tool: ExpertAgentManagedTool<string, ExpertAgentToolCallResult>,
): AgentDelegationDefinition | undefined {
  return (tool as Partial<AgentLifecycleTool>)[agentDelegationDefinition];
}

export function isAgentDelegationTool(
  tool: ExpertAgentManagedTool<string, ExpertAgentToolCallResult>,
): boolean {
  return readAgentDelegationDefinition(tool) !== undefined;
}

function createLifecycleTools(
  definition: AgentDelegationDefinition,
): readonly AgentLifecycleTool[] {
  const frozen = Object.freeze({
    experts: Object.freeze([...definition.experts]),
    maxConcurrency: definition.maxConcurrency,
    maxDepth: definition.maxDepth,
    contextId: definition.contextId,
    runtimeByExpert: new Map(definition.runtimeByExpert),
  });
  const available = [
    "Available Experts:",
    ...frozen.experts.map((expert) => `- ${expert.id}: ${expert.name}. ${expert.description}`),
  ].join("\n");
  const tool = (
    value: Omit<AgentLifecycleTool, typeof agentDelegationDefinition>,
  ): AgentLifecycleTool => ({ ...value, [agentDelegationDefinition]: frozen });

  return Object.freeze([
    tool({
      name: "spawn_expert",
      description: `Spawn an Expert task in the background and return its agent and invocation ids immediately.\n${available}`,
      inputSchema: objectSchema({ expertId: { type: "string" }, prompt: { type: "string" } }, [
        "expertId",
        "prompt",
      ]),
      call: async (args, signal, context) =>
        await invoke("spawn_expert", signal, context?.execution?.spawnExpert, readSpawn(args)),
    }),
    tool({
      name: "wait_experts",
      description:
        "Wait for exact Expert invocations. Defaults to waiting for all targets with a 10-minute timeout.",
      inputSchema: objectSchema(
        {
          invocationIds: { type: "array", items: { type: "string" }, minItems: 1 },
          returnWhen: { type: "string", enum: ["all", "any"] },
          timeoutMs: {
            type: "integer",
            minimum: MIN_WAIT_EXPERTS_TIMEOUT_MS,
            maximum: MAX_WAIT_EXPERTS_TIMEOUT_MS,
            default: DEFAULT_WAIT_EXPERTS_TIMEOUT_MS,
          },
        },
        ["invocationIds"],
      ),
      call: async (args, signal, context) => {
        const input = readWait(args);
        return await invoke("wait_experts", signal, context?.execution?.waitExperts, {
          ...input,
          signal,
        });
      },
    }),
    tool({
      name: "list_experts",
      description: "List the Expert instances directly spawned by this caller.",
      inputSchema: objectSchema({}, []),
      call: async (_args, signal, context) =>
        await invoke("list_experts", signal, context?.execution?.listExperts, undefined),
    }),
    tool({
      name: "followup_expert",
      description: "Queue a new FIFO task on an existing Expert instance.",
      inputSchema: objectSchema({ agentId: { type: "string" }, prompt: { type: "string" } }, [
        "agentId",
        "prompt",
      ]),
      call: async (args, signal, context) =>
        await invoke(
          "followup_expert",
          signal,
          context?.execution?.followupExpert,
          readFollowup(args),
        ),
    }),
    tool({
      name: "interrupt_expert",
      description:
        "Interrupt only the current task of an Expert while preserving queued follow-ups.",
      inputSchema: objectSchema(
        {
          agentId: { type: "string" },
          invocationId: { type: "string" },
          reason: { type: "string" },
        },
        ["agentId"],
      ),
      call: async (args, signal, context) =>
        await invoke(
          "interrupt_expert",
          signal,
          context?.execution?.interruptExpert,
          readInterrupt(args),
        ),
    }),
  ]);
}

async function invoke<TInput>(
  name: string,
  signal: AbortSignal | undefined,
  operation: ((input: TInput) => Promise<unknown>) | undefined,
  input: TInput,
): Promise<ExpertAgentToolCallResult> {
  if (signal?.aborted) return failure(`${name}_cancelled`, `${name} was cancelled.`);
  if (operation === undefined)
    return failure("missing_execution", `${name} requires an active Expert Turn.`);
  try {
    const details = await operation(input);
    return { text: JSON.stringify(details, null, 2), details };
  } catch (error) {
    return failure(`${name}_failed`, error instanceof Error ? error.message : String(error));
  }
}

function objectSchema(properties: Record<string, unknown>, required: readonly string[]): unknown {
  return { type: "object", properties, required, additionalProperties: false };
}

function readSpawn(value: unknown): { expertId: string; prompt: string } {
  const record = readRecord(value);
  return {
    expertId: readString(record["expertId"], "expertId"),
    prompt: readString(record["prompt"], "prompt"),
  };
}

function readWait(value: unknown): {
  invocationIds: readonly string[];
  returnWhen?: "all" | "any";
  timeoutMs: number;
} {
  const record = readRecord(value);
  const ids = record["invocationIds"];
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("invocationIds must be non-empty.");
  const invocationIds = ids.map((id) => readString(id, "invocationIds"));
  if (new Set(invocationIds).size !== invocationIds.length) {
    throw new Error("invocationIds must not contain duplicates.");
  }
  const returnWhen = record["returnWhen"];
  if (returnWhen !== undefined && returnWhen !== "all" && returnWhen !== "any") {
    throw new Error('returnWhen must be "all" or "any".');
  }
  const timeoutMs = record["timeoutMs"] ?? DEFAULT_WAIT_EXPERTS_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    (timeoutMs as number) < MIN_WAIT_EXPERTS_TIMEOUT_MS ||
    (timeoutMs as number) > MAX_WAIT_EXPERTS_TIMEOUT_MS
  ) {
    throw new Error(
      `timeoutMs must be an integer between ${MIN_WAIT_EXPERTS_TIMEOUT_MS} and ${MAX_WAIT_EXPERTS_TIMEOUT_MS}.`,
    );
  }
  return {
    invocationIds,
    ...(returnWhen === undefined ? {} : { returnWhen }),
    timeoutMs: timeoutMs as number,
  };
}

function readFollowup(value: unknown): { agentId: string; prompt: string } {
  const record = readRecord(value);
  return {
    agentId: readString(record["agentId"], "agentId"),
    prompt: readString(record["prompt"], "prompt"),
  };
}

function readInterrupt(value: unknown): {
  agentId: string;
  invocationId?: string;
  reason?: string;
} {
  const record = readRecord(value);
  return {
    agentId: readString(record["agentId"], "agentId"),
    ...readOptionalString(record, "invocationId"),
    ...readOptionalString(record, "reason"),
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expert tool input must be an object.");
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, name: string): Record<string, string> {
  const value = record[name];
  return value === undefined ? {} : { [name]: readString(value, name) };
}

function readUniqueExperts(experts: readonly Expert[], owner: string): readonly Expert[] {
  const ids = experts.map((expert) => expert.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${owner} contains duplicate Expert ids.`);
  return Object.freeze([...experts]);
}

export function normalizeRuntimeByExpert(
  runtimeByExpert: RuntimeByExpert | undefined,
  experts: readonly Pick<Expert, "id">[],
  owner: string,
): ReadonlyMap<string, string> {
  const knownExpertIds = new Set(experts.map((expert) => expert.id));
  const normalized = new Map<string, string>();
  for (const [expertId, runtimeId] of Object.entries(runtimeByExpert ?? {})) {
    if (!knownExpertIds.has(expertId)) {
      throw new Error(`${owner} runtimeByExpert target is unknown: ${expertId}`);
    }
    if (runtimeId.trim() === "") {
      throw new Error(`${owner} runtimeByExpert value must not be empty: ${expertId}`);
    }
    normalized.set(expertId, runtimeId);
  }
  return normalized;
}

function readPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`AgentLauncher ${field} must be a positive integer.`);
  }
  return value;
}

function failure(code: string, text: string): ExpertAgentToolCallResult {
  return { text, isError: true, details: { code } };
}
