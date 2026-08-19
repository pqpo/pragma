import { defineStateMigrationChain } from "../../state-migration.ts";
import {
  BundleInstallationsCatalogV4Schema,
  type BundleInstallationsCatalogV4,
} from "./schemas/v4.ts";
import { bundleInstallationsV1ToV2Step } from "./steps/v1-to-v2.ts";
import { bundleInstallationsV2ToV3Step } from "./steps/v2-to-v3.ts";
import { bundleInstallationsV3ToV4Step } from "./steps/v3-to-v4.ts";

export { BundleInstallationsCatalogV1Schema } from "./schemas/v1.ts";
export { BundleInstallationsCatalogV2Schema } from "./schemas/v2.ts";
export { BundleInstallationsCatalogV3Schema } from "./schemas/v3.ts";
export { BundleInstallationsCatalogV4Schema } from "./schemas/v4.ts";
export { bundleInstallationsV1ToV2Step } from "./steps/v1-to-v2.ts";
export { bundleInstallationsV2ToV3Step } from "./steps/v2-to-v3.ts";
export { bundleInstallationsV3ToV4Step } from "./steps/v3-to-v4.ts";

export const bundleInstallationsMigrationChain =
  defineStateMigrationChain<BundleInstallationsCatalogV4>({
    family: "pragma.bundle-installations",
    currentVersion: 4,
    currentSchema: BundleInstallationsCatalogV4Schema,
    steps: [
      bundleInstallationsV1ToV2Step,
      bundleInstallationsV2ToV3Step,
      bundleInstallationsV3ToV4Step,
    ],
  });
