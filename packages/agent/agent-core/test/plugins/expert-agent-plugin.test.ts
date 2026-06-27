import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ExpertAgent } from "../../src/agent/expert-agent.ts";
import { ContextSystem, HOST_CONTEXT_NAMESPACE } from "../../src/context-system/context-system.ts";
import { createInMemoryContextStore } from "../../src/context-system/in-memory-context-store.ts";
import { createLoggerProvider } from "../../src/logging/logger.ts";
import type { ExpertAgentLogRecord } from "../../src/logging/logger.ts";
import { extensibilityPlugin } from "../../src/plugins/fixtures/extensibility-plugin/src/plugin.ts";
import { createInvalidPlugin } from "../../src/plugins/fixtures/invalid-plugin/src/plugin.ts";
import { createMissingManifestPlugin } from "../../src/plugins/fixtures/missing-manifest-plugin/src/plugin.ts";
import {
  createExpertAgentPluginConfigEnvName,
  dispatchExpertAgentHook,
  resolveExpertAgentPlugins,
} from "../../src/plugins/expert-agent-plugin.ts";

const contextPluginPath = fileURLToPath(
  new URL("../../src/plugins/fixtures/context-plugin", import.meta.url),
);
const extensibilityPluginPath = fileURLToPath(
  new URL("../../src/plugins/fixtures/extensibility-plugin", import.meta.url),
);
const otherContextPluginPath = fileURLToPath(
  new URL("../../src/plugins/fixtures/other-context-plugin", import.meta.url),
);
const tempWorkspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempWorkspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

