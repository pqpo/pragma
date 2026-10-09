import { builtInSkill, materializeBuiltInAgentBundle } from "@pragma/built-in-agents";
import { dirname } from "node:path";
import { join } from "node:path";
import {
  createCodeServiceMcpServer,
  createHttpServiceMcpServer,
  createMcpToolRegistryPool,
  sanitizeExecutionToolName,
  type IExpertAgentMcpConfig,
  type IExpertAgentMcpServer,
  type IExpertAgentSkillsConfig,
  type McpToolRegistryPool,
} from "@pragma/core";
import type { CapabilityDefinition, ExpertCapabilityReference } from "@pragma/shared";
import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import type { createLocalHostCapabilityReader } from "./capability-reader.ts";
type CapabilityStore = Pick<ReturnType<typeof createLocalHostCapabilityReader>, "resolveActive">;
interface ExpertDefinition {
  readonly capabilities: readonly ExpertCapabilityReference[];
  readonly toolApprovals: Readonly<Record<string, "none" | "ask" | "required">>;
}
import { classifyMcpError, toCoreMcpServer } from "./capability-runtime.ts";

export interface ResolvedExpertCapabilities {
  readonly skills: IExpertAgentSkillsConfig | undefined;
  readonly mcp: IExpertAgentMcpConfig | undefined;
}

export class ExpertCapabilityResolutionError extends Error {
  constructor(
    readonly code:
      | "capability_unavailable"
      | "capability_kind_mismatch"
      | "tool_unavailable"
      | "credential_unavailable",
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExpertCapabilityResolutionError";
  }
}

interface McpAvailabilityRetryOptions {
  readonly maxAttempts?: number | undefined;
  readonly baseDelayMs?: number | undefined;
  readonly maxDelayMs?: number | undefined;
  readonly random?: (() => number) | undefined;
  readonly sleep?: ((delayMs: number) => Promise<void>) | undefined;
  readonly mcpToolRegistryPool?: McpToolRegistryPool | undefined;
}

class McpAvailabilityCheckError extends Error {
  constructor(
    readonly diagnostic: ReturnType<typeof classifyMcpError>,
    readonly attempts: number,
    readonly transient: boolean,
    options: ErrorOptions,
  ) {
    super(
      `MCP availability check failed after ${attempts} ${attempts === 1 ? "attempt" : "attempts"} (${diagnostic.code}): ${diagnostic.message}`,
      options,
    );
    this.name = "McpAvailabilityCheckError";
  }
}

