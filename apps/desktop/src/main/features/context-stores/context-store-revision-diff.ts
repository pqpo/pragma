import {
  GetContextStoreRevisionDiffSchema,
  ContextStoreRevisionDiffSchema,
  type ContextStoreRevisionDiff,
} from "../../../shared/contracts/index.ts";
import type { ContextStoreStore } from "./context-store-store.ts";

export async function getContextStoreRevisionDiff(
  store: ContextStoreStore,
  input: unknown,
): Promise<ContextStoreRevisionDiff> {
  const { storeId, revision } = GetContextStoreRevisionDiffSchema.parse(input);
  // getSnapshot verifies that each record's parent is exactly revision - 1.
  const [before, after] = await Promise.all([
    store.getSnapshot(storeId, revision - 1),
    store.getSnapshot(storeId, revision),
  ]);
  return ContextStoreRevisionDiffSchema.parse({ before, after });
}
