import type { StateMigrationStep } from "../../../state-migration.ts";
import { BundleInstallationsCatalogV7Schema } from "../schemas/v7.ts";
import { BundleInstallationsCatalogV8Schema } from "../schemas/v8.ts";

export const bundleInstallationsV7ToV8Step = {
  fromVersion: 7,
  toVersion: 8,
  inputSchema: BundleInstallationsCatalogV7Schema,
  migrate(value) {
    const current = BundleInstallationsCatalogV7Schema.parse(value);
    return BundleInstallationsCatalogV8Schema.parse({
      schemaVersion: "pragma.bundle-installations/v8",
      installations: current.installations.map((installation) => ({
        ...installation,
        schemaVersion: "pragma.bundle-installation/v8",
      })),
    });
  },
} satisfies StateMigrationStep;
