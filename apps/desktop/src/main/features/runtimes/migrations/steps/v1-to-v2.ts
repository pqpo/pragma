import type { StateMigrationStep } from "@pragma/core";

import { RuntimeEnvironmentCatalogSchema } from "../../../../../shared/contracts/index.ts";
import { RuntimeEnvironmentCatalogV1Schema } from "../schemas/v1.ts";

export const runtimeEnvironmentCatalogV1ToV2Step = {
  fromVersion: 1,
  toVersion: 2,
  inputSchema: RuntimeEnvironmentCatalogV1Schema,
  migrate(value) {
    const current = RuntimeEnvironmentCatalogV1Schema.parse(value);
    return RuntimeEnvironmentCatalogSchema.parse({
      schemaVersion: "pragma.runtime-environment-catalog/v2",
      entries: current.entries,
    });
  },
} satisfies StateMigrationStep;
