import type {
  PragmaBundleManifest,
  PragmaBundleV1Manifest,
} from "../../ast/pragma-bundle.schema.ts";

export type PragmaBundleSchemaVersion = `pragma.bundle/v${number}`;

export interface PragmaBundleManifestMigrationResult {
  readonly sourceManifest: unknown;
  readonly manifest: unknown;
}

export interface PragmaBundleManifestMigrationStep {
  readonly fromVersion: PragmaBundleSchemaVersion;
  readonly toVersion: PragmaBundleSchemaVersion;
  readonly migrate: (input: unknown) => PragmaBundleManifestMigrationResult;
}

export interface MigratedPragmaBundleManifest {
  readonly sourceManifest: PragmaBundleManifest | PragmaBundleV1Manifest;
  readonly manifest: PragmaBundleManifest;
}
