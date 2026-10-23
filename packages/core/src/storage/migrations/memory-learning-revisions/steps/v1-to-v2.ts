import { MemoryLearningStateV1Schema } from "../schemas/v1.ts";
export function migrateMemoryLearningStateV1ToV2(value: unknown): unknown {
  const state = MemoryLearningStateV1Schema.parse(value);
  return {
    ...state,
    schemaVersion: "pragma.memory-learning-revisions/v2",
    knowledge: state.knowledge.map((item) => ({ ...item, topicKey: `legacy:${item.storeId}` })),
  };
}
