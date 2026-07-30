import type { StateMigrationStep } from "../../../state-migration.ts";
import { BundleInstallationsCatalogV1Schema } from "../schemas/v1.ts";
import { BundleInstallationsCatalogV2Schema } from "../schemas/v2.ts";

export const bundleInstallationsV1ToV2Step = {
  fromVersion: 1,
  toVersion: 2,
  inputSchema: BundleInstallationsCatalogV1Schema,
  migrate(value) {
    const current = BundleInstallationsCatalogV1Schema.parse(value);
    return BundleInstallationsCatalogV2Schema.parse({
      schemaVersion: "pragma.bundle-installations/v2",
      installations: current.installations.map((installation) => ({
        ...installation,
        schemaVersion: "pragma.bundle-installation/v2",
        conflictResolutions: [],
        resourceMappings: [],
      })),
    });
  },
} satisfies StateMigrationStep;
