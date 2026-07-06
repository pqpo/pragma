import { definePluginEntry } from "@pragma/core";

import { MEMORY_CONTEXT_NAMESPACE } from "./constants.ts";
import { ExpertMemoryManager } from "./manager.ts";
import { createExpertMemoryStore } from "./store.ts";

export {
  MemoryPluginConfigSchema,
  MemoryRunEvidenceSchema,
  MemorySessionEvidenceSchema,
  parseMemoryPluginConfig,
} from "./schema.ts";

export default definePluginEntry({
  setup: (context) => {
    const store = createExpertMemoryStore(context);
    const manager = new ExpertMemoryManager(context);
    context.contextSystem.register({
      namespace: MEMORY_CONTEXT_NAMESPACE,
      store,
    });

    return {
      hooks: {
        onStreamEvent: async (streamContext) => {
          await manager.recordStreamEvent(streamContext);
        },
        afterTaskSubmit: async (taskContext) => {
          await manager.recordTask(taskContext);
        },
        afterSessionDestroy: async (sessionContext) => {
          await manager.finalizeSession(sessionContext);
        },
      },
    };
  },
});