export async function resolveExpertCapabilities(options: {
  readonly expert: Pick<ExpertDefinition, "capabilities" | "toolApprovals">;
  readonly store: CapabilityStore;
  readonly credentials: CapabilityCredentialStore;
  readonly capabilitiesPath: string;
  readonly mcpToolRegistryPool?: McpToolRegistryPool | undefined;
}): Promise<ResolvedExpertCapabilities> {
  const skills: NonNullable<IExpertAgentSkillsConfig["skills"]>[number][] = [];
  const mcpServers: Record<string, IExpertAgentMcpServer> = {};

  for (const reference of options.expert.capabilities) {
    const capability = await options.store.resolveActive(reference.capabilityId);
    const resolvedRevision = capability.manifest.latestRevision;
    if (
      capability.health.revision === resolvedRevision &&
      capability.health.status === "needs_attention"
    ) {
      throw new ExpertCapabilityResolutionError(
        "capability_unavailable",
        `${capability.manifest.name} needs attention before this Expert can run.`,
      );
    }

    if (reference.kind === "skill") {
      if (capability.definition.kind !== "skill") {
        throw new ExpertCapabilityResolutionError(
          "capability_kind_mismatch",
          `${capability.manifest.name} is not a Skill.`,
        );
      }
      const builtin = builtInSkill(reference.capabilityId);
      const builtinRoot =
        builtin === undefined
          ? undefined
          : dirname(
              await materializeBuiltInAgentBundle(
                join(options.capabilitiesPath, "..", "..", "cache", "built-in-agents"),
              ),
            );
      skills.push({
        type: "local",
        name: capability.definition.name,
        description: capability.definition.description,
        path:
          builtinRoot !== undefined && builtin !== undefined
            ? join(builtinRoot, builtin.path, "SKILL.md")
            : join(
                options.capabilitiesPath,
                capability.manifest.id,
                "revisions",
                revisionDirectory(resolvedRevision),
                "payload",
                capability.definition.entryPath,
              ),
      });
      continue;
    }

    if (capability.definition.kind === "skill") {
      throw new ExpertCapabilityResolutionError(
        "capability_kind_mismatch",
        `${capability.manifest.name} does not expose tools.`,
      );
    }
    assertSelectedTools(capability.definition, reference.toolNames, capability.manifest.name);

    if (capability.definition.kind === "mcp_server") {
      const server = await toCoreMcpServer(
        capability.definition,
        capability.manifest.id,
        options.credentials,
        reference.toolNames,
      ).catch((error: unknown) => {
        throw new ExpertCapabilityResolutionError(
          "credential_unavailable",
          error instanceof Error ? error.message : "An MCP credential is unavailable.",
          false,
          { cause: error },
        );
      });
      try {
        await assertSelectedMcpToolsAvailable(server, reference.toolNames, {
          ...(options.mcpToolRegistryPool === undefined
            ? {}
            : { mcpToolRegistryPool: options.mcpToolRegistryPool }),
        });
      } catch (error) {
        if (error instanceof ExpertCapabilityResolutionError) throw error;
        if (!(error instanceof McpAvailabilityCheckError)) throw error;
        const guidance = error.transient
          ? "Check that the MCP service is running, then retry the Mission."
          : "Check the capability connection and credentials before retrying the Mission.";
        throw new ExpertCapabilityResolutionError(
          "capability_unavailable",
          `${capability.manifest.name} MCP capability is ${
            error.transient ? "temporarily unavailable" : "unavailable"
          } after ${error.attempts} ${
            error.attempts === 1 ? "availability check" : "availability checks"
          } (${error.diagnostic.code}: ${error.diagnostic.message}). ${guidance}`,
          error.diagnostic.retryable,
          { cause: error },
        );
      }
      mcpServers[capability.manifest.runtimeKey] = {
        ...server,
        toolApprovals: createApprovals(
          options.expert,
          capability.manifest.runtimeKey,
          reference.toolNames,
        ),
      };
      continue;
    }

    if (capability.definition.kind === "code_service") {
      mcpServers[capability.manifest.runtimeKey] = {
        name: capability.definition.name,
        transport: "in-process",
        timeout: capability.definition.timeoutMs,
        allowTools: reference.toolNames,
        toolApprovals: createApprovals(
          options.expert,
          capability.manifest.runtimeKey,
          reference.toolNames,
        ),
        inProcess: createCodeServiceMcpServer({
          name: capability.definition.name,
          timeoutMs: capability.definition.timeoutMs,
          tool: capability.definition.tool,
        }),
      };
      continue;
    }

    const selectedDefinitions = capability.definition.tools.filter((tool) =>
      reference.toolNames.includes(tool.name),
    );
    const auth = await resolveHttpAuth(
      capability.definition,
      capability.manifest.id,
      options.credentials,
    );
    mcpServers[capability.manifest.runtimeKey] = {
      name: capability.definition.name,
      transport: "in-process",
      timeout: capability.definition.timeoutMs,
      allowTools: reference.toolNames,
      toolApprovals: createHttpApprovals(
        options.expert,
        capability.manifest.runtimeKey,
        selectedDefinitions,
      ),
      inProcess: createHttpServiceMcpServer({
        name: capability.definition.name,
        baseUrl: capability.definition.baseUrl,
        auth,
        timeoutMs: capability.definition.timeoutMs,
        tools: selectedDefinitions,
      }),
    };
  }

  return {
    skills: skills.length === 0 ? undefined : { skills },
    mcp: Object.keys(mcpServers).length === 0 ? undefined : { mcpServers },
  };
}

function assertSelectedTools(
  definition: Exclude<CapabilityDefinition, { readonly kind: "skill" }>,
  selected: readonly string[],
  capabilityName: string,
): void {
  const available = new Set(
    definition.kind === "code_service"
      ? [definition.tool.name]
      : definition.tools.map((tool) => tool.name),
  );
  const missing = selected.filter((tool) => !available.has(tool));
  if (missing.length > 0) {
    throw new ExpertCapabilityResolutionError(
      "tool_unavailable",
      `${capabilityName} no longer contains: ${missing.join(", ")}.`,
    );
  }
}

