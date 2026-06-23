import { definePluginEntry } from "@expertmesh/agent-core";

export const contextPlugin = definePluginEntry({
  setup: () => ({
    context: [
      {
        id: "plugin.md",
        content: "Plugin content",
        metadata: {
          description: "Plugin context",
          trigger: "model_decision",
        },
      },
    ],
  }),
});

export default contextPlugin;
