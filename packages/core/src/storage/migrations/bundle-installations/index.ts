import { defineStateMigrationChain } from "../../state-migration.ts";
import {
  BundleInstallationsCatalogV3Schema,
  type BundleInstallationsCatalogV3,
} from "./schemas/v3.ts";
import { bundleInstallationsV1ToV2Step } from "./steps/v1-to-v2.ts";
import { bundleInstallationsV2ToV3Step } from "./steps/v2-to-v3.ts";

export { BundleInstallationsCatalogV1Schema } from "./schemas/v1.ts";
export { BundleInstallationsCatalogV2Schema } from "./schemas/v2.ts";
export { BundleInstallationsCatalogV3Schema } from "./schemas/v3.ts";
export { bundleInstallationsV1ToV2Step } from "./steps/v1-to-v2.ts";
export { bundleInstallationsV2ToV3Step } from "./steps/v2-to-v3.ts";

export const bundleInstallationsMigrationChain =
  defineStateMigrationChain<BundleInstallationsCatalogV3>({
    family: "pragma.bundle-installations",
    currentVersion: 3,
    currentSchema: BundleInstallationsCatalogV3Schema,
    steps: [bundleInstallationsV1ToV2Step, bundleInstallationsV2ToV3Step],
  });
