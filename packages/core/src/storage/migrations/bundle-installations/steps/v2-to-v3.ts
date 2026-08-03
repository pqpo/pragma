import type { StateMigrationStep } from "../../../state-migration.ts";
import { BundleInstallationsCatalogV2Schema } from "../schemas/v2.ts";
import { BundleInstallationsCatalogV3Schema } from "../schemas/v3.ts";

export const bundleInstallationsV2ToV3Step = {
  fromVersion: 2,
  toVersion: 3,
  inputSchema: BundleInstallationsCatalogV2Schema,
  migrate(value) {
    const current = BundleInstallationsCatalogV2Schema.parse(value);
    return BundleInstallationsCatalogV3Schema.parse({
      schemaVersion: "pragma.bundle-installations/v3",
      installations: current.installations.map((installation) => ({
        ...installation,
        schemaVersion: "pragma.bundle-installation/v3",
        bundleVersion: "pragma.desktop-bundle/v1",
      })),
    });
  },
} satisfies StateMigrationStep;
