import { createEpisodicMemoryModule } from "../../src/episodic/module.ts";
import { createSemanticMemoryModule } from "../../src/semantic/module.ts";
import { createConversationMemoryExtractionCoordinator } from "../../src/pipeline/conversation-extraction.ts";
import { MEMORY_CURATOR_REF } from "../../src/curator.ts";

const pragmaHome = process.argv[2]!;
const extractor = {
  extract: async (): Promise<never> => {
    throw new Error("unexpected standalone extraction");
  },
};
const episodic = await createEpisodicMemoryModule({ pragmaHome, extractor });
const semantic = await createSemanticMemoryModule({ pragmaHome, extractor });
const coordinator = createConversationMemoryExtractionCoordinator({
  pragmaHome,
  episodic,
  semantic,
});
coordinator.setExtractor({
  async extract(batch) {
    batch.episodic?.options?.onAdmission?.();
    batch.semantic?.options?.onAdmission?.();
    const released = new Promise<void>((resolve) => {
      process.once("message", () => resolve());
      process.once("disconnect", () => resolve());
    });
    process.send?.("admitted");
    await released;
    const provenance = {
      curatorRef: MEMORY_CURATOR_REF,
      promptVersion: "test/v1",
      profileRevision: 0,
      runtimeId: "test",
      providerId: "test",
      modelId: "test",
      extractedAt: new Date().toISOString(),
    };
    await batch.episodic?.settle({ output: { retain: false, reason: "low-value" }, provenance });
    await batch.semantic?.settle({
      output: { retain: false, reason: "no-stable-fact" },
      provenance,
    });
  },
});
try {
  await coordinator.runOnce();
} finally {
  episodic.close();
  semantic.close();
  process.disconnect?.();
}
