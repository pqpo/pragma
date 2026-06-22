import { definePluginEntry } from "../../../expert-agent-plugin.ts";

export const events: string[] = [];

export const extensibilityPlugin = definePluginEntry({
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
