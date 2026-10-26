import { createTextToolResult } from "../tools/managed-tool.ts";
import type { Expert } from "./expert-agent.ts";
import type { ExpertTeam } from "./expert-team.ts";
import type { ExpertAgentManagedTool, ExpertAgentToolCallResult } from "../tools/managed-tool.ts";

export type RuntimeByExpert = Readonly<Record<string, string>>;

export interface CreateAgentLauncherOptions {
  readonly experts: readonly Expert[];
  readonly maxConcurrency?: number | undefined;
  readonly maxDepth?: number | undefined;
  readonly runtimeByExpert?: RuntimeByExpert | undefined;
}

export type ExpertLifecycleToolName =
  | "spawn_expert"
  | "continue_expert"
  | "wait_experts"
  | "list_agents"
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
  const experts = [team.coordinator, ...team.members];
  return createLifecycleTools({
    experts,
    spawnExpertIds,
    interactExpertIds,
    isCoordinator,
    maxConcurrency: team.delegation.maxConcurrency,
    maxDepth: team.delegation.maxDepth,
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
    runtimeByExpert: new Map(definition.runtimeByExpert),
  });
  const spawnable = [
    "Experts available for a fresh Context:",
    ...frozen.experts
      .filter((expert) => frozen.spawnExpertIds.has(expert.id))
      .map((expert) => `- ${expert.id}: ${expert.name}. ${expert.description}`),
  ].join("\n");
  const tool = (
    value: Omit<AgentLifecycleTool, typeof agentDelegationDefinition>,
  ): AgentLifecycleTool => ({
    ...value,
    approval: { mode: "none" },
    [agentDelegationDefinition]: frozen,
  });

  const tools: AgentLifecycleTool[] = [];
  if (frozen.spawnExpertIds.size > 0) {
    tools.push(
      tool({
        name: "spawn_expert",
        description: `Submit a new Expert task in a fresh, isolated Runtime Context. The returned queued status is an acceptance receipt, not a completion result. Save contextId for related follow-ups and call wait_experts with invocationId to inspect the task result before reporting success. Use continue_expert for related work that should retain prior context.\n${spawnable}`,
        inputSchema: objectSchema(
          {
            expertId: { type: "string" },
            task: { type: "string" },
          },
          ["expertId", "task"],
        ),
        call: async (args, signal, context) =>
          await invoke("spawn_expert", signal, context?.execution?.spawnExpert, readSpawn(args)),
      }),
    );
  }
  if (frozen.spawnExpertIds.size > 0 || frozen.interactExpertIds.size > 0) {
    tools.push(
      tool({
        name: "wait_experts",
        description:
          "Wait for exact Expert invocations created directly by this task. completed contains terminal tasks, including failures, cancellations, and interruptions; inspect each status, output, and error before reporting success. A timeout ends only this wait and never cancels pending work; call wait_experts again with pending invocation ids. Retry related work with continue_expert using its contextId. Defaults to all targets and a 10-minute timeout.",
        inputSchema: objectSchema(
          {
            invocationIds: { type: "array", items: { type: "string" }, minItems: 1 },
            returnWhen: optionalEnumSchema(
              ["all", "any"],
              "Optional completion condition. Omit or leave empty to wait for all.",
            ),
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
      description:
        "List the complete Expert directory and current or resumable Runtime Contexts in this Team Session. Visibility does not grant action permission; use each returned permission flag to choose spawn_expert, continue_expert, steer_expert, or interrupt_expert.",
      inputSchema: objectSchema(
        {
          expertId: {
            type: "string",
            description: "Optional Expert id filter. Omit or leave empty to include all Experts.",
          },
          status: optionalEnumSchema(
            ["running", "waiting", "queued", "idle", "resumable"],
            "Optional status filter. Omit or leave empty to include every status.",
          ),
          cursor: {
            type: "string",
            description:
              "Pagination cursor returned by a previous response. Omit or leave empty for the first page.",
          },
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
        name: "continue_expert",
        description:
          "Submit a new task in one exact existing Runtime Context for related follow-up work or retries. The queued receipt is not a completion result; call wait_experts with the NEW invocationId and inspect its result. A busy Context runs the task later in the same FIFO. Use steer_expert to correct the active Invocation instead of creating another task.",
        inputSchema: objectSchema(
          {
            contextId: { type: "string" },
            task: { type: "string" },
          },
          ["contextId", "task"],
        ),
        call: async (args, signal, context) =>
          await invoke(
            "continue_expert",
            signal,
            context?.execution?.continueExpert,
            readContinue(args),
          ),
      }),
    );
    tools.push(
      tool({
        name: "steer_expert",
        description:
          "Correct one exact active Expert Invocation without creating a new task. next_boundary requests native Runtime steering at its next supported boundary and fails with runtime_unsupported when unavailable. after_current queues guidance for a continuation after the current Runtime turn. An accepted steer is not task completion. Guidance stays in the targeted Invocation and never spills into a later one.",
        inputSchema: objectSchema(
          {
            invocationId: { type: "string" },
            instruction: { type: "string" },
            delivery: {
              type: "string",
              enum: ["next_boundary", "after_current"],
              description:
                "next_boundary steers the active Runtime turn at its next supported boundary; after_current waits for that turn to finish, then starts a queued continuation in the same Invocation.",
            },
          },
          ["invocationId", "instruction", "delivery"],
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
        description:
          "Stop one exact Expert Invocation when cancellation is intended, not merely because a wait timed out or activity is old. Active work becomes interrupted, queued work becomes cancelled, and terminal work returns already_terminal, which does not imply success. Its Runtime Context and other FIFO tasks are preserved.",
        inputSchema: objectSchema(
          {
            invocationId: { type: "string" },
            reason: { type: "string" },
          },
          ["invocationId"],
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
  const order: readonly ExpertLifecycleToolName[] = [
    "spawn_expert",
    "continue_expert",
    "list_agents",
    "wait_experts",
    "steer_expert",
    "interrupt_expert",
  ];
  return Object.freeze(
    tools.toSorted((left, right) => order.indexOf(left.name) - order.indexOf(right.name)),
  );
}

async function invoke<TInput>(
  name: ExpertLifecycleToolName,
  signal: AbortSignal | undefined,
  operation: ((input: TInput) => Promise<unknown>) | undefined,
  input: TInput,
): Promise<ExpertAgentToolCallResult> {
  if (signal?.aborted) return failure(`${name}_cancelled`, `${name} was cancelled.`);
  if (operation === undefined)
    return failure("missing_execution", `${name} requires an active Expert Turn.`);
  try {
    const result = projectLifecycleResult(name, await operation(input));
    return createTextToolResult(JSON.stringify(result), { details: result });
  } catch (error) {
    return failure(`${name}_failed`, error instanceof Error ? error.message : String(error));
  }
}

function projectLifecycleResult(
  name: ExpertLifecycleToolName,
  value: unknown,
): Record<string, unknown> {
  const result = withoutAgentMetadata(value);
  if (name === "wait_experts") {
    result["completed"] = (result["completed"] as unknown[]).map(withoutAgentMetadata);
    result["pending"] = (result["pending"] as unknown[]).map(withoutAgentMetadata);
  } else if (name === "list_agents") {
    result["contexts"] = (result["contexts"] as unknown[]).map(withoutAgentMetadata);
  }
  return { ...result, message: lifecycleMessage(name, result) };
}

function withoutAgentMetadata(value: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(readRecord(value)).filter(
      ([key]) => key !== "agentId" && key !== "agentDisposition",
    ),
  );
}

function lifecycleMessage(name: ExpertLifecycleToolName, result: Record<string, unknown>): string {
  switch (name) {
    case "spawn_expert":
      return "Task accepted and queued; this is not a completion result. Call wait_experts with invocationId and inspect the final status, output, and error before reporting success. Save contextId for related follow-ups.";
    case "continue_expert":
      return "New task accepted and queued in the existing Context; this is not a completion result. Call wait_experts with this NEW invocationId, not an earlier one. A busy Context runs this task later in its FIFO.";
    case "wait_experts": {
      const pending = (result["pending"] as unknown[]).length;
      const wake =
        result["wakeReason"] === "steer"
          ? "New guidance woke this wait; handle it first. "
          : result["wakeReason"] === "message"
            ? "New messages woke this wait; handle them first. "
            : "";
      const timeout =
        result["timedOut"] === true ? "This wait timed out; no task was cancelled. " : "";
      return pending > 0
        ? `${wake}${timeout}${pending} task(s) remain pending; inspect their status, waitReason, and latestActivity, then call wait_experts with their invocationIds to collect remaining results. A timeout or old/missing activity alone does not justify interrupting work. completed contains terminal tasks, not necessarily successful ones.`
        : `${wake}${timeout}All requested tasks are terminal. Inspect each status, output, and error before reporting success; completed can include failed, cancelled, or interrupted tasks.`;
    }
    case "list_agents":
      return "Use expertId to spawn fresh work, contextId to continue the exact related Context, and invocationId to steer or interrupt a task when permitted. Check task summaries and permission flags; visibility does not grant permission. wait_experts only accepts tasks created directly by your current task. Follow nextCursor when present.";
    case "steer_expert":
      return result["delivery"] === "after_current"
        ? "Guidance accepted for a continuation after the current Runtime turn; it has not necessarily been applied yet. The same Invocation continues; this is not task completion."
        : "Guidance dispatched to the active Invocation at a supported boundary; this is not task completion. Inspect its eventual result before reporting success.";
    case "interrupt_expert":
      return result["outcome"] === "already_terminal"
        ? "The task was already terminal; no new interruption was performed. This does not imply success. Its Runtime Context remains available for permitted follow-up work."
        : result["outcome"] === "cancelled"
          ? "The queued task was cancelled, not completed successfully. Its Runtime Context and other FIFO tasks are preserved; use continue_expert with contextId if a retry is needed."
          : "The active task was interrupted, not completed successfully. Its Runtime Context and other FIFO tasks are preserved; use continue_expert with contextId if a retry is needed.";
  }
}

function objectSchema(properties: Record<string, unknown>, required: readonly string[]): unknown {
  return { type: "object", properties, required, additionalProperties: false };
}

function optionalEnumSchema(values: readonly string[], description: string): unknown {
  return {
    anyOf: [
      { type: "string", enum: values },
      { type: "string", pattern: "^\\s*$" },
    ],
    description,
  };
}

function readSpawn(value: unknown): { expertId: string; task: string } {
  const record = readRecord(value);
  return {
    expertId: readString(record["expertId"], "expertId"),
    task: readString(record["task"], "task"),
  };
}

function readList(value: unknown): {
  expertId?: string;
  status?: "running" | "waiting" | "queued" | "idle" | "resumable";
  cursor?: string;
  limit?: number;
} {
  const record = readRecord(value);
  const status = readOptionalToken(record, "status");
  if (
    status !== undefined &&
    status !== "running" &&
    status !== "waiting" &&
    status !== "queued" &&
    status !== "idle" &&
    status !== "resumable"
  ) {
    throw new Error("status is invalid.");
  }
  return {
    ...readOptionalListString(record, "expertId"),
    ...(status === undefined ? {} : { status }),
    ...readOptionalListString(record, "cursor"),
    ...(record["limit"] === undefined ? {} : { limit: readInteger(record["limit"], "limit") }),
  };
}

function readOptionalListString(
  record: Record<string, unknown>,
  name: "expertId" | "cursor",
): Partial<Record<"expertId" | "cursor", string>> {
  const value = readOptionalToken(record, name);
  return value === undefined ? {} : { [name]: value };
}

function readSteer(value: unknown): {
  invocationId: string;
  instruction: string;
  delivery: "next_boundary" | "after_current";
} {
  const record = readRecord(value);
  const delivery = record["delivery"];
  if (delivery !== "next_boundary" && delivery !== "after_current") {
    throw new Error('delivery must be "next_boundary" or "after_current".');
  }
  return {
    invocationId: readString(record["invocationId"], "invocationId"),
    instruction: readString(record["instruction"], "instruction"),
    delivery,
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
  const returnWhen = readOptionalToken(record, "returnWhen");
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

function readContinue(value: unknown): {
  contextId: string;
  task: string;
} {
  const record = readRecord(value);
  return {
    contextId: readString(record["contextId"], "contextId"),
    task: readString(record["task"], "task"),
  };
}

function readInterrupt(value: unknown): {
  invocationId: string;
  reason?: string;
} {
  const record = readRecord(value);
  return {
    invocationId: readString(record["invocationId"], "invocationId"),
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
  const value = readOptionalToken(record, name);
  return value === undefined ? {} : { [name]: value };
}

function readOptionalToken(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  if (value === undefined || (typeof value === "string" && value.trim() === "")) return undefined;
  return readString(value, name);
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
  const payload = {
    ok: false as const,
    committed: false as const,
    code,
    error: { code, message: text },
  };
  return createTextToolResult(JSON.stringify(payload), { isError: true, details: payload });
}
