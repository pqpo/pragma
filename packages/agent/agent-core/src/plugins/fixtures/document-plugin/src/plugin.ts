import { definePluginEntry } from "@expertmesh/agent-core";

export const documentPlugin = definePluginEntry({
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
});

export default documentPlugin;
