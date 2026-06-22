import { describe, expect, it } from "vitest";

import { ExpertAgent } from "../agent/expert-agent.ts";
import { createInMemoryDocumentStore } from "../documents/in-memory-document-store.ts";
import { definePluginEntry, dispatchExpertAgentHook } from "./expert-agent-plugin.ts";

describe("ExpertAgent plugins", () => {
  it("merges plugin documents with host documents", async () => {
    const agent = new ExpertAgent({
      schemaVersion: "expertmesh.expert/v1",
      id: "researcher",
      displayName: "Researcher",
      description: "Research expert",
      tags: ["research"],
      version: "0.0.0",
      scope: "workspace",
      workspace: "/tmp/expertmesh",
      documents: createInMemoryDocumentStore({
        documents: [
          {
            id: "host.md",
            content: "Host content",
            metadata: {
              description: "Host doc",
              trigger: "always_on",
            },
          },
        ],
      }),
      plugins: [
        definePluginEntry({
          id: "plugin.docs",
          name: "Plugin docs",
          description: "Adds documents",
          setup: () => ({
            documents: [
              {
                id: "plugin.md",
                content: "Plugin content",
                metadata: {
                  description: "Plugin doc",
                  trigger: "model_decision",
                },
              },
            ],
          }),
        }),
        definePluginEntry({
          id: "plugin.other-docs",
          name: "Other plugin docs",
          description: "Adds documents with colliding local ids",
          setup: () => ({
            documents: [
              {
                id: "plugin.md",
                content: "Other plugin content",
                metadata: {
                  description: "Other plugin doc",
                  trigger: "model_decision",
                },
              },
            ],
          }),
        }),
      ],
    });

    await expect(agent.listDocuments()).resolves.toMatchObject({
      ok: true,
      value: [
        {
          id: "host.md",
          metadata: {
            description: "Host doc",
            trigger: "always_on",
          },
        },
        {
          id: "plugin.docs/plugin.md",
          metadata: {
            description: "Plugin doc",
            trigger: "model_decision",
          },
        },
        {
          id: "plugin.other-docs/plugin.md",
          metadata: {
            description: "Other plugin doc",
            trigger: "model_decision",
          },
        },
      ],
    });
    await expect(agent.readDocument({ id: "plugin.docs/plugin.md" })).resolves.toMatchObject({
      ok: true,
      value: {
        id: "plugin.docs/plugin.md",
        content: "Plugin content",
      },
    });
    await expect(agent.readDocument({ id: "plugin.other-docs/plugin.md" })).resolves.toMatchObject({
      ok: true,
      value: {
        id: "plugin.other-docs/plugin.md",
        content: "Other plugin content",
      },
    });
  });

  it("merges plugin mcp, skills, models, subagents, tools, and hooks", async () => {
    const events: string[] = [];
    const plugin = definePluginEntry({
      id: "plugin.extensibility",
      name: "Extensibility",
      description: "Contributes every plugin surface",
      setup: () => ({
        mcp: {
          mcpServers: {
            pluginMcp: {
              name: "Plugin MCP",
              command: "plugin-mcp",
            },
          },
        },
        skills: {
          skills: [
            {
              type: "local",
              name: "plugin-skill",
              description: "Plugin skill",
            },
          ],
        },
        models: {
          defaultModelName: "plugin-model",
          providers: [
            {
              provider: "plugin-provider",
              modelNames: ["plugin-model"],
              baseApi: "https://models.example.test",
              key: "test-key",
            },
          ],
        },
        subAgents: {
          agents: [
            {
              agentType: "critic",
              whenToUse: "Review an answer",
              systemPrompt: "Be precise.",
            },
          ],
        },
        tools: [
          {
            name: "plugin_tool",
            description: "Plugin tool",
            inputSchema: {},
            call: async () => ({ text: "ok" }),
          },
        ],
        hooks: {
          beforeSessionCreate: () => {
            events.push("plugin");
          },
        },
      }),
    });

    const agent = new ExpertAgent({
      schemaVersion: "expertmesh.expert/v1",
      id: "researcher",
      displayName: "Researcher",
      description: "Research expert",
      tags: ["research"],
      version: "0.0.0",
      scope: "workspace",
      workspace: "/tmp/expertmesh",
      hooks: {
        beforeSessionCreate: () => {
          events.push("host");
        },
      },
      plugins: [plugin],
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

    expect(events).toEqual(["host", "plugin"]);
  });
});
