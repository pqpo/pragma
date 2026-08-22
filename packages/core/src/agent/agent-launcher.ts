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
  | "delegate_expert"
  | "wait_experts"
  | "list_agents"
  | "message_expert"
  | "steer_expert"
  | "interrupt_expert";

export interface AgentLauncher {
  readonly tools: readonly ExpertAgentManagedTool<
    ExpertLifecycleToolName,
    ExpertAgentToolCallResult
  >[];
}

export interface AgentDelegationDefinition {
  readonly experts: readonly Expert[];
  readonly spawnExpertIds: ReadonlySet<string>;
  readonly interactExpertIds: ReadonlySet<string>;
  readonly isCoordinator: boolean;
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
      spawnExpertIds: new Set(experts.map((expert) => expert.id)),
      interactExpertIds: new Set(),
      isCoordinator: false,
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
  const isCoordinator = sourceExpertId === team.coordinator.id;
  const spawnExpertIds = isCoordinator
    ? new Set(team.members.map((expert) => expert.id))
    : (team.delegation.permissions.spawn.get(sourceExpertId) ?? new Set<string>());
  const interactExpertIds = isCoordinator
    ? new Set([team.coordinator, ...team.members].map((expert) => expert.id))
    : (team.delegation.permissions.interact.get(sourceExpertId) ?? new Set<string>());
  const accessible = new Set([...spawnExpertIds, ...interactExpertIds]);
  const experts = [team.coordinator, ...team.members].filter(
    (expert) => expert.id !== sourceExpertId && accessible.has(expert.id),
  );
  return createLifecycleTools({
    experts,
    spawnExpertIds,
    interactExpertIds,
    isCoordinator,
    maxConcurrency: team.delegation.maxConcurrency,
    maxDepth: team.delegation.maxDepth,
    contextId: team.delegation.contextId,
    runtimeByExpert: new Map(
      [...team.delegation.runtimeByExpert].filter(([expertId]) => spawnExpertIds.has(expertId)),
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
    spawnExpertIds: new Set(definition.spawnExpertIds),
    interactExpertIds: new Set(definition.interactExpertIds),
    isCoordinator: definition.isCoordinator,
    maxConcurrency: definition.maxConcurrency,
    maxDepth: definition.maxDepth,
    contextId: definition.contextId,
    runtimeByExpert: new Map(definition.runtimeByExpert),
  });
  const delegatable = [
    "Delegatable Experts:",
    ...frozen.experts
      .filter((expert) => frozen.spawnExpertIds.has(expert.id))
      .map((expert) => `- ${expert.id}: ${expert.name}. ${expert.description}`),
  ].join("\n");
  const tool = (
    value: Omit<AgentLifecycleTool, typeof agentDelegationDefinition>,
  ): AgentLifecycleTool => ({ ...value, [agentDelegationDefinition]: frozen });

  const tools: AgentLifecycleTool[] = [];
  if (frozen.spawnExpertIds.size > 0 || frozen.interactExpertIds.size > 0) {
    tools.push(
      tool({
        name: "delegate_expert",
        description: `Delegate a trackable task to either a new Expert or an existing Agent and return its agent and invocation ids immediately. Provide exactly one of expertId or agentId.\n${delegatable}`,
        inputSchema: objectSchema(
          {
            expertId: { type: "string" },
            agentId: { type: "string" },
            task: { type: "string" },
          },
          ["task"],
        ),
        call: async (args, signal, context) =>
          await invoke(
            "delegate_expert",
            signal,
            context?.execution?.delegateExpert,
            readDelegate(args),
          ),
      }),
    );
  }
  if (frozen.spawnExpertIds.size > 0 || frozen.interactExpertIds.size > 0) {
    tools.push(
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
    );
  }
  tools.push(
    tool({
      name: "list_agents",
      description: "List accessible live Agent instances in this collaboration scope.",
      inputSchema: objectSchema(
        {
          expertId: { type: "string" },
          cursor: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
        [],
      ),
      call: async (args, signal, context) =>
        await invoke("list_agents", signal, context?.execution?.listAgents, readList(args)),
    }),
  );
  if (frozen.spawnExpertIds.size > 0 || frozen.interactExpertIds.size > 0) {
    tools.push(
      tool({
        name: "message_expert",
        description:
          "Queue a message for an existing Agent's exact active Invocation. The message is consumed at the next safe boundary and never spills into a later Invocation.",
        inputSchema: objectSchema(
          {
            agentId: { type: "string" },
            invocationId: { type: "string" },
            message: { type: "string" },
          },
          ["agentId", "invocationId", "message"],
        ),
        call: async (args, signal, context) =>
          await invoke(
            "message_expert",
            signal,
            context?.execution?.messageExpert,
            readMessage(args),
          ),
      }),
    );
    tools.push(
      tool({
        name: "steer_expert",
        description:
          "Immediately guide an existing Agent's exact active Invocation. Unsupported steering is rejected and never queued.",
        inputSchema: objectSchema(
          {
            agentId: { type: "string" },
            invocationId: { type: "string" },
            message: { type: "string" },
          },
          ["agentId", "invocationId", "message"],
        ),
        call: async (args, signal, context) =>
          await invoke("steer_expert", signal, context?.execution?.steerExpert, readSteer(args)),
      }),
    );
  }
  if (frozen.spawnExpertIds.size > 0) {
    tools.push(
      tool({
        name: "interrupt_expert",
        description: "Interrupt only the current task of an Expert while preserving queued tasks.",
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
    );
  }
  return Object.freeze(tools);
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

function readDelegate(
  value: unknown,
): { expertId: string; task: string } | { agentId: string; task: string } {
  const record = readRecord(value);
  const expertId = record["expertId"];
  const agentId = record["agentId"];
  if ((expertId === undefined) === (agentId === undefined)) {
    throw new Error("Exactly one of expertId or agentId is required.");
  }
  const task = readString(record["task"], "task");
  return expertId === undefined
    ? { agentId: readString(agentId, "agentId"), task }
    : { expertId: readString(expertId, "expertId"), task };
}

function readList(value: unknown): { expertId?: string; cursor?: string; limit?: number } {
  const record = readRecord(value);
  return {
    ...(record["expertId"] === undefined
      ? {}
      : { expertId: readString(record["expertId"], "expertId") }),
    ...(record["cursor"] === undefined ? {} : { cursor: readString(record["cursor"], "cursor") }),
    ...(record["limit"] === undefined ? {} : { limit: readInteger(record["limit"], "limit") }),
  };
}

function readSteer(value: unknown): {
  agentId: string;
  invocationId: string;
  message: string;
} {
  const record = readRecord(value);
  return {
    agentId: readString(record["agentId"], "agentId"),
    invocationId: readString(record["invocationId"], "invocationId"),
    message: readString(record["message"], "message"),
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

function readMessage(value: unknown): {
  agentId: string;
  invocationId: string;
  message: string;
} {
  const record = readRecord(value);
  return {
    agentId: readString(record["agentId"], "agentId"),
    invocationId: readString(record["invocationId"], "invocationId"),
    message: readString(record["message"], "message"),
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

function readInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer.`);
  return value as number;
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
