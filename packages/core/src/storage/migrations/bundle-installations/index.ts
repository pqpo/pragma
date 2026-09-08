import { defineStateMigrationChain } from "../../state-migration.ts";
import {
  BundleInstallationsCatalogV5Schema,
  type BundleInstallationsCatalogV5,
} from "./schemas/v5.ts";
import { bundleInstallationsV1ToV2Step } from "./steps/v1-to-v2.ts";
import { bundleInstallationsV2ToV3Step } from "./steps/v2-to-v3.ts";
import { bundleInstallationsV3ToV4Step } from "./steps/v3-to-v4.ts";
import { bundleInstallationsV4ToV5Step } from "./steps/v4-to-v5.ts";

export { BundleInstallationsCatalogV1Schema } from "./schemas/v1.ts";
export { BundleInstallationsCatalogV2Schema } from "./schemas/v2.ts";
export { BundleInstallationsCatalogV3Schema } from "./schemas/v3.ts";
export { BundleInstallationsCatalogV4Schema } from "./schemas/v4.ts";
export { BundleInstallationsCatalogV5Schema } from "./schemas/v5.ts";
export { bundleInstallationsV1ToV2Step } from "./steps/v1-to-v2.ts";
export { bundleInstallationsV2ToV3Step } from "./steps/v2-to-v3.ts";
export { bundleInstallationsV3ToV4Step } from "./steps/v3-to-v4.ts";
export { bundleInstallationsV4ToV5Step } from "./steps/v4-to-v5.ts";

export const bundleInstallationsMigrationChain =
  defineStateMigrationChain<BundleInstallationsCatalogV5>({
    family: "pragma.bundle-installations",
    currentVersion: 5,
    currentSchema: BundleInstallationsCatalogV5Schema,
    steps: [
      bundleInstallationsV1ToV2Step,
      bundleInstallationsV2ToV3Step,
      bundleInstallationsV3ToV4Step,
      bundleInstallationsV4ToV5Step,
    ],
  });
