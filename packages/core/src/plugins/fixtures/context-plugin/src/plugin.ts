import {
  createInMemoryContextStore,
  definePluginEntry,
  readExpertAgentPluginManifest,
} from "@pragma/core";

export const contextPlugin = definePluginEntry({
  manifest: readExpertAgentPluginManifest(new URL("../plugin.json", import.meta.url)),
  setup: ({ contextSystem }) => {
    contextSystem.register({
      namespace: "plugin.context",
      store: createInMemoryContextStore({
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
    contextSystem.register({
      namespace: "plugin.context.extra",
      store: createInMemoryContextStore({
        context: [
          {
            id: "extra.md",
            content: "Extra plugin content",
            metadata: {
              description: "Extra plugin context",
              trigger: "model_decision",
            },
          },
        ],
      }),
    });

    return {};
  },
});

export default contextPlugin;
