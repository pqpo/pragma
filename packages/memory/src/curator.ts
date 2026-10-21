import { MissionExecutorRefSchema } from "@pragma/shared";

export const MEMORY_CURATOR_ID = "0000000000mem0ry";
export const MEMORY_CURATOR_REF = MissionExecutorRefSchema.parse(`expert:${MEMORY_CURATOR_ID}`);
export const MEMORY_CURATOR_PROMPT_VERSION = "pragma.memory-curator/v11";
export const SEMANTIC_MEMORY_CURATOR_PROMPT_VERSION = "pragma.memory-curator.semantic/v11";

export function memoryCuratorPromptVersion(
  contract: 1 | 2,
  module: "semantic" | "episodic" | "conversation",
): string {
  if (contract === 1)
    return module === "semantic" ? "pragma.memory-curator.semantic/v8" : "pragma.memory-curator/v8";
  return module === "semantic"
    ? SEMANTIC_MEMORY_CURATOR_PROMPT_VERSION
    : MEMORY_CURATOR_PROMPT_VERSION;
}
