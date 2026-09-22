import {
  PragmaBundleManifestSchema,
  PragmaBundleV2ManifestSchema,
} from "../../../ast/pragma-bundle.schema.ts";
import type { PragmaBundleManifestMigrationStep } from "../types.ts";

export const pragmaBundleV2ToV3Step = {
  fromVersion: "pragma.bundle/v2",
  toVersion: "pragma.bundle/v3",
  migrate(input) {
    const sourceManifest = PragmaBundleV2ManifestSchema.parse(input);
    return {
      sourceManifest,
      manifest: PragmaBundleManifestSchema.parse({
        ...sourceManifest,
        schemaVersion: "pragma.bundle/v3",
      }),
    };
  },
} satisfies PragmaBundleManifestMigrationStep;
