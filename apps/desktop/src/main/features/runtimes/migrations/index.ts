import { defineStateMigrationChain } from "@pragma/core";

import {
  RuntimeEnvironmentCatalogSchema,
  type RuntimeEnvironmentCatalog,
} from "../../../../shared/contracts/index.ts";
import { runtimeEnvironmentCatalogV1ToV2Step } from "./steps/v1-to-v2.ts";

export { RuntimeEnvironmentCatalogV1Schema } from "./schemas/v1.ts";
export { runtimeEnvironmentCatalogV1ToV2Step } from "./steps/v1-to-v2.ts";

export const runtimeEnvironmentCatalogMigrationChain =
  defineStateMigrationChain<RuntimeEnvironmentCatalog>({
    family: "pragma.runtime-environment-catalog",
    currentVersion: 2,
    currentSchema: RuntimeEnvironmentCatalogSchema,
    steps: [runtimeEnvironmentCatalogV1ToV2Step],
  });
