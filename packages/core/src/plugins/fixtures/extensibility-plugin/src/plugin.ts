import { definePluginEntry } from "@pragma/core";

export const events: string[] = [];

export const extensibilityPlugin = definePluginEntry({
  setup: () => ({
    mcp: {
      mcpServers: {
        pluginMcp: {
          name: "Plugin MCP",
          transport: "stdio",
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

export default extensibilityPlugin;
