import { MemoryAttentionStateV1Schema } from "../schemas/v1.ts";
export const attentionV1ToV2Step = {
  fromVersion: 1,
  toVersion: 2,
  sourceVersion: "pragma.memory-attention/v1",
  migrate(value: unknown) {
    const state = MemoryAttentionStateV1Schema.parse(value);
    return {
      ...state,
      schemaVersion: "pragma.memory-attention/v2",
      active: state.active.map((entry) => ({
        ...entry,
        decisionMode: "provider",
        pinned: false,
        selectedPaths: [],
      })),
    };
  },
};
