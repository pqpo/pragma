import { createInMemoryContextStore, definePluginEntry } from "@expertmesh/core";

export const otherContextPlugin = definePluginEntry({
  setup: ({ contextSystem }) => {
    contextSystem.register({
      namespace: "plugin.other-context",
      store: createInMemoryContextStore({
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

    return {};
  },
});

export default otherContextPlugin;
