import { definePluginEntry } from "../../../expert-agent-plugin.ts";

export const otherDocumentPlugin = definePluginEntry({
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
});