describe("ExpertAgent plugins", () => {
  it("loads immutable plugin metadata and manifest fields from plugin.json", () => {
    expect(extensibilityPlugin).toMatchObject({
      id: "plugin.extensibility",
      name: "Extensibility",
      description: "Contributes every plugin surface",
      version: "0.0.0",
      tags: ["fixture", "extensibility"],
      manifest: {
        schemaVersion: "expertmesh.plugin/v1",
        capabilities: [
          {
            type: "managed-tool",
            name: "plugin_tool",
            description: "Plugin tool",
          },
        ],
        configuration: {
          properties: [],
        },
        permissions: {
          network: ["models.example.test"],
        },
      },
    });
    expect(Object.isFrozen(extensibilityPlugin.manifest)).toBe(true);
    expect(Object.isFrozen(extensibilityPlugin.manifest.capabilities)).toBe(true);
    expect(Object.isFrozen(extensibilityPlugin.manifest.configuration.properties)).toBe(true);
  });

  it("rejects plugins without a plugin.json manifest", () => {
    expect(() => createMissingManifestPlugin()).toThrow(/plugin\.json was not found/);
  });

  it("rejects plugins with an invalid plugin.json manifest", () => {
    expect(() => createInvalidPlugin()).toThrow();
  });

  it("rejects plugin ids that collide with reserved context namespaces", () => {
    expect(() =>
      resolveExpertAgentPlugins({
        pluginEntries: [
          {
            id: "host",
            name: "Reserved Host",
            description: "Attempts to collide with host context namespace.",
            manifest: {
              schemaVersion: "expertmesh.plugin/v1",
              id: "host",
              name: "Reserved Host",
              description: "Attempts to collide with host context namespace.",
              runtime: {
                type: "node",
                entry: "./plugin.ts",
              },
              capabilities: [],
              configuration: { properties: [] },
              required_config: [],
            },
            setup: () => ({}),
          },
        ],
      }),
    ).toThrow(/reserved/);
  });

  it("passes a plugin scoped logger into plugin setup", () => {
    const records: ExpertAgentLogRecord[] = [];

    resolveExpertAgentPlugins({
      agentId: "agent-1",
      loggerProvider: createLoggerProvider((record) => {
        records.push(record);
      }),
      pluginEntries: [
        {
          id: "plugin.logger",
          name: "Logger",
          description: "Tests plugin logging.",
          manifest: {
            schemaVersion: "expertmesh.plugin/v1",
            id: "plugin.logger",
            name: "Logger",
            description: "Tests plugin logging.",
            runtime: {
              type: "node",
              entry: "./plugin.ts",
            },
            capabilities: [],
            configuration: { properties: [] },
            required_config: [],
          },
          setup: ({ logger }) => {
            logger.info("Plugin setup logged", { phase: "setup" });
            return {};
          },
        },
      ],
    });

    expect(records).toMatchObject([
      {
        level: "info",
        message: "Plugin setup logged",
        scope: {
          component: "plugin",
          agentId: "agent-1",
          pluginId: "plugin.logger",
        },
        context: {
          phase: "setup",
        },
      },
    ]);
  });

  it("merges plugin context with host context", async () => {
    const workspace = await createPluginTestWorkspace();
    const contextSystem = new ContextSystem();
    contextSystem.register({
      namespace: HOST_CONTEXT_NAMESPACE,
      store: createInMemoryContextStore({
        context: [
          {
            id: "host.md",
            content: "Host content",
            metadata: {
              description: "Host context",
              trigger: "always_on",
            },
          },
        ],
      }),
    });
    const agent = await ExpertAgent.create({
      schemaVersion: "expertmesh.expert/v1",
      id: "researcher",
      displayName: "Researcher",
      description: "Research expert",
      tags: ["research"],
      version: "0.0.0",
      scope: "workspace",
      workspace,
      contextSystem,
      plugins: [contextPluginPath, otherContextPluginPath],
    });

    await expect(agent.listContext()).resolves.toMatchObject({
      ok: true,
      value: [
        {
          namespace: "host",
          id: "host.md",
          metadata: {
            description: "Host context",
            trigger: "always_on",
          },
        },
        {
          namespace: "plugin.context",
          id: "plugin.md",
          metadata: {
            description: "Plugin context",
            trigger: "model_decision",
          },
        },
        {
          namespace: "plugin.context.extra",
          id: "extra.md",
          metadata: {
            description: "Extra plugin context",
            trigger: "model_decision",
          },
        },
        {
          namespace: "plugin.other-context",
          id: "plugin.md",
          metadata: {
            description: "Other plugin context",
            trigger: "model_decision",
          },
        },
      ],
    });
    await expect(
      agent.readContext({ namespace: "plugin.context", id: "plugin.md" }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        namespace: "plugin.context",
        id: "plugin.md",
        content: "Plugin content",
      },
    });
    await expect(
      agent.readContext({ namespace: "plugin.context.extra", id: "extra.md" }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        namespace: "plugin.context.extra",
        id: "extra.md",
        content: "Extra plugin content",
      },
    });
    await expect(
      agent.readContext({ namespace: "plugin.other-context", id: "plugin.md" }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        namespace: "plugin.other-context",
        id: "plugin.md",
        content: "Other plugin content",
      },
    });
  });

  it("passes config to source dependency plugin entries", async () => {
    const receivedConfigs: unknown[] = [];
    const workspace = await createPluginTestWorkspace();
    await ExpertAgent.create({
      schemaVersion: "expertmesh.expert/v1",
      id: "configured-agent",
      displayName: "Configured Agent",
      description: "Agent with configured plugin entries.",
      tags: ["test"],
      version: "0.0.0",
      scope: "workspace",
      workspace,
      plugins: [
        {
          entry: {
            id: "plugin.configured-entry",
            name: "Configured Entry",
            description: "Receives source dependency config.",
            manifest: {
              schemaVersion: "expertmesh.plugin/v1",
              id: "plugin.configured-entry",
              name: "Configured Entry",
              description: "Receives source dependency config.",
              runtime: {
                type: "node",
                entry: "./plugin.ts",
              },
              capabilities: [],
              configuration: { properties: [] },
              required_config: [],
            },
            setup: (context) => {
              receivedConfigs.push(context.config);
              return {};
            },
          },
          config: {
            enabled: false,
          },
        },
      ],
    });

    expect(receivedConfigs).toEqual([{ enabled: false }]);
  });

  it("creates plugin config env names from plugin id and config name", () => {
    expect(
      createExpertAgentPluginConfigEnvName({
        pluginId: "code-repository-manager",
        name: "auth.token",
      }),
    ).toBe("EXPERTMESH_PLUGIN_CODE_REPOSITORY_MANAGER_AUTH_TOKEN");
  });

  it("merges required plugin config from env before explicit config", () => {
    const receivedConfigs: unknown[] = [];
    resolveExpertAgentPlugins({
      env: {
        EXPERTMESH_PLUGIN_CONFIGURED_ENTRY_API_TOKEN: "env-token",
        EXPERTMESH_PLUGIN_CONFIGURED_ENTRY_NESTED_SECRET: "env-secret",
      },
      pluginEntries: [
        {
          entry: {
            id: "configured-entry",
            name: "Configured Entry",
            description: "Receives merged config.",
            manifest: {
              schemaVersion: "expertmesh.plugin/v1",
              id: "configured-entry",
              name: "Configured Entry",
              description: "Receives merged config.",
              runtime: {
                type: "node",
                entry: "./plugin.ts",
              },
              capabilities: [],
              configuration: { properties: [] },
              required_config: [
                { name: "apiToken", secret: false },
                { name: "nested.secret", secret: false },
              ],
            },
            setup: (context) => {
              receivedConfigs.push(context.config);
              return {};
            },
          },
          config: {
            apiToken: "explicit-token",
          },
        },
      ],
    });

    expect(receivedConfigs).toEqual([
      {
        apiToken: "explicit-token",
        nested: {
          secret: "env-secret",
        },
      },
    ]);
  });

  it("rejects plugins with missing required config", () => {
    expect(() =>
      resolveExpertAgentPlugins({
        env: {},
        pluginEntries: [
          {
            id: "missing-config",
            name: "Missing Config",
            description: "Requires config.",
            manifest: {
              schemaVersion: "expertmesh.plugin/v1",
              id: "missing-config",
              name: "Missing Config",
              description: "Requires config.",
              runtime: {
                type: "node",
                entry: "./plugin.ts",
              },
              capabilities: [],
              configuration: { properties: [] },
              required_config: [{ name: "apiToken", secret: false }],
            },
            setup: () => ({}),
          },
        ],
      }),
    ).toThrow(/apiToken \(EXPERTMESH_PLUGIN_MISSING_CONFIG_API_TOKEN\)/);
  });

  it("merges plugin mcp, skills, models, subagents, tools, and hooks", async () => {
    const hookEvents: string[] = [];
    const workspace = await createPluginTestWorkspace();
    const agent = await ExpertAgent.create({
      schemaVersion: "expertmesh.expert/v1",
      id: "researcher",
      displayName: "Researcher",
      description: "Research expert",
      tags: ["research"],
      version: "0.0.0",
      scope: "workspace",
      workspace,
      hooks: {
        beforeSessionCreate: () => {
          hookEvents.push("host");
        },
      },
      plugins: [extensibilityPluginPath],
    });

    expect(agent.mcp?.mcpServers.pluginMcp?.name).toBe("Plugin MCP");
    expect(agent.skills?.skills.map((skill) => skill.name)).toEqual(["plugin-skill"]);
    expect(agent.models?.defaultModelName).toBe("plugin-model");
    expect(agent.models?.providers.map((provider) => provider.provider)).toEqual([
      "plugin-provider",
    ]);
    expect(agent.subAgents?.agents.map((subAgent) => subAgent.agentType)).toEqual(["critic"]);
    expect(agent.tools?.map((tool) => tool.name)).toEqual(["plugin_tool"]);

    await dispatchExpertAgentHook(agent.hooks, "beforeSessionCreate", {
      agent,
      context: {},
      systemSessionId: "system-session-1",
    });

    expect(agent.hooks?.beforeSessionCreate).toBeDefined();
    expect(hookEvents).toEqual(["host"]);
  });

  it("merges repeated tool approval policies", async () => {
    const requiresDangerousCommandApproval = ({ input }: { readonly input: unknown }) =>
      typeof input === "object" &&
      input !== null &&
      "command" in input &&
      typeof input.command === "string" &&
      /\brm\b/.test(input.command);
    const resolved = resolveExpertAgentPlugins({
      pluginEntries: [
        {
          id: "plugin.approval-a",
          name: "Approval A",
          description: "Approval policy A.",
          manifest: {
            schemaVersion: "expertmesh.plugin/v1",
            id: "plugin.approval-a",
            name: "Approval A",
            description: "Approval policy A.",
            runtime: {
              type: "node",
              entry: "./plugin.ts",
            },
            capabilities: [],
            configuration: { properties: [] },
            required_config: [],
          },
          setup: () => ({
            toolApprovals: [
              {
                toolName: "bash",
                approval: {
                  mode: "ask",
                  reason: "Shell command needs review.",
                },
              },
            ],
          }),
        },
        {
          id: "plugin.approval-b",
          name: "Approval B",
          description: "Approval policy B.",
          manifest: {
            schemaVersion: "expertmesh.plugin/v1",
            id: "plugin.approval-b",
            name: "Approval B",
            description: "Approval policy B.",
            runtime: {
              type: "node",
              entry: "./plugin.ts",
            },
            capabilities: [],
            configuration: { properties: [] },
            required_config: [],
          },
          setup: () => ({
            toolApprovals: [
              {
                toolName: "bash",
                approval: {
                  mode: "required",
                  reason: "Dangerous command needs approval.",
                  when: requiresDangerousCommandApproval,
                },
              },
            ],
          }),
        },
      ],
    });

    expect(resolved.toolApprovals).toHaveLength(1);
    expect(resolved.toolApprovals?.[0]?.approval.mode).toBe("required");
    expect(resolved.toolApprovals?.[0]?.approval.reason).toBe(
      "Shell command needs review.\nDangerous command needs approval.",
    );
    await expect(
      Promise.resolve(
        resolved.toolApprovals?.[0]?.approval.when?.({
          kind: "tool_approval",
          toolName: "bash",
          input: { command: "rm -rf tmp" },
          reason: resolved.toolApprovals[0]?.approval.reason,
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      Promise.resolve(
        resolved.toolApprovals?.[0]?.approval.when?.({
          kind: "tool_approval",
          toolName: "bash",
          input: { command: "ls -la" },
          reason: resolved.toolApprovals[0]?.approval.reason,
        }),
      ),
    ).resolves.toBe(false);
  });
});

async function createPluginTestWorkspace(): Promise<string> {
  const workspace = await mkdtemp(resolve(process.cwd(), ".expertmesh-plugin-test-"));
  tempWorkspaces.push(workspace);
  return workspace;
}
