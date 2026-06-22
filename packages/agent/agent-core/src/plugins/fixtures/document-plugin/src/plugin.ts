import { definePluginEntry } from "../../../expert-agent-plugin.ts";

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
