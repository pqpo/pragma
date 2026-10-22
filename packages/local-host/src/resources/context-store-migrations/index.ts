export { ContextStoreRevisionJournalV1Schema, ContextStoreV4Schema } from "./schemas/v4.ts";
export {
  migrateContextStoreRevisionJournalV1ToV2,
  migrateContextStoreV4ToV5,
} from "./steps/v4-to-v5.ts";
import { migrateContextStoreV4ToV5 } from "./steps/v4-to-v5.ts";
export const CONTEXT_STORE_MIGRATIONS = Object.freeze([
  Object.freeze({
    from: "pragma.context-store/v4",
    to: "pragma.context-store/v5",
    migrate: migrateContextStoreV4ToV5,
  }),
]);
