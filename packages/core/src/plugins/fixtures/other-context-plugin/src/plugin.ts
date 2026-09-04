import {
  createInMemoryContextStore,
  definePluginEntry,
  readExpertAgentPluginManifest,
} from "../../../../index.ts";

export const otherContextPlugin = definePluginEntry({
  manifest: readExpertAgentPluginManifest(new URL("../plugin.json", import.meta.url)),
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
