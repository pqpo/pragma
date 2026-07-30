import { defineStateMigrationChain } from "../../state-migration.ts";
import {
  BundleInstallationsCatalogV2Schema,
  type BundleInstallationsCatalogV2,
} from "./schemas/v2.ts";
import { bundleInstallationsV1ToV2Step } from "./steps/v1-to-v2.ts";

export { BundleInstallationsCatalogV1Schema } from "./schemas/v1.ts";
export { BundleInstallationsCatalogV2Schema } from "./schemas/v2.ts";
export { bundleInstallationsV1ToV2Step } from "./steps/v1-to-v2.ts";

export const bundleInstallationsMigrationChain =
  defineStateMigrationChain<BundleInstallationsCatalogV2>({
    family: "pragma.bundle-installations",
    currentVersion: 2,
    currentSchema: BundleInstallationsCatalogV2Schema,
    steps: [bundleInstallationsV1ToV2Step],
  });
