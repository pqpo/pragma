import { afterAll } from "vitest";
import { createPragma as createCorePragma, type CreatePragmaOptions } from "@pragma/core";
import { createSqliteExecutionStore } from "../src/execution/sqlite-execution-store.ts";
const stores = new Set<ReturnType<typeof createSqliteExecutionStore>>();
export function createTestExecutionStore(
  options: Parameters<typeof createSqliteExecutionStore>[0] = {},
) {
  const store = createSqliteExecutionStore(options);
  stores.add(store);
  return store;
}
export function createPragma(
  options: Omit<CreatePragmaOptions, "executionStore"> &
    Partial<Pick<CreatePragmaOptions, "executionStore">>,
) {
  return createCorePragma({
    ...options,
    executionStore:
      options.executionStore ?? createTestExecutionStore({ pragmaHome: options.pragmaHome }),
  });
}
afterAll(async () => {
  await Promise.allSettled([...stores].map((store) => store.close()));
  stores.clear();
});
