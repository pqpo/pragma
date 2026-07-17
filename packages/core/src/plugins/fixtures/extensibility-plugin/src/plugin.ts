import { definePluginEntry, readExpertAgentPluginManifest } from "@pragma/core";

export const events: string[] = [];

export const extensibilityPlugin = definePluginEntry({
  manifest: readExpertAgentPluginManifest(new URL("../plugin.json", import.meta.url)),
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
      default: {
        model: { providerId: "plugin-provider", modelId: "plugin-model" },
      },
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
