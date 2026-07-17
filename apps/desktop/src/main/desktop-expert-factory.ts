import { join } from "node:path";

import {
  defineExpert,
  Expert,
  createCodeServiceMcpServer,
  createHttpServiceMcpServer,
  createMcpToolRegistry,
  type DefineExpertOptions,
  type IExpertAgentMcpConfig,
  type IExpertAgentMcpServer,
  type IExpertAgentSkillsConfig,
} from "@pragma/core";

import type { CapabilityDefinition, ExpertDefinition } from "../shared/desktop-api.ts";
import type { CapabilityCredentialStore } from "./capability-credential-store.ts";
import type { CapabilityStore } from "./capability-store.ts";
import { hashSchema, toCoreMcpServer } from "./capability-verifier.ts";

export interface ResolvedExpertCapabilities {
  readonly skills: IExpertAgentSkillsConfig | undefined;
  readonly mcp: IExpertAgentMcpConfig | undefined;
}

export class ExpertCapabilityResolutionError extends Error {
  constructor(
    readonly code:
      | "capability_unavailable"
      | "capability_kind_mismatch"
      | "capability_drift"
      | "tool_unavailable"
      | "credential_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ExpertCapabilityResolutionError";
  }
}

export async function resolveExpertCapabilities(options: {
  readonly expert: Pick<ExpertDefinition, "capabilities" | "toolApprovals">;
  readonly store: CapabilityStore;
  readonly credentials: CapabilityCredentialStore;
  readonly capabilitiesPath: string;
}): Promise<ResolvedExpertCapabilities> {
  const skills: NonNullable<IExpertAgentSkillsConfig["skills"]>[number][] = [];
  const mcpServers: Record<string, IExpertAgentMcpServer> = {};

  for (const reference of options.expert.capabilities) {
    const capability = await options.store.get(reference.capabilityId, reference.revision);
    if (
      capability.health.revision === reference.revision &&
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
      skills.push({
        type: "local",
        name: capability.definition.name,
        description: capability.definition.description,
        path: join(
          options.capabilitiesPath,
          capability.manifest.id,
          "revisions",
          revisionDirectory(reference.revision),
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
        );
      });
      await assertMcpContract(server, capability.definition, reference.toolNames);
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

export async function createDesktopExpertAgent(options: {
  readonly definition: ExpertDefinition;
  readonly workspace: string;
  readonly store: CapabilityStore;
  readonly credentials: CapabilityCredentialStore;
  readonly capabilitiesPath: string;
  readonly overrides?: Pick<
    DefineExpertOptions,
    "models" | "contextSystem" | "loggerProvider" | "tools"
  >;
}): Promise<Expert> {
  const resolved = await resolveExpertCapabilities({
    expert: options.definition,
    store: options.store,
    credentials: options.credentials,
    capabilitiesPath: options.capabilitiesPath,
  });
  return await defineExpert({
    schemaVersion: "pragma.expert/v1",
    id: options.definition.id,
    name: options.definition.name,
    description: options.definition.description,
    tags: options.definition.tags,
    version: options.definition.version,
    scope: options.definition.scope,
    instructions: options.definition.instructions,
    workspace: options.workspace,
    skills: resolved.skills,
    mcp: resolved.mcp,
    plugins: options.definition.plugins.map((plugin) => ({
      source: plugin.source,
      ...(plugin.config === undefined ? {} : { config: plugin.config }),
    })),
    ...options.overrides,
  });
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

async function assertMcpContract(
  server: IExpertAgentMcpServer,
  definition: Extract<CapabilityDefinition, { readonly kind: "mcp_server" }>,
  selected: readonly string[],
): Promise<void> {
  const registry = await createMcpToolRegistry({ mcpServers: { verify: server } });
  try {
    for (const name of selected) {
      const current = registry.tools.find((tool) => tool.name === name);
      const pinned = definition.tools.find((tool) => tool.name === name);
      if (current === undefined || pinned === undefined) {
        throw new ExpertCapabilityResolutionError(
          "tool_unavailable",
          `MCP tool ${name} is not currently available.`,
        );
      }
      if (hashSchema(current.inputSchema) !== pinned.schemaHash) {
        throw new ExpertCapabilityResolutionError(
          "capability_drift",
          `MCP tool ${name} changed since this Expert pinned the capability revision.`,
        );
      }
    }
  } finally {
    await registry.dispose();
  }
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
      const mode = expert.toolApprovals[`mcp_${runtimeKey}_${sanitizeToolName(tool)}`] ?? "ask";
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
      const configured = expert.toolApprovals[`mcp_${runtimeKey}_${sanitizeToolName(tool.name)}`];
      const mode = configured ?? (tool.method === "POST" ? "required" : "ask");
      return [tool.name, { mode }];
    }),
  );
}

function sanitizeToolName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_") || "tool";
}

function revisionDirectory(revision: number): string {
  return revision.toString().padStart(6, "0");
}
