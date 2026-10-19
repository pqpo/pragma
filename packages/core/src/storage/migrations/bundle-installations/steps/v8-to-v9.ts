import type { StateMigrationStep } from "../../../state-migration.ts";
import { BundleInstallationsCatalogV8Schema } from "../schemas/v8.ts";
import { BundleInstallationsCatalogV9Schema } from "../schemas/v9.ts";
export const bundleInstallationsV8ToV9Step = {
  fromVersion: 8,
  toVersion: 9,
  inputSchema: BundleInstallationsCatalogV8Schema,
  migrate(value) {
    const source = BundleInstallationsCatalogV8Schema.parse(value);
    return BundleInstallationsCatalogV9Schema.parse({
      schemaVersion: "pragma.bundle-installations/v9",
      installations: source.installations.map((record) => ({
        ...record,
        schemaVersion: "pragma.bundle-installation/v9",
      })),
    });
  },
} satisfies StateMigrationStep;
