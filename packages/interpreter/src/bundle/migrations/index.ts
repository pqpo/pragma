import {
  PRAGMA_BUNDLE_WRITE_VERSION,
  PragmaBundleManifestSchema,
  type PragmaBundleManifest,
  type PragmaBundleV1Manifest,
} from "../../ast/pragma-bundle.schema.ts";
import { pragmaBundleV1ToV2Step } from "./steps/v1-to-v2.ts";
import type {
  MigratedPragmaBundleManifest,
  PragmaBundleManifestMigrationStep,
  PragmaBundleSchemaVersion,
} from "./types.ts";

const migrationSteps = [
  pragmaBundleV1ToV2Step,
] as const satisfies readonly PragmaBundleManifestMigrationStep[];
const migrationStepsBySource = indexMigrationSteps(migrationSteps);

export function migratePragmaBundleManifestToCurrent(
  input: unknown,
  sourceVersion: PragmaBundleSchemaVersion,
): MigratedPragmaBundleManifest {
  if (sourceVersion === PRAGMA_BUNDLE_WRITE_VERSION) {
    const manifest = PragmaBundleManifestSchema.parse(input);
    return { sourceManifest: manifest, manifest };
  }

  let version = sourceVersion;
  let value = input;
  let sourceManifest: unknown;
  const visited = new Set<PragmaBundleSchemaVersion>();
  while (version !== PRAGMA_BUNDLE_WRITE_VERSION) {
    if (visited.has(version)) {
      throw new Error(`Pragma Bundle manifest migration contains a cycle at ${version}.`);
    }
    visited.add(version);
    const step = migrationStepsBySource.get(version);
    if (step === undefined) {
      throw new Error(`Pragma Bundle manifest ${version} has no migration to the current version.`);
    }
    const result = step.migrate(value);
    sourceManifest ??= result.sourceManifest;
    value = result.manifest;
    version = step.toVersion;
  }

  return {
    sourceManifest: (sourceManifest ?? value) as PragmaBundleManifest | PragmaBundleV1Manifest,
    manifest: PragmaBundleManifestSchema.parse(value),
  };
}

function indexMigrationSteps(
  steps: readonly PragmaBundleManifestMigrationStep[],
): ReadonlyMap<PragmaBundleSchemaVersion, PragmaBundleManifestMigrationStep> {
  const indexed = new Map<PragmaBundleSchemaVersion, PragmaBundleManifestMigrationStep>();
  for (const step of steps) {
    const from = bundleVersionNumber(step.fromVersion);
    const to = bundleVersionNumber(step.toVersion);
    if (to !== from + 1) {
      throw new Error(
        `Pragma Bundle manifest migrations must be adjacent: ${step.fromVersion} -> ${step.toVersion}.`,
      );
    }
    if (indexed.has(step.fromVersion)) {
      throw new Error(`Duplicate Pragma Bundle manifest migration from ${step.fromVersion}.`);
    }
    indexed.set(step.fromVersion, step);
  }
  return indexed;
}

function bundleVersionNumber(version: PragmaBundleSchemaVersion): number {
  return Number.parseInt(version.slice("pragma.bundle/v".length), 10);
}
