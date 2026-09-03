import type { StateMigrationStep } from "../../../state-migration.ts";
import { BundleInstallationsCatalogV4Schema } from "../schemas/v4.ts";
import { BundleInstallationsCatalogV5Schema } from "../schemas/v5.ts";

export const bundleInstallationsV4ToV5Step = {
  fromVersion: 4,
  toVersion: 5,
  inputSchema: BundleInstallationsCatalogV4Schema,
  migrate(value) {
    const current = BundleInstallationsCatalogV4Schema.parse(value);
    return BundleInstallationsCatalogV5Schema.parse({
      schemaVersion: "pragma.bundle-installations/v5",
      installations: current.installations.map((installation) => ({
        ...installation,
        schemaVersion: "pragma.bundle-installation/v5",
      })),
    });
  },
} satisfies StateMigrationStep;
