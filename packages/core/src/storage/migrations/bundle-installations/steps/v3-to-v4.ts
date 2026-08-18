import type { StateMigrationStep } from "../../../state-migration.ts";
import { BundleInstallationsCatalogV3Schema } from "../schemas/v3.ts";
import { BundleInstallationsCatalogV4Schema } from "../schemas/v4.ts";

export const bundleInstallationsV3ToV4Step = {
  fromVersion: 3,
  toVersion: 4,
  inputSchema: BundleInstallationsCatalogV3Schema,
  migrate(value) {
    const current = BundleInstallationsCatalogV3Schema.parse(value);
    return BundleInstallationsCatalogV4Schema.parse({
      schemaVersion: "pragma.bundle-installations/v4",
      installations: current.installations.map((installation) => ({
        ...installation,
        schemaVersion: "pragma.bundle-installation/v4",
        readiness: installation.pending.map((dependency) => ({
          id: dependency.id,
          kind: dependency.kind,
          resourceRef: dependency.resourceRef,
          name: dependency.name,
          status: "action_required",
          code: "legacy_pending",
          action: "restore_or_replace",
          message: dependency.message,
          ...(dependency.capabilityKind === undefined
            ? {}
            : { capabilityKind: dependency.capabilityKind }),
        })),
        pending: installation.pending.map((dependency) => ({
          ...dependency,
          status: "action_required",
          code: "legacy_pending",
          action: "restore_or_replace",
        })),
      })),
    });
  },
} satisfies StateMigrationStep;
