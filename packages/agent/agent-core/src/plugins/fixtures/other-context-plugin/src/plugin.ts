import { definePluginEntry } from "@expertmesh/agent-core";

export const otherContextPlugin = definePluginEntry({
  setup: () => ({
    context: [
      {
        id: "plugin.md",
        content: "Other plugin content",
        metadata: {
          description: "Other plugin context",
          trigger: "model_decision",
        },
      },
    ],
  }),
});

export default otherContextPlugin;
