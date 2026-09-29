import { attentionV1ToV2Step } from "./steps/v1-to-v2.ts";
export const ATTENTION_STORAGE_MIGRATIONS = Object.freeze([attentionV1ToV2Step] as const);
