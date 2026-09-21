import type { StateMigrationStep } from "../../../state-migration.ts";
import { BundleInstallationsCatalogV6Schema } from "../schemas/v6.ts";
import { BundleInstallationsCatalogV7Schema } from "../schemas/v7.ts";

export const bundleInstallationsV6ToV7Step = {
  fromVersion: 6,
  toVersion: 7,
  inputSchema: BundleInstallationsCatalogV6Schema,
  migrate(value) {
    const current = BundleInstallationsCatalogV6Schema.parse(value);
    return BundleInstallationsCatalogV7Schema.parse({
      schemaVersion: "pragma.bundle-installations/v7",
      installations: current.installations.map((installation) => ({
        ...installation,
        schemaVersion: "pragma.bundle-installation/v7",
        assetConflictResolutions: [],
      })),
    });
  },
} satisfies StateMigrationStep;
