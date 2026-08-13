import { MissionExecutorRefSchema } from "@pragma/shared";

export const MEMORY_CURATOR_ID = "0000000000mem0ry";
export const MEMORY_CURATOR_REF = MissionExecutorRefSchema.parse(`expert:${MEMORY_CURATOR_ID}`);
export const MEMORY_CURATOR_PROMPT_VERSION = "pragma.memory-curator/v3";
export const SEMANTIC_MEMORY_CURATOR_PROMPT_VERSION = "pragma.memory-curator.semantic/v3";
