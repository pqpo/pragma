import {
  PragmaBundleManifestSchema,
  PragmaBundleV1ManifestSchema,
} from "../../../ast/pragma-bundle.schema.ts";
import type { PragmaBundleManifestMigrationStep } from "../types.ts";

export const pragmaBundleV1ToV2Step = {
  fromVersion: "pragma.bundle/v1",
  toVersion: "pragma.bundle/v2",
  migrate(input) {
    const sourceManifest = PragmaBundleV1ManifestSchema.parse(input);
    return {
      sourceManifest,
      manifest: PragmaBundleManifestSchema.parse({
        ...sourceManifest,
        schemaVersion: "pragma.bundle/v2",
      }),
    };
  },
} satisfies PragmaBundleManifestMigrationStep;
