import type { StateMigrationStep } from "../../../state-migration.ts";
import { BundleInstallationsCatalogV5Schema } from "../schemas/v5.ts";
import { BundleInstallationsCatalogV6Schema } from "../schemas/v6.ts";

export const bundleInstallationsV5ToV6Step = {
  fromVersion: 5,
  toVersion: 6,
  inputSchema: BundleInstallationsCatalogV5Schema,
  migrate(value) {
    const source = BundleInstallationsCatalogV5Schema.parse(value);
    return BundleInstallationsCatalogV6Schema.parse({
      schemaVersion: "pragma.bundle-installations/v6",
      installations: source.installations.map((installation) => ({
        ...installation,
        schemaVersion: "pragma.bundle-installation/v6",
        knowledgeBaseUpdate:
          installation.knowledgeBaseUpdate === undefined
            ? undefined
            : {
                sourceRef: installation.knowledgeBaseUpdate.sourceRef,
                targetRef: installation.knowledgeBaseUpdate.targetRef,
                storeId: installation.knowledgeBaseUpdate.storeId,
                baseSnapshotHash: installation.knowledgeBaseUpdate.baseSnapshotHash,
                importedSnapshotHash: installation.knowledgeBaseUpdate.importedSnapshotHash,
                phase: installation.knowledgeBaseUpdate.phase,
              },
      })),
    });
  },
} satisfies StateMigrationStep;