export async function assertSelectedMcpToolsAvailable(
  server: IExpertAgentMcpServer,
  selected: readonly string[],
  retry: McpAvailabilityRetryOptions = {},
): Promise<void> {
  const maxAttempts = retry.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("MCP availability maxAttempts must be a positive integer.");
  }
  const baseDelayMs = retry.baseDelayMs ?? 200;
  const maxDelayMs = retry.maxDelayMs ?? 1_000;
  const random = retry.random ?? Math.random;
  const sleep = retry.sleep ?? wait;
  const ownsPool = retry.mcpToolRegistryPool === undefined;
  const pool =
    retry.mcpToolRegistryPool ??
    createMcpToolRegistryPool({
      idleTtlMs: 0,
      maxIdleEntries: 0,
    });

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const lease = await pool.acquire({ mcpServers: { verify: server } });
        try {
          for (const name of selected) {
            const current = lease.registry.tools.find((tool) => tool.name === name);
            if (current === undefined) {
              throw new ExpertCapabilityResolutionError(
                "tool_unavailable",
                `MCP tool ${name} is not currently available.`,
              );
            }
          }
        } finally {
          await lease.release();
        }
        return;
      } catch (error) {
        if (error instanceof ExpertCapabilityResolutionError) throw error;
        const diagnostic = classifyMcpError(error);
        const transient = isTransientMcpAvailabilityError(error, diagnostic);
        if (!transient || attempt === maxAttempts) {
          throw new McpAvailabilityCheckError(diagnostic, attempt, transient, { cause: error });
        }
        await sleep(retryDelayMs(attempt, baseDelayMs, maxDelayMs, random));
      }
    }
  } finally {
    if (ownsPool) await pool.close();
  }
}

function isTransientMcpAvailabilityError(
  error: unknown,
  diagnostic: ReturnType<typeof classifyMcpError>,
): boolean {
  if (diagnostic.code === "network" || diagnostic.code === "timeout") return true;
  if (diagnostic.code !== "process_exit") return false;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const record = current as { readonly code?: unknown; readonly cause?: unknown };
    if (record.code === "ENOENT") return false;
    current = record.cause;
  }
  return true;
}

function retryDelayMs(
  failedAttempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (failedAttempt - 1));
  return Math.round(exponential * (1 + Math.max(0, Math.min(1, random())) * 0.25));
}

async function wait(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function resolveHttpAuth(
  definition: Extract<CapabilityDefinition, { readonly kind: "http_service" }>,
  capabilityId: string,
  credentials: CapabilityCredentialStore,
) {
  if (definition.auth.type === "none") return { type: "none" as const };
  const value = await credentials.get(capabilityId, definition.auth.credentialRef);
  if (value === undefined) {
    throw new ExpertCapabilityResolutionError(
      "credential_unavailable",
      `Credential ${definition.auth.credentialRef} is not configured.`,
    );
  }
  return definition.auth.type === "bearer"
    ? { type: "bearer" as const, token: value }
    : { type: "api_key_header" as const, headerName: definition.auth.headerName, value };
}

function createApprovals(
  expert: Pick<ExpertDefinition, "toolApprovals">,
  runtimeKey: string,
  tools: readonly string[],
) {
  return Object.fromEntries(
    tools.map((tool) => {
      const mode =
        expert.toolApprovals[`mcp_${runtimeKey}_${sanitizeExecutionToolName(tool)}`] ?? "ask";
      return [tool, { mode }];
    }),
  );
}

function createHttpApprovals(
  expert: Pick<ExpertDefinition, "toolApprovals">,
  runtimeKey: string,
  tools: readonly { readonly name: string; readonly method: "GET" | "POST" }[],
) {
  return Object.fromEntries(
    tools.map((tool) => {
      const configured =
        expert.toolApprovals[`mcp_${runtimeKey}_${sanitizeExecutionToolName(tool.name)}`];
      const mode = configured ?? (tool.method === "POST" ? "required" : "ask");
      return [tool.name, { mode }];
    }),
  );
}

function revisionDirectory(revision: number): string {
  return revision.toString().padStart(6, "0");
}
