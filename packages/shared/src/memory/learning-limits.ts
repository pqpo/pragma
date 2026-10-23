/** Shared bounds for source snapshots, read-only planning and revision submission. */
export const MEMORY_LEARNING_SOURCE_BODY_CHARACTERS = 410_000;
export const MEMORY_LEARNING_INSPECTION_PAGE_CHARACTERS = 32_768;
// A complete maximum-sized source remains readable even when JSON escaping expands it 6x.
export const MEMORY_LEARNING_MAX_INSPECTIONS = 128;
export const MEMORY_LEARNING_MAX_INSPECTION_BYTES = 8 * 1_024 * 1_024;
export const MEMORY_LEARNING_MAX_PROMPT_BYTES = MEMORY_LEARNING_MAX_INSPECTION_BYTES;
